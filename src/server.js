'use strict';

/**
 * Server entrypoint. Loads and validates configuration, starts listening
 * immediately (health endpoint reports DB state honestly), connects to
 * MongoDB, and installs graceful shutdown handling.
 */
const mongoose = require('mongoose');
const { loadConfig } = require('./config/env');
const logger = require('./utils/logger');
const { connectDb, disconnectDb } = require('./infrastructure/database/connect');
const { createApp } = require('./app');
const { analyzeImage } = require('./infrastructure/gemini/client');
const { startAnalysisWorker } = require('./modules/image-analysis/analysis.worker');
const matchingService = require('./modules/matching/match.service');
const { createTransportFromConfig } = require('./modules/notifications/transport');
const { startNotificationsWorker } = require('./modules/notifications/notification.worker');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  logger.setLevel(config.logLevel);

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info('Reclaim API listening', { port: config.port, env: config.nodeEnv });
  });

  try {
    await connectDb(config.mongoUri);
    logger.info('Database connection established');
  } catch (err) {
    logger.error('Database connection failed', { reason: err && err.message });
    server.close();
    process.exit(1);
  }

  let shuttingDown = false;

  // The analyzer is the single place provider identity/credentials are used.
  const analyzer = ({ imageBase64 }) =>
    analyzeImage({
      imageBase64,
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
      timeoutMs: config.aiJobTimeoutMs,
    });
  const analysisWorker = startAnalysisWorker({ analyzer, config, logger });
  logger.info('Analysis worker started', { intervalMs: config.analysisWorkerIntervalMs });

  // Phase 4: notification delivery worker. The SMTP transport exists only
  // when email is enabled; otherwise the worker stays a no-op and
  // notification records are honestly marked `disabled` at enqueue time.
  const mailTransport = createTransportFromConfig(config.email);
  const notificationsWorker = startNotificationsWorker({
    transport: mailTransport,
    config,
    logger,
    onDelivered: (matchId) => matchingService.markSuggestionsDelivered(matchId),
  });
  logger.info('Notifications worker started', { emailEnabled: Boolean(mailTransport) });

  mongoose.connection.on('error', (err) => {
    logger.error('Database connection error', { reason: err && err.message });
  });
  mongoose.connection.on('disconnected', () => {
    if (!shuttingDown) logger.warn('Database disconnected');
  });

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    // Force exit if graceful close stalls; do not wait on hung clients.
    setTimeout(() => process.exit(1), 5000).unref();
    analysisWorker.stop();
    notificationsWorker.stop();
    server.close();
    try {
      await disconnectDb();
    } catch (err) {
      logger.error('Error while disconnecting database', { reason: err && err.message });
    }
    process.exit(0);
  };
  ['SIGTERM', 'SIGINT'].forEach((signal) => process.on(signal, () => shutdown(signal)));
}

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

main().catch((err) => {
  logger.error('Fatal startup error', {
    reason: err && err.message ? err.message : String(err),
  });
  process.exit(1);
});

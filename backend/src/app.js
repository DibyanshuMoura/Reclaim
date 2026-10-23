'use strict';

/**
 * Express application factory. Stateless so tests can create fresh apps
 * against fresh state (including per-app rate-limit counters).
 */
const express = require('express');
const cors = require('cors');
const { loadConfig } = require('./config/env');
const { createRateLimiters } = require('./middleware/rate-limiter');
const { securityHeaders } = require('./middleware/security-headers');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const { isDbConnected } = require('./infrastructure/database/connect');
const { createReportRouter } = require('./modules/reports/report.routes');
const { createMatchRouter } = require('./modules/matching/match.routes');
const { createWebRouter } = require('./modules/web/web.routes');

// Text-only bodies stay strictly bounded; photo uploads arrive as multipart
// with their own byte limit (config.maxImageBytes) enforced by multer.
const JSON_BODY_LIMIT = '32kb';

function createApp() {
  const config = loadConfig();
  const { apiLimiter, reportCreateLimiter } = createRateLimiters(config);
  const corsOptions = config.corsOrigins
    ? { origin: config.corsOrigins, credentials: false }
    : { credentials: false };

  const app = express();
  // Map a chain of trusted proxies back to the real client IP; unset config
  // means the process is exposed directly and socket addresses are truth.
  if (config.trustProxy !== null) {
    app.set('trust proxy', config.trustProxy);
  }
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(cors(corsOptions));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Health is intentionally mounted before the API limiter so monitoring
  // is never throttled.
  app.get('/api/v1/health', (_req, res) => {
    const db = isDbConnected();
    res.status(db ? 200 : 503).json({
      status: db ? 'ok' : 'degraded',
      db: db ? 'connected' : 'disconnected',
    });
  });

  // Web frontend with clean URLs (never overlaps /api/v1).
  app.use(createWebRouter());

  app.use('/api/v1', apiLimiter, createReportRouter({ reportCreateLimiter, config }), createMatchRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, JSON_BODY_LIMIT };

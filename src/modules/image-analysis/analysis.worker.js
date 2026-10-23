'use strict';

/**
 * In-process analysis worker (AGENT.md §9).
 *
 * - Claims pending reports atomically (findOneAndUpdate with state guard),
 *   oldest first, one attempt per claim.
 * - Drains a bounded batch per tick so a flood of reports cannot starve the
 *   event loop.
 * - Recovers stale `processing` leases (a crashed worker's job) and stale
 *   `retryable_failed` entries (in-process retry timers die with the
 *   process) — bounded by the configured attempt budget.
 * - Retries transient failures with exponential backoff + jitter, capped.
 * - Single-instance MVP: running multiple workers in one DB risks duplicate
 *   analysis because claim requires the (unenforced) single-instance setup
 *   only for scheduling; claims themselves are atomic, so duplicate work is
 *   bounded, not impossible. Documented in the README.
 */
const Report = require('../reports/report.model');
const { AnalysisStatus } = require('../reports/report.statuses');
const TemporaryImage = require('../../infrastructure/temporary-images/temporary-image.model');
const analysisService = require('./analysis.service');
const matchingService = require('../matching/match.service');
const logger = require('../../utils/logger');

const MAX_DRAIN_PER_TICK = 25;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;

/** Exponential backoff with 0–1s jitter. attempts starts at 1. */
function backoffDelayMs(attempts, jitter = Math.random()) {
  const base = BACKOFF_BASE_MS * 2 ** Math.max(0, (attempts || 1) - 1);
  return Math.min(BACKOFF_CAP_MS, base + Math.floor(jitter * 1000));
}

async function claimNextPendingReport() {
  return Report.findOneAndUpdate(
    { analysisStatus: AnalysisStatus.PENDING },
    {
      $set: { analysisStatus: AnalysisStatus.PROCESSING, analysisLockedAt: new Date() },
      $inc: { analysisAttempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  ).select('+analysisAttempts +analysisLockedAt +analysisRetryAt +analysisError');
}

/** Requeue one retryable report whose scheduled time has arrived. */
async function requeueArrivedRetry(now = new Date()) {
  return Report.updateOne(
    {
      analysisStatus: AnalysisStatus.RETRYABLE_FAILED,
      analysisRetryAt: { $ne: null, $lte: now },
    },
    {
      $set: { analysisStatus: AnalysisStatus.PENDING },
      $unset: { analysisRetryAt: 1 },
    }
  );
}

/**
 * Recovers jobs stranded by a crashed or restarted worker:
 * - `processing` leases older than `staleLeaseMs` are requeued (or moved to
 *   needs_user_action when the attempt budget is exhausted);
 * - `retryable_failed` long past their scheduled retry time are requeued.
 */
async function recoverStaleJobs(now = new Date(), { staleLeaseMs, maxAttempts } = {}) {
  const staleBefore = new Date(now.getTime() - staleLeaseMs);
  let requeued = 0;

  const staleProcessing = await Report.find({
    analysisStatus: AnalysisStatus.PROCESSING,
    analysisLockedAt: { $ne: null, $lt: staleBefore },
  })
    .limit(MAX_DRAIN_PER_TICK)
    .select('_id analysisAttempts')
    .lean();

  for (const job of staleProcessing) {
    const attempts = job.analysisAttempts || 0;
    if (attempts >= maxAttempts) {
      const result = await Report.updateOne(
        { _id: job._id, analysisStatus: AnalysisStatus.PROCESSING },
        {
          $set: {
            analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
            analysisError: 'Analysis lease expired after the retry budget was exhausted',
            analysisAttempts: attempts,
          },
          $unset: { analysisLockedAt: 1 },
        }
      );
      if (result.matchedCount > 0) await TemporaryImage.deleteOne({ reportId: job._id });
    } else {
      await Report.updateOne(
        { _id: job._id, analysisStatus: AnalysisStatus.PROCESSING },
        {
          $set: { analysisStatus: AnalysisStatus.PENDING },
          $unset: { analysisLockedAt: 1 },
        }
      );
      requeued += 1;
    }
  }

  const staleRetry = await Report.find({
    analysisStatus: AnalysisStatus.RETRYABLE_FAILED,
    analysisRetryAt: { $ne: null, $lt: new Date(now.getTime() - staleLeaseMs) },
  })
    .limit(MAX_DRAIN_PER_TICK)
    .select('_id analysisAttempts')
    .lean();

  for (const job of staleRetry) {
    const attempts = job.analysisAttempts || 0;
    if (attempts >= maxAttempts) {
      const result = await Report.updateOne(
        { _id: job._id, analysisStatus: AnalysisStatus.RETRYABLE_FAILED },
        {
          $set: {
            analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
            analysisError: 'Analysis retry window expired after the retry budget was exhausted',
          },
          $unset: { analysisLockedAt: 1 },
        }
      );
      if (result.matchedCount > 0) await TemporaryImage.deleteOne({ reportId: job._id });
    } else {
      await Report.updateOne(
        { _id: job._id, analysisStatus: AnalysisStatus.RETRYABLE_FAILED },
        {
          $set: { analysisStatus: AnalysisStatus.PENDING },
          $unset: { analysisRetryAt: 1 },
        }
      );
      requeued += 1;
    }
  }

  if (requeued > 0) {
    logger.info('Recovered stale analysis jobs', { requeued });
  }
  return requeued;
}

/**
 * Starts the worker loop. Returns { stop }. The analyzer is injected so
 * tests never touch the real provider.
 */
function startAnalysisWorker({ analyzer, config, logger: appLogger = logger }) {
  let stopped = false;
  let intervalTimer = null;
  const retryTimers = new Set();
  let draining = false;

  async function processDueRetries() {
    // In-process fast path: requeue any retry whose backoff elapsed.
    await requeueArrivedRetry();
  }

  async function drainOnce() {
    if (draining || stopped) return;
    draining = true;
    try {
      await processDueRetries();
      let processed = 0;
      while (!stopped && processed < MAX_DRAIN_PER_TICK) {
        const claimed = await claimNextPendingReport();
        if (!claimed) break;
        processed += 1;
        const result = await analysisService.processClaimedReport(claimed, {
          analyzer,
          aiMaxAttempts: config.aiMaxAttempts,
          retryDelayMs: backoffDelayMs(claimed.analysisAttempts),
        });
        if (result.outcome === 'retry_scheduled') {
          scheduleRetry(backoffDelayMs(claimed.analysisAttempts));
        }
        if (result.outcome === 'completed' && claimed.reportType === 'found') {
          // Phase 4 matching trigger point (AGENT.md §8): analysis completion
          // scores the found report against open lost reports. Failure here
          // must never invalidate the completed analysis.
          try {
            await matchingService.runMatchingForFoundReport(claimed._id);
          } catch (matchingError) {
            appLogger.error('Post-analysis matching failed', {
              reportId: String(claimed._id),
              reason: matchingError && matchingError.message,
            });
          }
        }
      }
      await recoverStaleJobs(new Date(), {
        staleLeaseMs: config.aiStaleLeaseMs,
        maxAttempts: config.aiMaxAttempts,
      });
    } catch (error) {
      appLogger.error('Analysis worker cycle failed', { reason: error && error.message });
    } finally {
      draining = false;
    }
  }

  /**
   * Nudges the loop right after a retry's backoff window ends so the next
   * attempt happens promptly; the regular interval remains the backstop.
   */
  function scheduleRetry(delayMs) {
    if (stopped) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!stopped) drainOnce();
    }, Math.max(250, delayMs + 250));
    timer.unref();
    retryTimers.add(timer);
  }

  intervalTimer = setInterval(() => {
    drainOnce();
  }, config.analysisWorkerIntervalMs);
  intervalTimer.unref();
  // Kick immediately so a freshly created report is claimed without delay.
  setImmediate(() => {
    drainOnce();
  });

  return {
    stop() {
      stopped = true;
      if (intervalTimer) clearInterval(intervalTimer);
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
  };
}

module.exports = {
  startAnalysisWorker,
  claimNextPendingReport,
  recoverStaleJobs,
  requeueArrivedRetry,
  backoffDelayMs,
};

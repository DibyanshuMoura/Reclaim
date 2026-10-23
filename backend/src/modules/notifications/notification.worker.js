'use strict';

/**
 * In-process notification delivery worker (AGENT.md §9).
 *
 * Email delivery is unreliable by nature, so each message goes through the
 * same discipline as analysis jobs: atomic claim with lease, bounded
 * attempts, exponential backoff + jitter via `notBefore`, stale-lease
 * recovery after crashes, and honest terminal states (`sent` / `failed`).
 * The transport AND the post-delivery hook are injected so tests never
 * touch SMTP and this module stays provider-agnostic.
 */
const Notification = require('./notification.model');
const notificationService = require('./notification.service');
const logger = require('../../utils/logger');

const MAX_DRAIN_PER_TICK = 25;
const COOLDOWN_BASE_MS = 2000;
const COOLDOWN_CAP_MS = 5 * 60 * 1000;

/** Exponential cooldown with 0–1s jitter. attempts starts at 1. */
function cooldownMs(attempts, jitter = Math.random()) {
  const base = COOLDOWN_BASE_MS * Math.max(0, (attempts || 1) - 1);
  return Math.min(COOLDOWN_CAP_MS, base + Math.floor(jitter * 1000));
}

/**
 * Recovers notifications a crashed worker left `processing` forever:
 * requeue within budget, `failed` after it. Terminal states are untouched.
 */
async function recoverStaleNotifications(now = new Date(), { staleLeaseMs, maxAttempts } = {}) {
  const staleBefore = new Date(now.getTime() - staleLeaseMs);
  let requeued = 0;
  let failed = 0;

  const stale = await Notification.find({
    status: 'processing',
    lockedAt: { $ne: null, $lt: staleBefore },
  })
    .limit(MAX_DRAIN_PER_TICK)
    .select('_id attempts')
    .lean();

  for (const item of stale) {
    if ((item.attempts || 0) >= maxAttempts) {
      const result = await Notification.updateOne(
        { _id: item._id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            lastError: 'Delivery lease expired after the attempt budget was exhausted',
          },
          $unset: { lockedAt: 1, notBefore: 1 },
        }
      );
      if (result.matchedCount > 0) failed += 1;
    } else {
      const result = await Notification.updateOne(
        { _id: item._id, status: 'processing' },
        { $set: { status: 'pending' }, $unset: { lockedAt: 1, notBefore: 1 } }
      );
      if (result.matchedCount > 0) requeued += 1;
    }
  }

  if (requeued > 0 || failed > 0) {
    logger.info('Recovered stale notification deliveries', { requeued, failed });
  }
  return { requeued, failed };
}

async function drainOnce({ config, transport, onDelivered, appLogger = logger }) {
  if (!transport) return 0; // email disabled: nothing is ever claimed

  let processed = 0;
  while (processed < MAX_DRAIN_PER_TICK) {
    const claimed = await notificationService.claimNextPendingNotification({
      maxAttempts: config.email.maxAttempts,
      staleLeaseMs: config.notifications.staleLeaseMs,
    });
    if (!claimed) break;
    processed += 1;

    try {
      await notificationService.processClaimedNotification(claimed, {
        transport,
        mailFrom: config.email.from,
        appBaseUrl: config.appBaseUrl,
        onDelivered,
      });
    } catch (deliveryError) {
      // Bounded, credential-free detail: provider replies may quote server
      // banners but never auth data; still, keep the stored slice short.
      const reason = String(deliveryError && deliveryError.message ? deliveryError.message : 'unknown error').slice(0, 300);
      const attempts = claimed.attempts || 1;
      if (attempts >= config.email.maxAttempts) {
        await Notification.updateOne(
          { _id: claimed._id, status: 'processing' },
          {
            $set: { status: 'failed', lastError: reason },
            $unset: { lockedAt: 1, notBefore: 1 },
          }
        );
        appLogger.error('Notification delivery permanently failed', {
          notificationId: String(claimed._id),
          attempts,
        });
      } else {
        await Notification.updateOne(
          { _id: claimed._id, status: 'processing' },
          {
            $set: {
              status: 'pending',
              lastError: reason,
              notBefore: new Date(Date.now() + cooldownMs(attempts)),
            },
            $unset: { lockedAt: 1 },
          }
        );
        appLogger.warn('Notification delivery failed; scheduled retry', {
          notificationId: String(claimed._id),
          attempt: attempts,
        });
      }
    }
  }
  return processed;
}

/**
 * Starts the worker loop. With SMTP disabled (`transport` null) the worker
 * stays a no-op — nothing pending exists in that mode anyway because
 * enqueues mark records `disabled`.
 */
function startNotificationsWorker({ transport, config, logger: appLogger = logger, onDelivered }) {
  let stopped = false;
  let intervalTimer = null;

  async function tick() {
    if (stopped || !transport) return;
    try {
      await recoverStaleNotifications(new Date(), {
        staleLeaseMs: config.notifications.staleLeaseMs,
        maxAttempts: config.email.maxAttempts,
      });
      const processed = await drainOnce({ config, transport, onDelivered, appLogger });
      if (processed > 0) {
        appLogger.info('Notification deliveries processed', { processed });
      }
    } catch (error) {
      appLogger.error('Notifications worker cycle failed', {
        reason: error && error.message ? error.message : String(error),
      });
    }
  }

  intervalTimer = setInterval(() => {
    tick();
  }, config.notifications.workerIntervalMs);
  intervalTimer.unref();
  // Kick immediately so freshly enqueued emails go out without delay.
  setImmediate(() => {
    tick();
  });

  return {
    stop() {
      stopped = true;
      if (intervalTimer) clearInterval(intervalTimer);
    },
  };
}

module.exports = {
  startNotificationsWorker,
  recoverStaleNotifications,
  drainOnce,
  cooldownMs,
};

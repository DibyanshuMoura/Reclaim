'use strict';

/**
 * Notification business logic (AGENT.md §7, §9).
 *
 * - Logical notifications are created idempotently via a unique
 *   idempotency key (`<matchId>:<role>:<type>`); enqueues are safe upserts,
 *   so no worker run or code path can produce duplicate emails.
 * - When email is disabled in configuration, records are created with the
 *   honest status `disabled` — matches still work, and no email is faked.
 * - Delivery claims are atomic lease transitions with attempt accounting;
 *   failures requeue with exponential backoff + jitter (`notBefore`) and
 *   become `failed` only after the configured attempt budget is exhausted.
 * - Email bodies are rebuilt at delivery time from persisted state so a
 *   crash-retry re-renders the identical, party-scoped message. Raw party
 *   tokens used for that link are internal `select: false` fields, never
 *   logged and never returned by any API view.
 */
const Report = require('../reports/report.model');
const Match = require('../matching/match.model');
const Notification = require('./notification.model');
const { loadConfig } = require('../../config/env');
const logger = require('../../utils/logger');
const { matchSuggestedEmail, contactsSharedEmail, line } = require('./templates');

const INITIAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  DISABLED: 'disabled',
});

/**
 * Idempotently enqueues both parties' suggested-match emails. The raw
 * tokens exist only transiently (in the caller's scope and, for delivery
 * retries, inside the internal notification row) — the Match collection
 * itself stores only hashes.
 */
async function enqueueMatchSuggestions({ matchId, loserEmail, finderEmail, loserToken, finderToken }) {
  const config = loadConfig();
  const initialStatus = config.email.enabled ? INITIAL_STATUSES.PENDING : INITIAL_STATUSES.DISABLED;

  const recipients = [
    { role: 'loser', toEmail: loserEmail, partyMatchToken: loserToken },
    { role: 'finder', toEmail: finderEmail, partyMatchToken: finderToken },
  ];

  for (const recipient of recipients) {
    await Notification.updateOne(
      { idempotencyKey: `${matchId}:${recipient.role}:match_suggested` },
      {
        $setOnInsert: {
          matchId,
          role: recipient.role,
          type: 'match_suggested',
          toEmail: recipient.toEmail,
          partyMatchToken: recipient.partyMatchToken,
          status: initialStatus,
        },
      },
      { upsert: true }
    );
  }
}

/** Idempotently enqueues the contacts-shared emails after mutual confirm. */
async function enqueueContactsShared({ matchId, loserEmail, finderEmail }) {
  const config = loadConfig();
  const initialStatus = config.email.enabled ? INITIAL_STATUSES.PENDING : INITIAL_STATUSES.DISABLED;

  const recipients = [
    { role: 'loser', toEmail: loserEmail },
    { role: 'finder', toEmail: finderEmail },
  ];

  for (const recipient of recipients) {
    await Notification.updateOne(
      { idempotencyKey: `${matchId}:${recipient.role}:contacts_shared` },
      {
        $setOnInsert: {
          matchId,
          role: recipient.role,
          type: 'contacts_shared',
          toEmail: recipient.toEmail,
          status: initialStatus,
        },
      },
      { upsert: true }
    );
  }
}

/** Cancels still-undelivered notifications for a match (e.g. report closed). */
async function cancelPendingForMatch(matchId) {
  const result = await Notification.updateMany(
    { matchId, status: 'pending' },
    { $set: { status: 'cancelled' }, $unset: { lockedAt: 1, notBefore: 1 } }
  );
  return result.modifiedCount || 0;
}

async function loadMatchPair(matchId) {
  const match = await Match.findById(matchId).lean();
  if (!match) return null;
  const [lost, found] = await Promise.all([
    Report.findById(match.lostReportId).select('+contactEmail').lean(),
    Report.findById(match.foundReportId).select('+contactEmail').lean(),
  ]);
  if (!lost || !found) return null;
  return { match, lost, found };
}

/**
 * Renders the email content for a claimed notification from persisted
 * state only. Never includes the other party's contact details for
 * suggested-match emails (privacy invariant).
 */
async function buildNotificationContent(notification, { appBaseUrl }) {
  const pair = await loadMatchPair(notification.matchId);
  if (!pair) {
    throw new Error('Matched reports are missing for this notification');
  }

  if (notification.type === 'contacts_shared') {
    // Only ever built after mutual confirmation; reveals the counterparty
    // email to the recipient of THIS notification.
    const counterpartyEmail =
      notification.role === 'loser' ? pair.found.contactEmail : pair.lost.contactEmail;
    return contactsSharedEmail({ counterpartyEmail });
  }

  // match_suggested: only the recipient's own private link, no counterparty.
  const ownLabel =
    notification.role === 'loser' ? `lost ${line(pair.lost.itemName, 100)}` : 'the found item you reported';
  // Deep-link into the web match page (same app); the token is the credential.
  const matchUrl = `${appBaseUrl}/match/${notification.partyMatchToken}`;
  return matchSuggestedEmail({ role: notification.role, ownLabel, matchUrl });
}

/**
 * Atomically claims the oldest deliverable notification. Attempts are
 * incremented at claim; `notBefore` delays re-claims after failures.
 */
async function claimNextPendingNotification({ maxAttempts, staleLeaseMs, now = new Date() }) {
  void staleLeaseMs; // documented param symmetry with the worker recovery pass
  return Notification.findOneAndUpdate(
    {
      status: 'pending',
      attempts: { $lt: maxAttempts },
      $or: [{ notBefore: null }, { notBefore: { $lte: now } }],
    },
    { $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  ).select('+toEmail +partyMatchToken +attempts +lockedAt +notBefore +lastError');
}

/**
 * Delivers one claimed notification through the injected transport.
 * The transport is never email-provider-specific from the caller's view;
 * tests pass a stub. onDelivered(matchId) is called (fire and forget with
 * logging by the caller) after a `match_suggested` email is sent so the
 * match can move `suggested` → `notified` when both sides are delivered.
 */
async function processClaimedNotification(
  notification,
  { transport, mailFrom, appBaseUrl, onDelivered }
) {
  const notificationId = notification._id;

  if (!transport) {
    // Configuration says email is off; be honest about the outcome.
    await Notification.updateOne(
      { _id: notificationId, status: 'processing' },
      { $set: { status: 'disabled', lockedAt: null }, $unset: { notBefore: 1 } }
    );
    return { outcome: 'disabled' };
  }

  const content = await buildNotificationContent(notification, { appBaseUrl });

  await transport.sendMail({
    from: mailFrom,
    to: notification.toEmail,
    subject: content.subject,
    text: content.body,
  });

  const result = await Notification.updateOne(
    { _id: notificationId, status: 'processing' },
    { $set: { status: 'sent', sentAt: new Date(), lastError: null, lockedAt: null }, $unset: { notBefore: 1 } }
  );

  if (notification.type === 'match_suggested' && typeof onDelivered === 'function') {
    try {
      await onDelivered(notification.matchId);
    } catch (hookError) {
      logger.warn('Post-delivery match hook failed', {
        notificationId: String(notificationId),
        reason: hookError && hookError.message,
      });
    }
  }

  return { outcome: result.matchedCount > 0 ? 'sent' : 'raced' };
}

module.exports = {
  enqueueMatchSuggestions,
  enqueueContactsShared,
  cancelPendingForMatch,
  buildNotificationContent,
  claimNextPendingNotification,
  processClaimedNotification,
};

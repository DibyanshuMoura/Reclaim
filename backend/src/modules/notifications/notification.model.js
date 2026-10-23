'use strict';

/**
 * Logical email notification records (AGENT.md §7, §9).
 *
 * One record per (match, role, type) with a unique idempotency key so
 * worker retries and re-created matches can never send duplicates. Delivery
 * state is persisted honestly: `disabled` means this deployment has SMTP
 * turned off — no email was pretended to be sent.
 *
 * Privacy: `toEmail` and `partyMatchToken` are `select: false` internals.
 * The raw party token exists ONLY so a retried delivery re-renders the
 * same private link; it is never logged, never exposed by the API, and its
 * presence is intentionally mirrored by the email body itself (which
 * carries the link anyway). The Match collection stores only hashes.
 */
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    matchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Match',
      required: true,
      index: true,
    },
    role: { type: String, required: true, enum: ['loser', 'finder'] },
    type: {
      type: String,
      required: true,
      enum: ['match_suggested', 'contacts_shared'],
    },
    // "<matchId>:<role>:<type>" — unique; enqueues are upserts on this key.
    idempotencyKey: { type: String, required: true, unique: true },
    toEmail: { type: String, required: true, lowercase: true, select: false },
    partyMatchToken: { type: String, select: false },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'sent', 'failed', 'disabled', 'cancelled'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0, select: false },
    lockedAt: { type: Date, select: false },
    // Earliest re-claim time after a failed attempt (backoff + jitter).
    notBefore: { type: Date, select: false },
    sentAt: { type: Date },
    lastError: { type: String, maxlength: 300, select: false },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Notification ||
  mongoose.model('Notification', notificationSchema);

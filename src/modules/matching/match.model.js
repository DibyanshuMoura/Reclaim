'use strict';

/**
 * Deterministic match between exactly one lost report and one found report
 * (AGENT.md §7, §8).
 *
 * - The unique (lost, found) pair index makes matching runs idempotent:
 *   re-scoring can never create duplicate pairs or duplicate notifications.
 * - Each party gets its own scoped access token for the match, stored only
 *   as a SHA-256 hash. Raw tokens are shown exactly once (in that party's
 *   notification email) and never logged.
 * - Status transitions are validated explicitly; closed/resolved are
 *   terminal.
 */
const mongoose = require('mongoose');

const MatchStatus = Object.freeze({
  SUGGESTED: 'suggested',
  NOTIFIED: 'notified',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  RESOLVED: 'resolved',
});

// `suggested` → `notified` happens when both parties' notification emails
// have been delivered. `confirmed` requires BOTH parties. Closing either
// related report resolves an active match.
const MATCH_STATUS_TRANSITIONS = Object.freeze({
  [MatchStatus.SUGGESTED]: [
    MatchStatus.NOTIFIED,
    MatchStatus.CONFIRMED,
    MatchStatus.REJECTED,
    MatchStatus.RESOLVED,
  ],
  [MatchStatus.NOTIFIED]: [
    MatchStatus.CONFIRMED,
    MatchStatus.REJECTED,
    MatchStatus.RESOLVED,
  ],
  [MatchStatus.CONFIRMED]: [MatchStatus.RESOLVED],
  [MatchStatus.REJECTED]: [],
  [MatchStatus.RESOLVED]: [],
});

function canTransitionMatchStatus(from, to) {
  if (from === to) return true; // same-state writes are idempotent no-ops
  const allowed = MATCH_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const matchSchema = new mongoose.Schema(
  {
    lostReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Report',
      required: true,
    },
    foundReportId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Report',
      required: true,
    },
    // Bounded deterministic score, 0..100.
    score: { type: Number, required: true, min: 0, max: 100 },
    // Explainability entries: [{ key, label, description, score }]
    // Scores live in [-1, 1] (negative = conflicting known attributes).
    factors: { type: Array, default: () => [] },
    status: {
      type: String,
      required: true,
      enum: Object.values(MatchStatus),
      default: MatchStatus.SUGGESTED,
      index: true,
    },
    loserTokenHash: { type: String, required: true, unique: true, select: false },
    finderTokenHash: { type: String, required: true, unique: true, select: false },
    loserConfirmedAt: { type: Date, default: null },
    finderConfirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

matchSchema.index({ lostReportId: 1, foundReportId: 1 }, { unique: true });

const Match = mongoose.models.Match || mongoose.model('Match', matchSchema);
Match.MatchStatus = MatchStatus;
Match.canTransitionMatchStatus = canTransitionMatchStatus;

module.exports = Match;

'use strict';

/**
 * Report state enumerations and transition rules (AGENT.md §7).
 *
 * `status` is the report lifecycle; `analysisStatus` tracks AI image analysis.
 * They must never be conflated — a closed report can still have a pending
 * analysis field recorded in its history.
 */

const ReportStatus = {
  OPEN: 'open',
  MATCHED: 'matched',
  RECOVERY_IN_PROGRESS: 'recovery_in_progress',
  RECOVERED: 'recovered',
  CLOSED: 'closed',
};

const AnalysisStatus = {
  NOT_REQUIRED: 'not_required',
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  RETRYABLE_FAILED: 'retryable_failed',
  NEEDS_USER_ACTION: 'needs_user_action',
  PERMANENT_FAILED: 'permanent_failed',
};

// Which lifecycle states may follow which. Closed is terminal.
const LIFECYCLE_TRANSITIONS = Object.freeze({
  [ReportStatus.OPEN]: [ReportStatus.MATCHED, ReportStatus.CLOSED],
  [ReportStatus.MATCHED]: [
    ReportStatus.RECOVERY_IN_PROGRESS,
    ReportStatus.RECOVERED,
    ReportStatus.CLOSED,
  ],
  [ReportStatus.RECOVERY_IN_PROGRESS]: [ReportStatus.RECOVERED, ReportStatus.CLOSED],
  [ReportStatus.RECOVERED]: [ReportStatus.CLOSED],
  [ReportStatus.CLOSED]: [],
});

// Analysis states. Re-entry into pending/processing exists so retries and
// user re-uploads can move a failed analysis forward again.
const ANALYSIS_TRANSITIONS = Object.freeze({
  [AnalysisStatus.NOT_REQUIRED]: [],
  [AnalysisStatus.PENDING]: [
    AnalysisStatus.PROCESSING,
    AnalysisStatus.COMPLETED,
    AnalysisStatus.RETRYABLE_FAILED,
  ],
  [AnalysisStatus.PROCESSING]: [
    AnalysisStatus.COMPLETED,
    AnalysisStatus.RETRYABLE_FAILED,
    AnalysisStatus.NEEDS_USER_ACTION,
    AnalysisStatus.PERMANENT_FAILED,
    AnalysisStatus.PENDING, // stale-lease recovery requeues the job
  ],
  [AnalysisStatus.RETRYABLE_FAILED]: [
    AnalysisStatus.PROCESSING,
    AnalysisStatus.PENDING,
    AnalysisStatus.NEEDS_USER_ACTION,
    AnalysisStatus.PERMANENT_FAILED,
  ],
  [AnalysisStatus.NEEDS_USER_ACTION]: [
    AnalysisStatus.PROCESSING,
    AnalysisStatus.PENDING,
    AnalysisStatus.PERMANENT_FAILED,
  ],
  [AnalysisStatus.PERMANENT_FAILED]: [AnalysisStatus.PROCESSING, AnalysisStatus.PENDING],
  [AnalysisStatus.COMPLETED]: [],
});

/**
 * A same-state write is always allowed (idempotent no-op). Any other move
 * must be declared in the transition map.
 */
function canTransition(transitions, from, to) {
  if (from === to) return transitions[from] !== undefined;
  const allowed = transitions[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

const canTransitionLifecycle = (from, to) => canTransition(LIFECYCLE_TRANSITIONS, from, to);
const canTransitionAnalysis = (from, to) => canTransition(ANALYSIS_TRANSITIONS, from, to);

module.exports = {
  ReportStatus,
  AnalysisStatus,
  LIFECYCLE_TRANSITIONS,
  ANALYSIS_TRANSITIONS,
  canTransitionLifecycle,
  canTransitionAnalysis,
};

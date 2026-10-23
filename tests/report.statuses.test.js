'use strict';

const {
  ReportStatus,
  AnalysisStatus,
  canTransitionLifecycle,
  canTransitionAnalysis,
} = require('../src/modules/reports/report.statuses');

describe('report lifecycle transitions', () => {
  it('allows forward progression', () => {
    expect(canTransitionLifecycle(ReportStatus.OPEN, ReportStatus.MATCHED)).toBe(true);
    expect(canTransitionLifecycle(ReportStatus.MATCHED, ReportStatus.RECOVERY_IN_PROGRESS)).toBe(
      true
    );
    expect(canTransitionLifecycle(ReportStatus.RECOVERY_IN_PROGRESS, ReportStatus.RECOVERED)).toBe(
      true
    );
    expect(canTransitionLifecycle(ReportStatus.RECOVERED, ReportStatus.CLOSED)).toBe(true);
  });

  it('rejects skipping lifecycle stages', () => {
    expect(canTransitionLifecycle(ReportStatus.OPEN, ReportStatus.RECOVERED)).toBe(false);
    expect(canTransitionLifecycle(ReportStatus.OPEN, ReportStatus.RECOVERY_IN_PROGRESS)).toBe(
      false
    );
  });

  it('treats closed as terminal', () => {
    expect(canTransitionLifecycle(ReportStatus.CLOSED, ReportStatus.OPEN)).toBe(false);
    expect(canTransitionLifecycle(ReportStatus.CLOSED, ReportStatus.CLOSED)).toBe(true);
  });
});

describe('analysis state transitions', () => {
  it('allows pending to processing to completed', () => {
    expect(canTransitionAnalysis(AnalysisStatus.PENDING, AnalysisStatus.PROCESSING)).toBe(true);
    expect(canTransitionAnalysis(AnalysisStatus.PROCESSING, AnalysisStatus.COMPLETED)).toBe(true);
  });

  it('allows retry and requeue paths for failed states', () => {
    expect(
      canTransitionAnalysis(AnalysisStatus.RETRYABLE_FAILED, AnalysisStatus.PROCESSING)
    ).toBe(true);
    expect(canTransitionAnalysis(AnalysisStatus.PROCESSING, AnalysisStatus.PENDING)).toBe(true);
    expect(canTransitionAnalysis(AnalysisStatus.NEEDS_USER_ACTION, AnalysisStatus.PENDING)).toBe(
      true
    );
  });

  it('prevents reopening completed analyses and advancing not_required', () => {
    expect(canTransitionAnalysis(AnalysisStatus.COMPLETED, AnalysisStatus.PROCESSING)).toBe(false);
    expect(canTransitionAnalysis(AnalysisStatus.NOT_REQUIRED, AnalysisStatus.PENDING)).toBe(false);
  });

  it('prevents skipping from pending straight to user-action or permanent failure', () => {
    expect(canTransitionAnalysis(AnalysisStatus.PENDING, AnalysisStatus.NEEDS_USER_ACTION)).toBe(
      false
    );
    expect(canTransitionAnalysis(AnalysisStatus.PENDING, AnalysisStatus.PERMANENT_FAILED)).toBe(
      false
    );
  });
});

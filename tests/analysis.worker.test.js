'use strict';

const request = require('supertest');
const { startTestDb, stopTestDb } = require('./helpers/db');
const { createTestImage } = require('./helpers/images');
const Report = require('../src/modules/reports/report.model');
const TemporaryImage = require('../src/infrastructure/temporary-images/temporary-image.model');
const {
  claimNextPendingReport,
  recoverStaleJobs,
  requeueArrivedRetry,
  backoffDelayMs,
} = require('../src/modules/image-analysis/analysis.worker');
const { AnalysisStatus } = require('../src/modules/reports/report.statuses');

let mongod;
let app;

beforeAll(async () => {
  mongod = await startTestDb();
  app = require('../src/app').createApp();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

async function createImageReport() {
  const res = await request(app)
    .post('/api/v1/reports/found')
    .field('contactEmail', 'worker@example.com')
    .attach('image', await createTestImage(), { filename: 'a.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  return Report.findById(res.body.report.id);
}

describe('claiming', () => {
  it('claims atomically, increments attempts, and never double-claims', async () => {
    await createImageReport();

    const claimed = await claimNextPendingReport();
    expect(claimed).not.toBeNull();
    expect(claimed.analysisStatus).toBe(AnalysisStatus.PROCESSING);
    expect(claimed.analysisAttempts).toBe(1);
    expect(claimed.analysisLockedAt).toBeInstanceOf(Date);

    // Already claimed: nothing is pending anymore.
    const second = await claimNextPendingReport();
    expect(second).toBeNull();
  });

  it('claims the oldest pending first', async () => {
    const first = await createImageReport();
    await createImageReport();

    const claimed = await claimNextPendingReport();
    expect(claimed._id.toString()).toBe(first._id.toString());
  });
});

describe('stale job recovery', () => {
  it('requeues a stale processing lease', async () => {
    await createImageReport();
    const claimed = await claimNextPendingReport();

    // Simulate a crashed worker: lock date far in the past.
    await Report.updateOne(
      { _id: claimed._id },
      { $set: { analysisLockedAt: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    const requeued = await recoverStaleJobs(new Date(), {
      staleLeaseMs: 60 * 1000,
      maxAttempts: 3,
    });

    expect(requeued).toBe(1);
    const after = await Report.findById(claimed._id);
    expect(after.analysisStatus).toBe(AnalysisStatus.PENDING);

    // It is claimable again without losing attempt accounting.
    const next = await claimNextPendingReport();
    expect(next._id.toString()).toBe(claimed._id.toString());
    expect(next.analysisAttempts).toBe(2);
  });

  it('moves a stale processing lease past its budget to needs_user_action', async () => {
    await createImageReport();
    const claimed = await claimNextPendingReport();
    await Report.updateOne(
      { _id: claimed._id },
      {
        $set: {
          analysisAttempts: 3,
          analysisLockedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
      }
    );

    await recoverStaleJobs(new Date(), {
      staleLeaseMs: 60 * 1000,
      maxAttempts: 3,
    });

    const after = await Report.findById(claimed._id);
    expect(after.analysisStatus).toBe(AnalysisStatus.NEEDS_USER_ACTION);
    expect(await TemporaryImage.countDocuments({ reportId: after._id })).toBe(0);
  });

  it('requeues overdue retryable_failed entries', async () => {
    await createImageReport();
    await Report.updateOne(
      { analysisStatus: AnalysisStatus.PROCESSING },
      {
        $set: {
          analysisStatus: AnalysisStatus.RETRYABLE_FAILED,
          analysisRetryAt: new Date(Date.now() - 10 * 60 * 1000),
          analysisAttempts: 1,
        },
        $unset: { analysisLockedAt: 1 },
      }
    );

    const requeued = await recoverStaleJobs(new Date(), {
      staleLeaseMs: 60 * 1000,
      maxAttempts: 3,
    });
    expect(requeued).toBe(1);

    const after = await Report.findOne({ analysisStatus: AnalysisStatus.PENDING });
    expect(after).not.toBeNull();
  });

  it('requeues on demand when a retry backoff has elapsed', async () => {
    await createImageReport();
    await claimNextPendingReport();
    await Report.updateOne(
      { analysisStatus: AnalysisStatus.PROCESSING },
      {
        $set: {
          analysisStatus: AnalysisStatus.RETRYABLE_FAILED,
          analysisRetryAt: new Date(Date.now() - 2000),
          analysisAttempts: 1,
        },
        $unset: { analysisLockedAt: 1 },
      }
    );

    await requeueArrivedRetry();
    const after = await Report.findOne({ analysisStatus: AnalysisStatus.PENDING });
    expect(after).not.toBeNull();
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter and respects the cap', () => {
    for (let attempts = 1; attempts <= 3; attempts += 1) {
      const delay = backoffDelayMs(attempts, 0);
      expect(delay).toBeGreaterThanOrEqual(2000 * 2 ** (attempts - 1));
      expect(delay).toBeLessThan(2000 * 2 ** attempts + 1000);
    }
    expect(backoffDelayMs(20, 0)).toBe(5 * 60 * 1000);
  });
});

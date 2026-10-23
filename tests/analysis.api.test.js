'use strict';

const request = require('supertest');
const { startTestDb, stopTestDb } = require('./helpers/db');
const { createTestImage } = require('./helpers/images');
const {
  claimNextPendingReport,
  requeueArrivedRetry,
} = require('../src/modules/image-analysis/analysis.worker');
const {
  processClaimedReport,
} = require('../src/modules/image-analysis/analysis.service');
const {
  GeminiPermanentError,
  GeminiTransientError,
} = require('../src/infrastructure/gemini/client');
const TemporaryImage = require('../src/infrastructure/temporary-images/temporary-image.model');
const Report = require('../src/modules/reports/report.model');

// Internal bookkeeping fields are select:false; tests opt in explicitly.
const INTERNAL_FIELDS = '+analysisAttempts +analysisLockedAt +analysisRetryAt +analysisError';
const readReport = (id) => Report.findById(id).select(INTERNAL_FIELDS);

let mongod;
let app;

beforeAll(async () => {
  mongod = await startTestDb();
  app = require('../src/app').createApp();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

// Each test starts with a clean slate so oldest-first claiming always picks
// up the report the test itself just created.
beforeEach(async () => {
  await Report.deleteMany({});
  await TemporaryImage.deleteMany({});
});

async function createFoundReport({ image } = {}) {
  const resolvedImage = image === undefined ? await createTestImage() : image;
  const agent = request(app).post('/api/v1/reports/found');
  agent.field('contactEmail', 'finder@example.com').field('venue', 'Terminal 2');
  if (resolvedImage !== null) {
    agent.attach('image', resolvedImage, { filename: 'photo.png', contentType: 'image/png' });
  }
  return agent;
}

const validAnalyzerOutput = {
  category: 'backpack',
  itemType: 'backpack',
  primaryColor: 'black',
  secondaryColors: ['red'],
  brand: null,
  visibleFeatures: ['front zipper pocket'],
  condition: 'good',
  uncertainAttributes: [],
};

describe('POST /api/v1/reports/found (with image)', () => {
  it('persists the report and the temporary image without leaking either', async () => {
    const image = await createTestImage();
    const res = await createFoundReport({ image });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.report.analysisStatus).toBe('pending');
    expect(res.body.report).not.toHaveProperty('attributes');
    expect(JSON.stringify(res.body)).not.toContain('finder@example.com');

    const report = await Report.findById(res.body.report.id);
    expect(report.analysisStatus).toBe('pending');

    const temp = await TemporaryImage.findOne({ reportId: report._id });
    expect(temp).not.toBeNull();
    expect(temp.mimeType).toBe('image/jpeg');
    expect(temp.bytes).toBeGreaterThan(0);
    expect(temp.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects found reports without an image', async () => {
    const res = await createFoundReport({ image: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'image')).toBe(true);
  });

  it('rejects corrupted uploads without persisting anything', async () => {
    const Report = require('../src/modules/reports/report.model');
    const before = await Report.countDocuments();
    const res = await createFoundReport({ image: Buffer.from('not an image at all') });

    expect(res.status).toBe(400);
    expect(await Report.countDocuments()).toBe(before);
    expect(await TemporaryImage.countDocuments({})).toBe(0);
  });

  it('rejects wrong multipart field names', async () => {
    const image = await createTestImage();
    const res = await request(app)
      .post('/api/v1/reports/found')
      .field('contactEmail', 'finder@example.com')
      .attach('photo', image, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MULTIPART_INVALID');
  });
});

describe('analysis lifecycle via injected analyzer', () => {
  async function claimAndProcess(analyzer, { aiMaxAttempts = 3, retryDelayMs = 1000 } = {}) {
    const claimed = await claimNextPendingReport();
    return processClaimedReport(claimed, { analyzer, aiMaxAttempts, retryDelayMs });
  }

  it('persists validated normalized attributes and deletes the temporary image', async () => {
    const created = await createFoundReport();
    const analyzer = async () => ({
      ...validAnalyzerOutput,
      primaryColor: 'BLACK',
      secondaryColors: ['red', 'red', 'blue'],
      condition: 'unknown',
      modelInvented: 'field-to-strip',
    });

    const result = await claimAndProcess(analyzer);
    expect(result.outcome).toBe('completed');

    const report = await Report.findById(created.body.report.id);
    expect(report.analysisStatus).toBe('completed');
    expect(report.attributes).toEqual(
      expect.objectContaining({
        category: 'backpack',
        primaryColor: 'black',
        secondaryColors: ['red', 'blue'],
        visibleFeatures: ['front zipper pocket'],
        condition: null,
        analysisVersion: '1',
      })
    );
    expect(report.attributes).not.toHaveProperty('modelInvented');
    expect(await TemporaryImage.countDocuments({ reportId: report._id })).toBe(0);
  });

  it('treats an informationless answer as empty-output and never persists empty attributes', async () => {
    await createFoundReport();
    const emptyAnalyzer = async () => ({
      category: null,
      itemType: null,
      primaryColor: null,
      secondaryColors: [],
      brand: null,
      condition: null,
      visibleFeatures: [],
      uncertainAttributes: [],
    });

    const result = await claimAndProcess(emptyAnalyzer, { aiMaxAttempts: 1 });
    expect(result.outcome).toBe('needs_user_action');

    const report = await Report.findOne({ analysisStatus: 'needs_user_action' }).select(
      INTERNAL_FIELDS
    );
    expect(report).not.toBeNull();
    expect(report.attributes).toBeFalsy();
    expect(await TemporaryImage.countDocuments({ reportId: report._id })).toBe(0);
  });

  it('still completes when at least one attribute carries real content', async () => {
    await createFoundReport();
    const analyzer = async () => ({
      ...validAnalyzerOutput,
      primaryColor: null,
      secondaryColors: [],
      visibleFeatures: [],
      uncertainAttributes: [],
      brand: null,
      condition: null,
    });

    const result = await claimAndProcess(analyzer);
    expect(result.outcome).toBe('completed');

    const report = await Report.findOne({ analysisStatus: 'completed' });
    expect(report.attributes.itemType).toBe('backpack');
  });

  it('recovers completed-but-unrecorded analyses without another provider call', async () => {
    // Simulate a crash between attribute persistence and completion:
    // claim a real pending report first, then inject attributes while the
    // state is still `processing`.
    const created = await createFoundReport();
    const claimed = await claimNextPendingReport();
    expect(claimed._id.toString()).toBe(created.body.report.id);

    claimed.attributes = validAnalyzerOutput;
    await claimed.save();

    let analyzerRuns = 0;
    const analyzer = async () => {
      analyzerRuns += 1;
      return validAnalyzerOutput;
    };

    const result = await processClaimedReport(claimed, { analyzer, aiMaxAttempts: 3, retryDelayMs: 1000 });
    expect(result.outcome).toBe('completed');
    expect(analyzerRuns).toBe(0);

    const after = await readReport(created.body.report.id);
    expect(after.analysisStatus).toBe('completed');
    expect(await TemporaryImage.countDocuments({ reportId: after._id })).toBe(0);
  });

  it('schedules a bounded retry after transient failures and keeps the image', async () => {
    await createFoundReport();
    let calls = 0;
    const analyzer = async () => {
      calls += 1;
      if (calls === 1) throw new GeminiTransientError('network', 'Could not reach the vision provider');
      return validAnalyzerOutput;
    };

    const first = await claimAndProcess(analyzer);
    expect(first.outcome).toBe('retry_scheduled');

    const afterFirst = await Report.findOne({ analysisStatus: 'retryable_failed' }).select(
      INTERNAL_FIELDS
    );
    expect(afterFirst).not.toBeNull();
    expect(afterFirst.analysisRetryAt).toBeInstanceOf(Date);
    expect(await TemporaryImage.countDocuments({ reportId: afterFirst._id })).toBe(1);

    // Mirror the worker: once the backoff window elapses, the retry is
    // requeued and claimed like any other pending report.
    await Report.updateOne(
      { _id: afterFirst._id },
      { $set: { analysisRetryAt: new Date(Date.now() - 1000) } }
    );
    await requeueArrivedRetry();

    const second = await claimAndProcess(analyzer);
    expect(second.outcome).toBe('completed');

    const done = await readReport(afterFirst._id);
    expect(done).not.toBeNull();
    expect(done.analysisStatus).toBe('completed');
    expect(done.analysisAttempts).toBe(2);
    expect(await TemporaryImage.countDocuments({ reportId: done._id })).toBe(0);
  });

  it('moves to needs_user_action after the attempt budget is exhausted', async () => {
    await createFoundReport();
    const analyzer = async () => {
      throw new GeminiTransientError('timeout', 'Image analysis timed out');
    };

    const result = await claimAndProcess(analyzer, { aiMaxAttempts: 1 });
    expect(result.outcome).toBe('needs_user_action');

    const report = await Report.findOne({ analysisStatus: 'needs_user_action' }).select(
      INTERNAL_FIELDS
    );
    expect(report).not.toBeNull();
    expect(report.analysisError).toMatch(/budget/i);
    expect(await TemporaryImage.countDocuments({ reportId: report._id })).toBe(0);
  });

  it('treats quota/auth/model errors honestly and never retries them', async () => {
    const quotaResult = await (async () => {
      await createFoundReport();
      const result = await claimAndProcess(async () => {
        throw new GeminiPermanentError('quota', 'Vision provider quota is exhausted');
      });
      const report = await Report.findOne({ analysisStatus: 'needs_user_action' }).select(
        INTERNAL_FIELDS
      );
      return { result, report };
    })();
    expect(quotaResult.result.outcome).toBe('needs_user_action');
    expect(quotaResult.report.analysisAttempts).toBe(1); // budget not burned further

    await createFoundReport();
    const authResult = await claimAndProcess(async () => {
      throw new GeminiPermanentError('auth', 'Vision provider rejected the configured credentials');
    });
    expect(authResult.outcome).toBe('permanent_failed');
    const authReport = await Report.findOne({ analysisStatus: 'permanent_failed' });
    expect(authReport).not.toBeNull();
  });

  it('handles image-expired reports by requesting a re-upload', async () => {
    // A report claiming to be pending but whose temp image is gone.
    const created = await createFoundReport();
    const report = await Report.findById(created.body.report.id);
    await TemporaryImage.deleteOne({ reportId: report._id });

    const result = await claimAndProcess(async () => validAnalyzerOutput);
    expect(result.outcome).toBe('needs_user_action');

    const after = await Report.findById(created.body.report.id);
    expect(after.analysisStatus).toBe('needs_user_action');
  });
});

describe('POST /api/v1/private/reports/:token/image (recovery path)', () => {
  it('re-arms a needs_user_action report with a fresh image and budget', async () => {
    const created = await createFoundReport();
    const report = await Report.findById(created.body.report.id);
    report.analysisStatus = 'needs_user_action';
    await report.save();
    await TemporaryImage.deleteOne({ reportId: report._id });

    const res = await request(app)
      .post(`/api/v1/private/reports/${created.body.accessToken}/image`)
      .attach('image', await createTestImage({ g: 30 }), { filename: 'new.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.report.analysisStatus).toBe('pending');

    const after = await readReport(created.body.report.id);
    expect(after.analysisStatus).toBe('pending');
    expect(after.analysisAttempts).toBe(0);
    expect(await TemporaryImage.countDocuments({ reportId: after._id })).toBe(1);
  });

  it('rejects recovery uploads with 409 while analysis is in flight', async () => {
    const created = await createFoundReport(); // analysisStatus: pending
    const res = await request(app)
      .post(`/api/v1/private/reports/${created.body.accessToken}/image`)
      .attach('image', await createTestImage(), { filename: 'again.png', contentType: 'image/png' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_RETRYABLE');
  });

  it('rejects recovery uploads for unknown tokens', async () => {
    const res = await request(app)
      .post(`/api/v1/private/reports/${'c'.repeat(43)}/image`)
      .attach('image', await createTestImage(), { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(404);
  });
});

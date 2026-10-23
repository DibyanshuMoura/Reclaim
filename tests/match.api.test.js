'use strict';

const request = require('supertest');
const { startTestDb, stopTestDb } = require('./helpers/db');
const { createTestImage } = require('./helpers/images');
const Report = require('../src/modules/reports/report.model');
const TemporaryImage = require('../src/infrastructure/temporary-images/temporary-image.model');
const Match = require('../src/modules/matching/match.model');
const Notification = require('../src/modules/notifications/notification.model');
const { claimNextPendingReport } = require('../src/modules/image-analysis/analysis.worker');
const { processClaimedReport } = require('../src/modules/image-analysis/analysis.service');
const matchingService = require('../src/modules/matching/match.service');

let mongod;
let app;

const ANALYZER_OUTPUT = {
  category: 'backpack',
  itemType: 'backpack',
  primaryColor: 'black',
  secondaryColors: [],
  brand: null,
  condition: 'good',
  visibleFeatures: ['two shoulder straps', 'laptop compartment'],
  uncertainAttributes: [],
};

const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

beforeAll(async () => {
  mongod = await startTestDb();
  app = require('../src/app').createApp();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

beforeEach(async () => {
  await Report.deleteMany({});
  await TemporaryImage.deleteMany({});
  await Match.deleteMany({});
  await Notification.deleteMany({});
});

// Returns the creation payload: { report, accessToken }.
async function createLostReport(payload = {}) {
  const res = await request(app)
    .post('/api/v1/reports/lost')
    .send({
      itemName: 'black backpack',
      description: 'black backpack with two straps and a laptop inside, used daily for college',
      colors: ['black'],
      venue: 'Central Library',
      incidentAt: TWO_HOURS_AGO,
      contactEmail: 'loser@example.com',
      ...payload,
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function createFoundReport(payload = {}) {
  const res = await request(app)
    .post('/api/v1/reports/found')
    .field('venue', payload.venue || 'Central Library')
    .field('incidentAt', payload.incidentAt || TWO_HOURS_AGO)
    .field('contactEmail', payload.contactEmail || 'finder@example.com')
    .attach('image', await createTestImage(), { filename: 'photo.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  return res.body;
}

async function completeFoundAnalysis() {
  const claimed = await claimNextPendingReport();
  const result = await processClaimedReport(claimed, {
    analyzer: async () => ANALYZER_OUTPUT,
    aiMaxAttempts: 3,
    retryDelayMs: 100,
  });
  expect(result.outcome).toBe('completed');
}

async function matchTokensFor(matchId) {
  const records = await Notification.find({ matchId }).select('+partyMatchToken').lean();
  const byRole = {};
  for (const record of records) byRole[record.role] = record.partyMatchToken;
  return byRole;
}

// Creates a lost+found pair, completes the found analysis, and produces the
// match through the found-side trigger point.
async function setupMatchedPair() {
  const lost = await createLostReport({});
  const found = await createFoundReport({});
  await completeFoundAnalysis();
  const { created } = await matchingService.runMatchingForFoundReport(found.report.id);
  expect(created).toHaveLength(1);
  const tokens = await matchTokensFor(created[0]._id);
  return { match: created[0], tokens, lost, found };
}

describe('engine runs are idempotent', () => {
  it('creates one match and two notifications for a strong candidate pair', async () => {
    // Lost first, with no completed found report: no match may appear yet.
    await createLostReport({});
    expect(await Match.countDocuments({})).toBe(0);

    const found = await createFoundReport({});
    await completeFoundAnalysis();
    const { created } = await matchingService.runMatchingForFoundReport(found.report.id);
    expect(created).toHaveLength(1);
    expect(created[0].score).toBeGreaterThanOrEqual(55);

    const match = await Match.findOne({}).lean();
    expect(match.status).toBe('suggested');

    const notifications = await Notification.find({ matchId: match._id });
    expect(notifications).toHaveLength(2);
    // Email disabled in this test deployment → honest disabled statuses.
    for (const record of notifications) expect(record.status).toBe('disabled');

    // Re-running can never duplicate pairs or notifications.
    const rerun = await matchingService.runMatchingForFoundReport(found.report.id);
    expect(rerun.created).toHaveLength(0);
    expect(await Match.countDocuments({})).toBe(1);
    expect(await Notification.countDocuments({})).toBe(2);
  });

  it('skips candidate pairs below the configured threshold', async () => {
    await createLostReport({
      itemName: 'titanium water bottle',
      description: 'insulated steel water bottle with a flip lid',
      colors: ['silver'],
      brand: 'Yeti',
      venue: 'City Station',
      incidentAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
    });
    const found = await createFoundReport({ venue: 'Central Library' });
    await completeFoundAnalysis();

    const { created } = await matchingService.runMatchingForFoundReport(found.report.id);
    expect(created).toHaveLength(0);
    expect(await Match.countDocuments({})).toBe(0);
  });

  it('auto-matches when a lost report is created against a completed found report', async () => {
    await createFoundReport({});
    await completeFoundAnalysis(); // found-side trigger NOT invoked manually

    const res = await createLostReport({});
    expect(res.report.status).toBe('open');

    expect(await Match.countDocuments({})).toBe(1);
    const match = await Match.findOne({}).lean();
    expect(match.status).toBe('suggested');
    expect(await Notification.countDocuments({ matchId: match._id })).toBe(2);
  });
});

describe('scoped match views', () => {
  it('never exposes the counterparty contact or free text before confirmation', async () => {
    const { tokens } = await setupMatchedPair();

    const res = await request(app).get(`/api/v1/private/matches/${tokens.loser}`);
    expect(res.status).toBe(200);
    const match = res.body.match;
    expect(match.role).toBe('loser');
    expect(match.counterpartyContactEmail).toBeNull();
    expect(match.ownReport.itemName).toBe('black backpack');
    // The other side is a found report: structured attributes only, and
    // certainly no description/location free text that could embed contact
    // details.
    expect(match.otherItem).toEqual({
      reportType: 'found',
      attributes: expect.objectContaining({ primaryColor: 'black' }),
    });
    expect(match.otherItem.itemName).toBeUndefined();
    expect(match.otherItem.description).toBeUndefined();
    expect(match.actions.canReject).toBe(true);
  });

  it('shows the lost item name to the finder and reflects the finder role', async () => {
    const { tokens } = await setupMatchedPair();
    const res = await request(app).get(`/api/v1/private/matches/${tokens.finder}`);
    expect(res.status).toBe(200);
    expect(res.body.match.role).toBe('finder');
    expect(res.body.match.otherItem.itemName).toBe('black backpack');
    expect(res.body.match.counterpartyContactEmail).toBeNull();
  });

  it('returns one uninformative 404 for unknown or malformed tokens', async () => {
    await setupMatchedPair();
    const unknown = await request(app).get(`/api/v1/private/matches/${'c'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    const malformed = await request(app).get('/api/v1/private/matches/zzz');
    expect(malformed.status).toBe(404);
  });
});

describe('confirm / reject lifecycle', () => {
  it('shares contact details only after BOTH parties confirm', async () => {
    const { tokens } = await setupMatchedPair();

    const first = await request(app).post(`/api/v1/private/matches/${tokens.loser}/confirm`);
    expect(first.status).toBe(200);
    expect(first.body.match.status).toBe('suggested');
    expect(first.body.match.loserConfirmed).toBe(true);
    expect(first.body.match.counterpartyContactEmail).toBeNull();

    const lostBefore = await Report.findOne({ reportType: 'lost' }).lean();
    expect(lostBefore.status).toBe('open');

    const second = await request(app).post(`/api/v1/private/matches/${tokens.finder}/confirm`);
    expect(second.status).toBe(200);
    expect(second.body.match.status).toBe('confirmed');
    expect(second.body.match.counterpartyContactEmail).toBe('loser@example.com');

    const records = await Notification.find({ type: 'contacts_shared' });
    expect(records).toHaveLength(2);

    const lost = await Report.findOne({ reportType: 'lost' }).lean();
    const found = await Report.findOne({ reportType: 'found' }).lean();
    expect(lost.status).toBe('matched');
    expect(found.status).toBe('matched');

    // Idempotent re-confirmation stays valid.
    const again = await request(app).post(`/api/v1/private/matches/${tokens.finder}/confirm`);
    expect(again.status).toBe(200);
    expect(again.body.match.status).toBe('confirmed');
  });

  it('rejects the match, keeps both reports open, and cancels pending notifications', async () => {
    const { match, tokens } = await setupMatchedPair();
    await Notification.create({
      matchId: match._id,
      role: 'finder',
      type: 'contacts_shared',
      idempotencyKey: `${match._id}:finder:contacts_shared`,
      toEmail: 'finder@example.com',
      status: 'pending',
    });

    const rejected = await request(app).post(`/api/v1/private/matches/${tokens.loser}/reject`);
    expect(rejected.status).toBe(200);
    expect(rejected.body.match.status).toBe('rejected');

    const cancelled = await Notification.findOne({ idempotencyKey: `${match._id}:finder:contacts_shared` });
    expect(cancelled.status).toBe('cancelled');

    const lost = await Report.findOne({ reportType: 'lost' }).lean();
    expect(lost.status).toBe('open');

    const confirmAfter = await request(app).post(`/api/v1/private/matches/${tokens.finder}/confirm`);
    expect(confirmAfter.status).toBe(409);
    expect(confirmAfter.body.error.code).toBe('MATCH_STATE_INVALID');
  });

  it('refuses confirmation when a related report is no longer active', async () => {
    const { tokens, lost } = await setupMatchedPair();

    // Closing the lost report resolves the suggested match as well.
    const closeRes = await request(app).post(`/api/v1/private/reports/${lost.accessToken}/close`);
    expect(closeRes.status).toBe(200);

    const confirmAfter = await request(app).post(`/api/v1/private/matches/${tokens.finder}/confirm`);
    expect(confirmAfter.status).toBe(409);
    expect(confirmAfter.body.error.code).toBe('MATCH_STATE_INVALID');
  });
});

describe('report closure', () => {
  it('closes via private token, resolves the confirmed match, and is idempotent', async () => {
    const { match, tokens, lost } = await setupMatchedPair();
    await request(app).post(`/api/v1/private/matches/${tokens.loser}/confirm`);
    await request(app).post(`/api/v1/private/matches/${tokens.finder}/confirm`);

    const closeOne = await request(app).post(`/api/v1/private/reports/${lost.accessToken}/close`);
    expect(closeOne.status).toBe(200);
    expect(closeOne.body.report.status).toBe('closed');

    const matchAfter = await Match.findById(match._id).lean();
    expect(matchAfter.status).toBe('resolved');

    const closeAgain = await request(app).post(`/api/v1/private/reports/${lost.accessToken}/close`);
    expect(closeAgain.status).toBe(200);
    expect(closeAgain.body.report.status).toBe('closed');

    const unknown = await request(app).post(`/api/v1/private/reports/${'c'.repeat(43)}/close`);
    expect(unknown.status).toBe(404);
  });
});

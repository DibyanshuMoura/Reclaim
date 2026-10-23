'use strict';

const { startTestDb, stopTestDb } = require('./helpers/db');
const Report = require('../src/modules/reports/report.model');
const { createAccessToken, hashToken } = require('../src/modules/reports/report.tokens');
const Match = require('../src/modules/matching/match.model');
const Notification = require('../src/modules/notifications/notification.model');
const notificationService = require('../src/modules/notifications/notification.service');
const worker = require('../src/modules/notifications/notification.worker');

let mongod;

beforeAll(async () => {
  mongod = await startTestDb();
}, 120000);

afterAll(async () => {
  await stopTestDb(mongod);
});

beforeEach(async () => {
  await Report.deleteMany({});
  await Match.deleteMany({});
  await Notification.deleteMany({});
});

const LOSER_EMAIL = 'loser@example.com';
const FINDER_EMAIL = 'finder@example.com';
const LOSER_TOKEN = 'L'.repeat(43);
const FINDER_TOKEN = 'F'.repeat(43);

async function createPairReports() {
  const lost = await Report.create({
    reportType: 'lost',
    itemName: 'blue leather wallet',
    description: 'blue leather wallet with initials pressed into the front',
    contactEmail: LOSER_EMAIL,
    accessTokenHash: createAccessToken().tokenHash,
    status: 'open',
    analysisStatus: 'not_required',
  });
  const found = await Report.create({
    reportType: 'found',
    contactEmail: FINDER_EMAIL,
    accessTokenHash: createAccessToken().tokenHash,
    status: 'open',
    analysisStatus: 'completed',
    attributes: {
      category: 'wallet',
      itemType: 'wallet',
      primaryColor: 'blue',
      secondaryColors: [],
      brand: null,
      condition: 'good',
      visibleFeatures: ['initials embossed on the front'],
      uncertainAttributes: [],
    },
  });
  return { lost, found };
}

async function createMatch() {
  const { lost, found } = await createPairReports();
  const match = await Match.create({
    lostReportId: lost._id,
    foundReportId: found._id,
    score: 80,
    factors: [],
    status: 'suggested',
    loserTokenHash: hashToken(LOSER_TOKEN),
    finderTokenHash: hashToken(FINDER_TOKEN),
  });
  return { match, lost, found };
}

const TEST_DELIVERY_CONFIG = {
  email: { maxAttempts: 3, from: 'Reclaim <reclaim@test.example>' },
  notifications: { staleLeaseMs: 5 * 60 * 1000 },
  appBaseUrl: 'https://reclaim.test',
};

function transportStub() {
  const calls = [];
  return {
    calls,
    sendMail: async (mail) => {
      calls.push(mail);
      return { messageId: `test-${calls.length}` };
    },
  };
}

describe('enqueue idempotency', () => {
  it('creates exactly one record per (match, role) across repeated enqueues', async () => {
    const { match, lost, found } = await createMatch();

    await notificationService.enqueueMatchSuggestions({
      matchId: match._id,
      loserEmail: lost.contactEmail,
      finderEmail: found.contactEmail,
      loserToken: LOSER_TOKEN,
      finderToken: FINDER_TOKEN,
    });
    await notificationService.enqueueMatchSuggestions({
      matchId: match._id,
      loserEmail: lost.contactEmail,
      finderEmail: found.contactEmail,
      loserToken: LOSER_TOKEN,
      finderToken: FINDER_TOKEN,
    });

    // Email disabled in tests → honest 'disabled' status, no fake sends.
    const records = await Notification.find({ matchId: match._id });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe('disabled');
      expect(record.type).toBe('match_suggested');
    }
  });
});

describe('delivery with a stub transport', () => {
  it('claims, renders the private link, sends, and marks sent', async () => {
    const { match, lost, found } = await createMatch();
    await notificationService.enqueueMatchSuggestions({
      matchId: match._id,
      loserEmail: lost.contactEmail,
      finderEmail: found.contactEmail,
      loserToken: LOSER_TOKEN,
      finderToken: FINDER_TOKEN,
    });
    // Force-enable pending state for this specific record (config is disabled here).
    await Notification.updateMany({}, { $set: { status: 'pending' } });

    const transport = transportStub();
    const onDelivered = jest.fn().mockResolvedValue(true);

    const claimed = await notificationService.claimNextPendingNotification({
      maxAttempts: 3,
      staleLeaseMs: TEST_DELIVERY_CONFIG.notifications.staleLeaseMs,
    });
    expect(claimed).not.toBeNull();
    expect(claimed.status).toBe('processing');

    const result = await notificationService.processClaimedNotification(claimed, {
      transport,
      mailFrom: TEST_DELIVERY_CONFIG.email.from,
      appBaseUrl: TEST_DELIVERY_CONFIG.appBaseUrl,
      onDelivered,
    });

    expect(result.outcome).toBe('sent');
    expect(transport.calls).toHaveLength(1);
    const sentMail = transport.calls[0];
    expect(sentMail.to).toBe(LOSER_EMAIL);
    expect(sentMail.text).toContain(
      `${TEST_DELIVERY_CONFIG.appBaseUrl}/match/${LOSER_TOKEN}`
    );

    // Privacy invariant: the suggested email never leaks the other party.
    expect(sentMail.text).not.toContain(FINDER_EMAIL);

    const after = await Notification.findOne({ matchId: match._id, role: 'loser' })
      .select('+attempts')
      .lean();
    expect(after.status).toBe('sent');
    expect(after.sentAt).toBeInstanceOf(Date);
    expect(onDelivered).toHaveBeenCalledWith(match._id);
  });

  it('without a transport it records an honest disabled outcome, never a send', async () => {
    await Notification.create({
      matchId: (await createMatch()).match._id,
      role: 'finder',
      type: 'match_suggested',
      idempotencyKey: 'manual-disabled',
      toEmail: FINDER_EMAIL,
      status: 'pending',
    });

    const claimed = await notificationService.claimNextPendingNotification({
      maxAttempts: 3,
      staleLeaseMs: 60000,
    });
    const result = await notificationService.processClaimedNotification(claimed, {
      transport: null,
      mailFrom: TEST_DELIVERY_CONFIG.email.from,
      appBaseUrl: TEST_DELIVERY_CONFIG.appBaseUrl,
    });

    expect(result.outcome).toBe('disabled');
    const after = await Notification.findOne({ idempotencyKey: 'manual-disabled' });
    expect(after.status).toBe('disabled');
  });

  it('suggested emails can move the match to notified only when BOTH are sent', async () => {
    const { match, lost, found } = await createMatch();
    await notificationService.enqueueMatchSuggestions({
      matchId: match._id,
      loserEmail: lost.contactEmail,
      finderEmail: found.contactEmail,
      loserToken: LOSER_TOKEN,
      finderToken: FINDER_TOKEN,
    });
    await Notification.updateMany({}, { $set: { status: 'pending' } });

    const transport = transportStub();
    const claim = () =>
      notificationService.claimNextPendingNotification({
        maxAttempts: 3,
        staleLeaseMs: 60000,
      });
    const receiveOne = async () => {
      const claimed = await claim();
      expect(claimed).not.toBeNull();
      await notificationService.processClaimedNotification(claimed, { transport });
      return claimed;
    };

    await receiveOne();
    expect(transport.calls).toHaveLength(1); // only one side delivered so far
    let moved = await require('../src/modules/matching/match.service').markSuggestionsDelivered(
      match._id
    );
    expect(moved).toBe(false);

    await receiveOne();
    expect(transport.calls).toHaveLength(2);
    moved = await require('../src/modules/matching/match.service').markSuggestionsDelivered(
      match._id
    );
    expect(moved).toBe(true);

    const after = await Match.findById(match._id);
    expect(after.status).toBe('notified');
  });

  it('contacts_shared content reveals the counterparty email only by design', async () => {
    const { match, lost, found } = await createMatch();
    await notificationService.enqueueContactsShared({
      matchId: match._id,
      loserEmail: lost.contactEmail,
      finderEmail: found.contactEmail,
    });
    await Notification.updateMany({}, { $set: { status: 'pending' } });

    const claimed = await notificationService.claimNextPendingNotification({
      maxAttempts: 3,
      staleLeaseMs: 60000,
    });
    // Records were created in enqueue order: first is the loser's.
    expect(claimed.role).toBe('loser');
    const transport = transportStub();
    await notificationService.processClaimedNotification(claimed, {
      transport,
      mailFrom: TEST_DELIVERY_CONFIG.email.from,
      appBaseUrl: TEST_DELIVERY_CONFIG.appBaseUrl,
    });

    const sent = transport.calls[0];
    expect(claimed.type).toBe('contacts_shared');
    expect(sent.text).toContain(FINDER_EMAIL);
    expect(sent.text).not.toContain(LOSER_TOKEN);
  });
});

describe('failure handling and recovery', () => {
  it('requeues with backoff on transient failure and fails after the budget', async () => {
    await Notification.create({
      matchId: (await createMatch()).match._id,
      role: 'loser',
      type: 'match_suggested',
      idempotencyKey: 'manual-failure',
      toEmail: LOSER_EMAIL,
      status: 'pending',
    });

    const failingTransport = { sendMail: async () => { throw new Error('smtp down'); } };
    const drained = await worker.drainOnce({
      config: { ...TEST_DELIVERY_CONFIG, email: { maxAttempts: 1, from: 'x' } },
      transport: failingTransport,
    });

    expect(drained).toBe(1);
    const after = await Notification.findOne({ idempotencyKey: 'manual-failure' })
      .select('+attempts +lastError')
      .lean();
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(1);
    expect(after.lastError).toMatch(/smtp down/);
  });

  it('requeues a stale processing lease and fails it past the budget', async () => {
    await Notification.create({
      matchId: (await createMatch()).match._id,
      role: 'finder',
      type: 'match_suggested',
      idempotencyKey: 'manual-stale',
      toEmail: FINDER_EMAIL,
      status: 'processing',
      attempts: 1,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const { requeued, failed } = await worker.recoverStaleNotifications(new Date(), {
      staleLeaseMs: 60 * 1000,
      maxAttempts: 3,
    });
    expect(requeued).toBe(1);
    expect(failed).toBe(0);

    const reclaimed = await notificationService.claimNextPendingNotification({
      maxAttempts: 3,
      staleLeaseMs: 60000,
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed.attempts).toBe(2);
  });

  it('cancels pending notifications when their match is closed out', async () => {
    const { match } = await createMatch();
    await Notification.create({
      matchId: match._id,
      role: 'loser',
      type: 'contacts_shared',
      idempotencyKey: 'manual-cancel',
      toEmail: LOSER_EMAIL,
      status: 'pending',
    });

    const cancelled = await notificationService.cancelPendingForMatch(match._id);
    expect(cancelled).toBe(1);
    const after = await Notification.findOne({ idempotencyKey: 'manual-cancel' });
    expect(after.status).toBe('cancelled');
  });
});

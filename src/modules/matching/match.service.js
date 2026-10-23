'use strict';

/**
 * Matching engine + match lifecycle (AGENT.md §7, §8, §2).
 *
 * Deterministic scoring (`scorePair`):
 * - Pure function, unit-testable, weights injectable (config otherwise).
 * - Factor scores live in [-1, 1]: missing data is NEUTRAL (never positive),
 *   and conflicting, confidently known attributes are negative.
 * - Weights are normalized internally; the total maps to 0..100.
 *
 * Idempotency: the unique (lost, found) pair index means a match between
 * the same two reports is created exactly once, no matter how many times
 * the engine runs; notifications share the same property via unique keys.
 *
 * Privacy (AGENT.md §2):
 * - Match views never include the counterparty's description or any
 *   free-text field that could embed contact details; confirmation by BOTH
 *   parties is required before a contact email is revealed.
 * - Per-party match tokens exist so either party gets an unguessable link;
 *   only hashes are stored for them.
 */
const Report = require('../reports/report.model');
const { ReportStatus, AnalysisStatus } = require('../reports/report.statuses');
const { createAccessToken, hashToken, isValidTokenFormat } = require('../reports/report.tokens');
const Match = require('./match.model');
const Notification = require('../notifications/notification.model');
const notificationService = require('../notifications/notification.service');
const { loadConfig } = require('../../config/env');
const { ApiError } = require('../../utils/errors');
const logger = require('../../utils/logger');

const FACTOR_LABELS = Object.freeze({
  category: 'Item type',
  colors: 'Colors',
  brand: 'Brand',
  text: 'Description detail',
  venue: 'Venue',
  time: 'Event time',
});

/** Lowercased alphanumeric tokens, len>=2, bounded count. */
function tokenize(value, maxTokens = 60) {
  if (typeof value !== 'string') return [];
  const matches = value.toLowerCase().match(/[a-z0-9]+/g) || [];
  return matches.filter((token) => token.length >= 2).slice(0, maxTokens);
}

function sharedTokenCount(tokensA, tokensB) {
  const setB = new Set(tokensB);
  let shared = 0;
  for (const token of new Set(tokensA)) {
    if (setB.has(token)) shared += 1;
  }
  return shared;
}

/** Overlap coefficient |A∩B| / min(|A|,|B|); 0 when either side is empty. */
function overlapCoefficient(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  return sharedTokenCount(tokensA, tokensB) / Math.min(tokensA.length, tokensB.length);
}

function normalizeWeights(weights) {
  const entries = Object.entries(weights || {});
  const total = entries.reduce((sum, [, value]) => sum + (Number.isFinite(value) ? value : 0), 0);
  if (total <= 0) return null;
  const normalized = {};
  for (const [key, value] of entries) normalized[key] = (Number.isFinite(value) ? value : 0) / total;
  return normalized;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function asTime(value) {
  if (!value) return NaN;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : NaN;
}

function pickFoundAttributes(found) {
  const attrs = found.attributes || {};
  return {
    category: attrs.category ?? null,
    itemType: attrs.itemType ?? null,
    primaryColor: attrs.primaryColor ?? null,
    brand: attrs.brand ?? null,
    condition: attrs.condition ?? null,
  };
}

/**
 * Scores one (lost, found) pair deterministically. `found` must be a found
 * report (attributes from image analysis); `lost` a lost report (free-text
 * descriptors). Returns { score 0..100, factors }.
 */
function scorePair(lost, found, weightsArg) {
  const normalized = normalizeWeights(weightsArg || loadConfig().matching.weights);
  const factors = [];
  let weightedSum = 0;

  const lostColors = (lost.colors || []).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  const foundColors = [
    found.attributes && found.attributes.primaryColor,
    ...((found.attributes && found.attributes.secondaryColors) || []),
  ]
    .map((c) => (c ? String(c).trim().toLowerCase() : ''))
    .filter(Boolean);

  const lostBrand = lost.brand ? String(lost.brand).trim().toLowerCase() : '';
  const foundBrand =
    found.attributes && found.attributes.brand ? String(found.attributes.brand).trim().toLowerCase() : '';

  const lostVenue = lost.venue ? String(lost.venue).trim().toLowerCase() : '';
  const foundVenue = found.venue ? String(found.venue).trim().toLowerCase() : '';

  const lostTime = asTime(lost.incidentAt);
  const foundTime = asTime(found.incidentAt);

  function addFactor(key, score, description) {
    factors.push({ key, label: FACTOR_LABELS[key], score: round2(score), description });
    if (normalized && normalized[key]) weightedSum += normalized[key] * score;
  }

  // --- Category: found structured attributes vs lost free text. ---
  const foundCategoryTokens = tokenize(
    [
      found.attributes && found.attributes.category,
      found.attributes && found.attributes.itemType,
    ]
      .filter(Boolean)
      .join(' ')
  );
  const lostNameTokens = tokenize(lost.itemName || '');
  const lostDescriptionTokens = tokenize(lost.description || '');
  if (foundCategoryTokens.length === 0 || (lostNameTokens.length === 0 && lostDescriptionTokens.length === 0)) {
    addFactor('category', 0, 'Item type could not be compared (missing data)');
  } else if (sharedTokenCount(foundCategoryTokens, lostNameTokens) > 0) {
    addFactor('category', 1, 'The item type in the photo matches the lost item name clearly');
  } else if (sharedTokenCount(foundCategoryTokens, lostDescriptionTokens) > 0) {
    addFactor('category', 0.5, 'The item type appears in the lost report description');
  } else {
    addFactor('category', 0, 'The item type in the photo does not match the lost item text');
  }

  // --- Colors: reported lost colors vs photo-derived colors. ---
  if (lostColors.length > 0 && foundColors.length > 0) {
    const intersects = lostColors.some((lostColor) =>
      foundColors.some((foundColor) => foundColor === lostColor)
    );
    if (intersects) {
      addFactor('colors', 1, `Reported colors overlap: ${lostColors.filter((c) => foundColors.includes(c)).join(', ')}`);
    } else {
      // Confidently known and disjoint — a real negative signal.
      addFactor('colors', -0.4, 'The colors described in the lost report differ from the photo');
    }
  } else {
    addFactor('colors', 0, 'Colors could not be compared (missing data)');
  }

  // --- Brand: only meaningful when both sides state one. ---
  if (lostBrand && foundBrand) {
    if (lostBrand === foundBrand) {
      addFactor('brand', 1, 'Both reports carry the same brand');
    } else {
      addFactor('brand', -0.5, 'The reports carry different brands');
    }
  } else {
    addFactor('brand', 0, 'Brand could not be compared (missing data)');
  }

  // --- Description detail: lost free text vs found photo-derived text. ---
  const lostTextTokens = tokenize(
    [lost.description, lost.locationDescription].filter(Boolean).join(' ')
  );
  const foundTextTokens = tokenize(
    [
      found.attributes && (found.attributes.visibleFeatures || []).join(' '),
      found.locationDescription,
    ]
      .filter(Boolean)
      .join(' ')
  );
  if (lostTextTokens.length === 0 || foundTextTokens.length === 0) {
    addFactor('text', 0, 'No comparable descriptive detail (missing data)');
  } else {
    const ratio = overlapCoefficient(lostTextTokens, foundTextTokens);
    if (ratio >= 0.4) {
      addFactor('text', ratio, 'Descriptions include several shared details');
    } else if (ratio > 0) {
      addFactor('text', ratio, 'Descriptions share a little wording');
    } else {
      addFactor('text', 0, 'Descriptions do not share wording');
    }
  }

  // --- Venue: same, partial, or different. ---
  if (lostVenue && foundVenue) {
    if (lostVenue === foundVenue) {
      addFactor('venue', 1, 'Both reports name the same venue');
    } else if (lostVenue.includes(foundVenue) || foundVenue.includes(lostVenue)) {
      addFactor('venue', 0.8, 'The venues overlap');
    } else {
      addFactor('venue', -0.2, 'The reports name different venues');
    }
  } else {
    addFactor('venue', 0, 'Venue could not be compared (missing data)');
  }

  // --- Time proximity between the two incident times. ---
  if (Number.isFinite(lostTime) && Number.isFinite(foundTime)) {
    const hours = Math.abs(lostTime - foundTime) / 3600000;
    if (hours <= 24) {
      addFactor('time', 1, 'The events happened within about a day of each other');
    } else if (hours <= 72) {
      addFactor('time', 0.6, 'The events happened within about three days of each other');
    } else if (hours <= 7 * 24) {
      addFactor('time', 0.3, 'The events happened within about a week of each other');
    } else {
      addFactor('time', -0.3, 'The event dates are far apart');
    }
  } else {
    addFactor('time', 0, 'Event time could not be compared (missing data)');
  }

  const score = Math.max(0, Math.min(100, Math.round(weightedSum * 100)));
  return { score, factors };
}

/**
 * Creates one match pair idempotently. Returns null if the pair already
 * exists (matched before); otherwise returns the match document plus the
 * raw per-party tokens (transient — only hashes persist).
 */
async function createMatchIdempotent({ lost, found, score, factors }) {
  const loser = createAccessToken();
  const finder = createAccessToken();
  try {
    const match = await Match.create({
      lostReportId: lost._id,
      foundReportId: found._id,
      score: Math.round(score),
      factors,
      status: Match.MatchStatus.SUGGESTED,
      loserTokenHash: loser.tokenHash,
      finderTokenHash: finder.tokenHash,
    });
    return { match, loserToken: loser.token, finderToken: finder.token };
  } catch (error) {
    if (error && error.code === 11000) {
      logger.info('Match pair already exists; skipping duplicate creation', {
        lostReportId: String(lost._id),
        foundReportId: String(found._id),
      });
      return null;
    }
    throw error;
  }
}

async function runMatchingForLostReport(lostReportId) {
  const config = loadConfig();
  const lost = await Report.findById(lostReportId).select('+contactEmail').lean();
  if (!lost || lost.reportType !== 'lost') return { created: [], skipped: 'not_found' };
  if (lost.status !== ReportStatus.OPEN) return { created: [], skipped: 'report_not_open' };

  const candidates = await Report.find({
    reportType: 'found',
    status: ReportStatus.OPEN,
    analysisStatus: AnalysisStatus.COMPLETED,
  })
    .sort({ createdAt: 1 })
    .limit(config.matching.candidateLimit)
    .select('+contactEmail')
    .lean();

  const created = [];
  for (const found of candidates) {
    const { score, factors } = scorePair(lost, found, config.matching.weights);
    if (score < config.matching.notifyThreshold) continue;
    const createdMatch = await createMatchIdempotent({ lost, found, score, factors });
    if (!createdMatch) continue;
    created.push(createdMatch.match);
    try {
      await notificationService.enqueueMatchSuggestions({
        matchId: createdMatch.match._id,
        loserEmail: lost.contactEmail,
        finderEmail: found.contactEmail,
        loserToken: createdMatch.loserToken,
        finderToken: createdMatch.finderToken,
      });
    } catch (error) {
      logger.error('Notification enqueue failed for new match', {
        matchId: String(createdMatch.match._id),
        reason: error && error.message,
      });
    }
  }
  return { created, skipped: null };
}

async function runMatchingForFoundReport(foundReportId) {
  const config = loadConfig();
  const found = await Report.findById(foundReportId).select('+contactEmail').lean();
  if (!found || found.reportType !== 'found') return { created: [], skipped: 'not_found' };
  if (found.status !== ReportStatus.OPEN) return { created: [], skipped: 'report_not_open' };
  if (found.analysisStatus !== AnalysisStatus.COMPLETED || !found.attributes) {
    return { created: [], skipped: 'analysis_incomplete' };
  }

  const candidates = await Report.find({ reportType: 'lost', status: ReportStatus.OPEN })
    .sort({ createdAt: 1 })
    .limit(config.matching.candidateLimit)
    .select('+contactEmail')
    .lean();

  const created = [];
  for (const lost of candidates) {
    const { score, factors } = scorePair(lost, found, config.matching.weights);
    if (score < config.matching.notifyThreshold) continue;
    const createdMatch = await createMatchIdempotent({ lost, found, score, factors });
    if (!createdMatch) continue;
    created.push(createdMatch.match);
    try {
      await notificationService.enqueueMatchSuggestions({
        matchId: createdMatch.match._id,
        loserEmail: lost.contactEmail,
        finderEmail: found.contactEmail,
        loserToken: createdMatch.loserToken,
        finderToken: createdMatch.finderToken,
      });
    } catch (error) {
      logger.error('Notification enqueue failed for new match', {
        matchId: String(createdMatch.match._id),
        reason: error && error.message,
      });
    }
  }
  return { created, skipped: null };
}

async function resolveMatchByToken(rawToken) {
  if (!isValidTokenFormat(rawToken)) return null;
  const hash = hashToken(rawToken);
  const match = await Match.findOne({
    $or: [{ loserTokenHash: hash }, { finderTokenHash: hash }],
  }).select('+loserTokenHash +finderTokenHash');
  if (!match) return null;
  const role = match.loserTokenHash === hash ? 'loser' : 'finder';
  return { match, role };
}

async function loadPairReports(match) {
  const [lost, found] = await Promise.all([
    Report.findById(match.lostReportId).select('+contactEmail').lean(),
    Report.findById(match.foundReportId).select('+contactEmail').lean(),
  ]);
  if (!lost || !found) throw ApiError.notFound('Report not found');
  return { lost, found };
}

function buildMatchView(match, role, lost, found) {
  const status = match.status;
  const confirmed = status === Match.MatchStatus.CONFIRMED;
  const active = status === Match.MatchStatus.SUGGESTED || status === Match.MatchStatus.NOTIFIED;
  const ownConfirmed =
    role === 'loser' ? Boolean(match.loserConfirmedAt) : Boolean(match.finderConfirmedAt);
  const bothReportsActive =
    [lost.status, found.status].every((s) => s === ReportStatus.OPEN || s === ReportStatus.MATCHED);

  return {
    id: String(match._id),
    status,
    score: match.score,
    role,
    createdAt: match.createdAt || null,
    ownReport:
      role === 'loser'
        ? { reportType: 'lost', itemName: lost.itemName, status: lost.status }
        : { reportType: 'found', status: found.status, attributes: pickFoundAttributes(found) },
    otherItem:
      role === 'loser'
        ? // Free text is deliberately EXCLUDED — it may embed contact details.
          { reportType: 'found', attributes: pickFoundAttributes(found) }
        : { reportType: 'lost', itemName: lost.itemName },
    factors: match.factors || [],
    loserConfirmed: Boolean(match.loserConfirmedAt),
    finderConfirmed: Boolean(match.finderConfirmedAt),
    // Contact details are shared ONLY after both parties confirmed.
    counterpartyContactEmail: confirmed
      ? role === 'loser'
        ? found.contactEmail
        : lost.contactEmail
      : null,
    actions: {
      canConfirm: active && !ownConfirmed && bothReportsActive,
      canReject: active,
    },
  };
}

async function getMatchViewByToken(rawToken) {
  const resolved = await resolveMatchByToken(rawToken);
  if (!resolved) throw ApiError.notFound('Match not found');
  const { lost, found } = await loadPairReports(resolved.match);
  return buildMatchView(resolved.match, resolved.role, lost, found);
}

/**
 * One party confirms. When BOTH have confirmed (guarded transaction-free
 * sequence, idempotent by design): match → confirmed, both open reports →
 * matched, and the contacts-shared notifications are enqueued.
 */
async function confirmMatchByToken(rawToken) {
  const resolved = await resolveMatchByToken(rawToken);
  if (!resolved) throw ApiError.notFound('Match not found');
  const { match, role } = resolved;

  const { lost, found } = await loadPairReports(match);

  if (match.status === Match.MatchStatus.CONFIRMED) {
    return buildMatchView(match, role, lost, found); // idempotent
  }
  if (
    match.status !== Match.MatchStatus.SUGGESTED &&
    match.status !== Match.MatchStatus.NOTIFIED
  ) {
    throw new ApiError(409, 'MATCH_STATE_INVALID', 'This match is no longer awaiting confirmation');
  }
  const reportsActive = [lost.status, found.status].every(
    (s) => s === ReportStatus.OPEN || s === ReportStatus.MATCHED
  );
  if (!reportsActive) {
    throw new ApiError(409, 'MATCH_STATE_INVALID', 'A related report is no longer active');
  }

  const flagField = role === 'loser' ? 'loserConfirmedAt' : 'finderConfirmedAt';
  await Match.updateOne(
    { _id: match._id, [flagField]: null },
    { $set: { [flagField]: new Date() } }
  );

  const freshMatch = await Match.findById(match._id).lean();
  const otherFlag =
    role === 'loser' ? freshMatch.finderConfirmedAt : freshMatch.loserConfirmedAt;

  if (otherFlag) {
    const confirmedMatch = await Match.findOneAndUpdate(
      {
        _id: match._id,
        status: { $in: [Match.MatchStatus.SUGGESTED, Match.MatchStatus.NOTIFIED] },
      },
      { $set: { status: Match.MatchStatus.CONFIRMED } },
      { returnDocument: 'after' }
    );
    if (confirmedMatch) {
      for (const report of [lost, found]) {
        if (report.status === ReportStatus.OPEN) {
          await Report.updateOne(
            { _id: report._id, status: ReportStatus.OPEN },
            { $set: { status: ReportStatus.MATCHED } }
          );
        }
      }
      try {
        await notificationService.enqueueContactsShared({
          matchId: match._id,
          loserEmail: lost.contactEmail,
          finderEmail: found.contactEmail,
        });
      } catch (error) {
        logger.error('contacts_shared enqueue failed', {
          matchId: String(match._id),
          reason: error && error.message,
        });
      }
    }
  }

  const finalMatch = await Match.findById(match._id).lean();
  const finalPair = await loadPairReports(finalMatch);
  return buildMatchView(finalMatch, role, finalPair.lost, finalPair.found);
}

/** One party rejects the match; the pair becomes terminal for both views. */
async function rejectMatchByToken(rawToken) {
  const resolved = await resolveMatchByToken(rawToken);
  if (!resolved) throw ApiError.notFound('Match not found');
  const { match, role } = resolved;

  if (match.status === Match.MatchStatus.REJECTED) {
    const { lost, found } = await loadPairReports(match);
    return buildMatchView(match, role, lost, found); // idempotent
  }
  if (
    match.status !== Match.MatchStatus.SUGGESTED &&
    match.status !== Match.MatchStatus.NOTIFIED
  ) {
    throw new ApiError(409, 'MATCH_STATE_INVALID', 'This match can no longer be rejected');
  }

  const result = await Match.updateOne(
    { _id: match._id, status: match.status },
    { $set: { status: Match.MatchStatus.REJECTED } }
  );
  if (result.matchedCount > 0) {
    // Any still-undelivered suggested emails for a rejected match are moot.
    await notificationService.cancelPendingForMatch(match._id);
  }

  const { lost, found } = await loadPairReports(
    (await Match.findById(match._id).lean())
  );
  return buildMatchView(
    await Match.findById(match._id).lean(),
    role,
    lost,
    found
  );
}

/**
 * Called when either report closes: every still-active match referencing
 * the report resolves, and its undelivered notifications are cancelled so
 * closed reports never trigger contact requests afterward.
 */
async function handleReportClosed(reportId) {
  const activeMatches = await Match.find({
    $or: [{ lostReportId: reportId }, { foundReportId: reportId }],
    status: {
      $in: [
        Match.MatchStatus.SUGGESTED,
        Match.MatchStatus.NOTIFIED,
        Match.MatchStatus.CONFIRMED,
      ],
    },
  })
    .select('_id status')
    .lean();

  let resolvedCount = 0;
  for (const match of activeMatches) {
    if (Match.canTransitionMatchStatus(match.status, Match.MatchStatus.RESOLVED)) {
      const result = await Match.updateOne(
        { _id: match._id, status: match.status },
        { $set: { status: Match.MatchStatus.RESOLVED } }
      );
      if (result.matchedCount > 0) {
        resolvedCount += 1;
        await notificationService.cancelPendingForMatch(match._id);
      }
    }
  }
  return { resolvedMatches: resolvedCount };
}

/**
 * Delivery-worker hook: when BOTH parties' suggested emails were actually
 * sent, the match moves `suggested` → `notified`. Never lies when email is
 * disabled (statuses stay `disabled`, so the match simply stays suggested).
 */
async function markSuggestionsDelivered(matchId) {
  const match = await Match.findById(matchId).select('status').lean();
  if (!match || match.status !== Match.MatchStatus.SUGGESTED) return false;
  const delivered = await Notification.countDocuments({
    matchId,
    type: 'match_suggested',
    status: 'sent',
  });
  if (delivered < 2) return false;
  const result = await Match.updateOne(
    { _id: matchId, status: Match.MatchStatus.SUGGESTED },
    { $set: { status: Match.MatchStatus.NOTIFIED } }
  );
  return result.matchedCount > 0;
}

module.exports = {
  scorePair,
  runMatchingForLostReport,
  runMatchingForFoundReport,
  getMatchViewByToken,
  confirmMatchByToken,
  rejectMatchByToken,
  handleReportClosed,
  markSuggestionsDelivered,
};

'use strict';

/**
 * Report business logic. Route handlers stay thin; all rules and persistence
 * live here (AGENT.md §4, §14).
 */
const Report = require('./report.model');
const { ReportStatus, AnalysisStatus, canTransitionLifecycle } = require('./report.statuses');
const { createAccessToken, hashToken, isValidTokenFormat } = require('./report.tokens');
const { ApiError } = require('../../utils/errors');
const { loadConfig } = require('../../config/env');
const { prepareUploadedImage } = require('../image-analysis/image.processing');
const TemporaryImage = require('../../infrastructure/temporary-images/temporary-image.model');
const {
  parseLostReportCreate,
  parseFoundReportCreate,
  formatValidationError,
} = require('./report.validation');
const { toPublicView, toPrivateView } = require('./report.mapper');
const matchingService = require('../matching/match.service');
const logger = require('../../utils/logger');

function parseOr400(result) {
  if (!result.success) {
    const { message, details } = formatValidationError(result.error);
    throw ApiError.badRequest(message, details);
  }
  return result.data;
}

function assignedFields(data, fieldNames) {
  const doc = {};
  for (const field of fieldNames) {
    if (data[field] !== undefined) {
      doc[field] = field === 'incidentAt' ? new Date(data[field]) : data[field];
    }
  }
  return doc;
}

/**
 * Validates input, persists the report, and generates the private access
 * token whose raw form is returned exactly once to the reporter.
 */
async function createLostReport(payload) {
  const data = parseOr400(parseLostReportCreate(payload));
  const { token, tokenHash } = createAccessToken();

  const report = await Report.create({
    reportType: 'lost',
    itemName: data.itemName,
    description: data.description,
    contactEmail: data.contactEmail,
    accessTokenHash: tokenHash,
    status: ReportStatus.OPEN,
    analysisStatus: AnalysisStatus.NOT_REQUIRED,
    ...assignedFields(data, ['colors', 'brand', 'venue', 'locationDescription', 'incidentAt']),
  });

  // Phase 4 matching trigger: a newly created lost report is scored against
  // already-completed found reports. This must never fail the request — the
  // report exists and can be matched again by other trigger points anyway.
  try {
    await matchingService.runMatchingForLostReport(report._id);
  } catch (matchingError) {
    logger.error('Post-creation matching failed', {
      reportId: String(report._id),
      reason: matchingError && matchingError.message,
    });
  }

  return {
    report: toPublicView(report),
    accessToken: token,
    privateReportPath: `/api/v1/private/reports/${token}`,
  };
}

/**
 * Phase 3 scope: found reports require a photo. The upload is validated and
 * decanted into a normalized compressed copy stored in the temporary
 * collection for retry durability; the report persists immediately with
 * analysisStatus `pending` and the worker picks it up. The original upload
 * bytes are dropped from memory right after the normalized copy exists.
 */
async function createFoundReport(payload, rawImage = {}) {
  const data = parseOr400(parseFoundReportCreate(payload));
  const config = loadConfig();

  const prepared = await prepareUploadedImage(rawImage.buffer, {
    maxImageBytes: config.maxImageBytes,
    maxImageWidthPx: config.imageMaxWidthPx,
  });
  // Original upload bytes are no longer needed; release the reference.
  rawImage.buffer = undefined;

  const { token, tokenHash } = createAccessToken();

  const report = await Report.create({
    reportType: 'found',
    contactEmail: data.contactEmail,
    accessTokenHash: tokenHash,
    status: ReportStatus.OPEN,
    analysisStatus: AnalysisStatus.PENDING,
    ...assignedFields(data, ['description', 'venue', 'locationDescription', 'incidentAt']),
  });

  await TemporaryImage.create({
    reportId: report._id,
    mimeType: prepared.mimeType,
    data: prepared.buffer,
    bytes: prepared.bytes,
    width: prepared.width,
    height: prepared.height,
    expiresAt: new Date(Date.now() + config.imageRetentionMs),
  });

  return {
    report: toPublicView(report),
    accessToken: token,
    privateReportPath: `/api/v1/private/reports/${token}`,
  };
}

/**
 * Resolves a report from its raw access token. Malformed or unknown tokens
 * both return null so callers can respond with one uninformative 404.
 */
async function getReportByAccessToken(rawToken) {
  if (!isValidTokenFormat(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const report = await Report.findOne({ accessTokenHash: tokenHash }).select('+contactEmail');
  return report ? toPrivateView(report) : null;
}

/**
 * Raw document lookup for flows that must mutate guarded state (e.g. image
 * re-upload). Exposes the internal hash context needed by those guards.
 */
async function getRawReportByAccessToken(rawToken) {
  if (!isValidTokenFormat(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  return Report.findOne({ accessTokenHash: tokenHash }).select('+accessTokenHash');
}

/**
 * Closes the caller's report through its private token (AGENT.md §2, §7).
 * Lifecycle transitions are validated; closing an already-closed report is
 * an idempotent no-op. When the close lands, every still-active match that
 * references the report resolves and its undelivered notifications are
 * cancelled — closed reports never trigger contact emails afterward.
 */
async function closeReportByAccessToken(rawToken) {
  if (!isValidTokenFormat(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const report = await Report.findOne({ accessTokenHash: tokenHash }).lean();
  if (!report) return null;

  if (!canTransitionLifecycle(report.status, ReportStatus.CLOSED)) {
    throw new ApiError(
      409,
      'REPORT_STATE_INVALID',
      'This report cannot be closed from its current state'
    );
  }

  const result = await Report.updateOne(
    { _id: report._id, status: report.status },
    { $set: { status: ReportStatus.CLOSED } }
  );
  if (result.matchedCount > 0) {
    try {
      await matchingService.handleReportClosed(report._id);
    } catch (matchingError) {
      logger.error('Post-close match resolution failed', {
        reportId: String(report._id),
        reason: matchingError && matchingError.message,
      });
    }
  }

  const updated = await Report.findById(report._id).lean();
  return { report: updated };
}

module.exports = {
  createLostReport,
  createFoundReport,
  getReportByAccessToken,
  getRawReportByAccessToken,
  closeReportByAccessToken,
};

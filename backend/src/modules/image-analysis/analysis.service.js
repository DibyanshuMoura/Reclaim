'use strict';

/**
 * Analysis orchestration for a single claimed report (AGENT.md §5, §6, §9).
 *
 * State discipline:
 * - The caller (worker or test harness) has already claimed the report and
 *   moved `analysisStatus` to `processing`; attempts were incremented at claim.
 * - Every state change below is guarded on the current status so recovery
 *   from a crash can never overwrite a later outcome.
 * - Attribute persistence happens BEFORE temporary-image deletion: a crash
 *   between the two steps leaves a harmless orphan (TTL cleans it) but never
 *   a lost result. Multi-document transaction support is a deployment
 *   capability AGENT.md says not to assume, so this ordering is explicit.
 */
const Report = require('../reports/report.model');
const { AnalysisStatus } = require('../reports/report.statuses');
const { GeminiPermanentError, GeminiTransientError } = require('../../infrastructure/gemini/client');
const { parseAnalysisOutput } = require('./analysis.output');
const { prepareUploadedImage } = require('./image.processing');
const TemporaryImage = require('../../infrastructure/temporary-images/temporary-image.model');
const logger = require('../../utils/logger');
const { ApiError } = require('../../utils/errors');

function boundedErrorText(errorText, max = 300) {
  const text = typeof errorText === 'string' ? errorText : String(errorText || '');
  return text.trim().slice(0, max) || 'Analysis failed';
}

/**
 * A parsed-but-informationless answer (every string null, every array
 * empty) is not a usable outcome: matching gets nothing and the user
 * would stare at an empty attributes panel. Treat it like the client's
 * empty-output case so the retry budget runs and the honest re-upload
 * state is reached.
 */
function isEntirelyEmptyAttributes(attributes) {
  return (
    !attributes.category &&
    !attributes.itemType &&
    !attributes.primaryColor &&
    !attributes.brand &&
    !attributes.condition &&
    Array.isArray(attributes.secondaryColors) && attributes.secondaryColors.length === 0 &&
    Array.isArray(attributes.visibleFeatures) && attributes.visibleFeatures.length === 0 &&
    Array.isArray(attributes.uncertainAttributes) && attributes.uncertainAttributes.length === 0
  );
}

async function persistStateGuarded(reportId, fromStatus, patch) {
  return Report.updateOne({ _id: reportId, analysisStatus: fromStatus }, { $set: patch });
}

async function loadTemporaryImage(reportId) {
  // `data` is deselected by default in the schema.
  return TemporaryImage.findOne({ reportId }).select('+data');
}

async function deleteTemporaryImage(reportId) {
  await TemporaryImage.deleteOne({ reportId });
}

/**
 * Analyzes a claimed report.
 * analyzer({ imageBase64 }) => parsed JSON object, or throws
 * GeminiPermanentError / GeminiTransientError.
 */
async function processClaimedReport(report, { analyzer, aiMaxAttempts, retryDelayMs }) {
  const reportId = report._id;
  const fromStatus = AnalysisStatus.PROCESSING;

  // Crash-safety idempotency: attributes persisted but completion never
  // recorded — finish the transition without calling the provider again.
  const existingAttributes = report.attributes;
  if (existingAttributes && Object.keys(existingAttributes).length > 0) {
    await persistStateGuarded(reportId, fromStatus, {
      analysisStatus: AnalysisStatus.COMPLETED,
      analysisError: null,
      analysisLockedAt: null,
      analysisRetryAt: null,
    });
    await deleteTemporaryImage(reportId);
    logger.info('Analysis recovered from persisted attributes', { reportId: String(reportId) });
    return { outcome: 'completed' };
  }

  const temp = await loadTemporaryImage(reportId);
  if (!temp) {
    // No image left to analyze (expired, cleaned, or never stored). The
    // report survives; the remedy is a user re-upload via the private
    // image endpoint, which also resets the retry budget.
    await deleteTemporaryImage(reportId);
    await persistStateGuarded(reportId, fromStatus, {
      analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
      analysisError: 'No image available for analysis; re-upload required',
      analysisLockedAt: null,
    });
    return { outcome: 'needs_user_action' };
  }

  // Base64 lives in a local, function-scoped variable so it is dropped from
  // memory as soon as the call finishes; it is never logged or persisted.
  const imageBase64 = temp.data.toString('base64');
  let rawOutput;
  try {
    rawOutput = await analyzer({ imageBase64 });
  } catch (analysisError) {
    // Attempt-level logging: bounded provider-independent detail only. The
    // image, its Base64 form, and full provider responses are never logged.
    logger.error('Image analysis attempt failed', {
      reportId: String(reportId),
      attempt: report.analysisAttempts,
      errorKind: analysisError.kind,
      reason: analysisError.message,
    });
    const outcome = await classifyAndRecover({
      report,
      reportId,
      fromStatus,
      aiMaxAttempts,
      retryDelayMs,
      error: analysisError,
    });
    return { outcome };
  }

  const parsed = parseAnalysisOutput(rawOutput);
  if (!parsed.ok) {
    const outcome = await classifyAndRecover({
      report,
      reportId,
      fromStatus,
      aiMaxAttempts,
      retryDelayMs,
      error: new GeminiTransientError(
        'malformed-output',
        'Vision analysis output failed server-side validation'
      ),
    });
    return { outcome, validationIssues: parsed.issues };
  }

  if (isEntirelyEmptyAttributes(parsed.attributes)) {
    const outcome = await classifyAndRecover({
      report,
      reportId,
      fromStatus,
      aiMaxAttempts,
      retryDelayMs,
      error: new GeminiTransientError(
        'empty-output',
        'The photo did not show enough visible detail to extract attributes'
      ),
    });
    return { outcome, validationIssues: ['all-attributes-empty'] };
  }

  const updateResult = await persistStateGuarded(reportId, fromStatus, {
    analysisStatus: AnalysisStatus.COMPLETED,
    attributes: parsed.attributes,
    analysisError: null,
    analysisLockedAt: null,
    analysisRetryAt: null,
  });
  if (updateResult.matchedCount === 0) {
    logger.warn('Analysis state raced during persistence; leaving the outcome to the other worker', {
      reportId: String(reportId),
    });
    return { outcome: 'raced' };
  }

  await deleteTemporaryImage(reportId);
  logger.info('Analysis completed', { reportId: String(reportId) });
  return { outcome: 'completed' };
}

/**
 * Classifies a failure and moves the report to the honest next state.
 * Permanent config problems never retry; transient ones retry only within
 * the configured attempt budget (AGENT.md §9).
 */
async function classifyAndRecover({
  report,
  reportId,
  fromStatus,
  aiMaxAttempts,
  retryDelayMs = 0,
  error,
}) {
  if (error instanceof GeminiPermanentError) {
    switch (error.kind) {
      case 'invalid-image':
      case 'blocked': {
        // The uploaded content itself cannot be analyzed; the user must
        // provide a different photo.
        await deleteTemporaryImage(reportId);
        await persistStateGuarded(reportId, fromStatus, {
          analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
          analysisError: boundedErrorText(error.message),
          analysisLockedAt: null,
        });
        return 'needs_user_action';
      }
      case 'quota': {
        // Provider-wide exhaustion; retrying would burn the budget without a
        // chance of success. Re-upload (allowed later) resets the budget.
        await persistStateGuarded(reportId, fromStatus, {
          analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
          analysisError: boundedErrorText(error.message),
          analysisLockedAt: null,
        });
        return 'needs_user_action';
      }
      case 'auth':
      case 'model':
      default: {
        // Configuration/credential problems are operator issues, not user
        // issues; retries cannot fix them.
        await persistStateGuarded(reportId, fromStatus, {
          analysisStatus: AnalysisStatus.PERMANENT_FAILED,
          analysisError: boundedErrorText(error.message),
          analysisLockedAt: null,
        });
        return 'permanent_failed';
      }
    }
  }

  // Transient: network, timeout, provider 5xx, malformed/truncated output.
  const attempts = report.analysisAttempts || 1;
  if (attempts >= aiMaxAttempts) {
    await deleteTemporaryImage(reportId);
    await persistStateGuarded(reportId, fromStatus, {
      analysisStatus: AnalysisStatus.NEEDS_USER_ACTION,
      analysisError: boundedErrorText(
        `Analysis failed after the retry budget was exhausted: ${error && error.message ? error.message : 'unknown error'}`
      ),
      analysisLockedAt: null,
    });
    return 'needs_user_action';
  }
  await persistStateGuarded(reportId, fromStatus, {
    analysisStatus: AnalysisStatus.RETRYABLE_FAILED,
    analysisRetryAt: new Date(Date.now() + retryDelayMs),
    analysisError: boundedErrorText(error && error.message),
    analysisLockedAt: null,
  });
  return 'retry_scheduled';
}

/**
 * Recovery path for reports whose analysis cannot continue without a new
 * photo: compresses the replacement upload, replaces the temporary image,
 * and re-arms the pipeline. Allowed only from `needs_user_action` and
 * `permanent_failed`. Validation happens first so a rejected upload changes
 * nothing.
 */
async function replaceReportImage(reportDoc, rawImage, { maxImageBytes, maxImageWidthPx, imageRetentionMs }) {
  const allowedFrom = [AnalysisStatus.NEEDS_USER_ACTION, AnalysisStatus.PERMANENT_FAILED];
  const prepared = await prepareUploadedImage(rawImage && rawImage.buffer, {
    maxImageBytes,
    maxImageWidthPx,
  });

  const updateResult = await Report.updateOne(
    {
      _id: reportDoc._id,
      analysisStatus: { $in: allowedFrom },
      accessTokenHash: reportDoc.accessTokenHash,
    },
    {
      $set: { analysisStatus: AnalysisStatus.PENDING, analysisAttempts: 0 },
      $unset: { analysisLockedAt: 1, analysisRetryAt: 1, analysisError: 1 },
    }
  );
  if (updateResult.matchedCount === 0) {
    throw new ApiError(409, 'ANALYSIS_NOT_RETRYABLE', 'This report is not currently awaiting a new image');
  }

  await TemporaryImage.deleteOne({ reportId: reportDoc._id });
  await TemporaryImage.create({
    reportId: reportDoc._id,
    mimeType: prepared.mimeType,
    data: prepared.buffer,
    bytes: prepared.bytes,
    width: prepared.width,
    height: prepared.height,
    expiresAt: new Date(Date.now() + imageRetentionMs),
  });

  return Report.findById(reportDoc._id).lean();
}

module.exports = {
  processClaimedReport,
  classifyAndRecover,
  replaceReportImage,
  deleteTemporaryImage,
};

'use strict';

/**
 * Centralized error formatting (AGENT.md §10).
 *
 * Responses are a consistent JSON envelope and never include stack traces,
 * database details, provider errors, or request payloads. Full errors are
 * logged server-side only, without request bodies.
 */
const { ApiError } = require('../utils/errors');
const logger = require('../utils/logger');
const { loadConfig } = require('../config/env');
const multer = require('multer');

function errorResponse(code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  return { error };
}

/**
 * Maps known error classes to a status code and response body. Anything
 * unrecognized is treated as an internal error and logged server-side.
 */
function classifyError(err) {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      response: errorResponse(err.code, err.message, err.details),
    };
  }
  if (err && err.type === 'entity.too.large') {
    return {
      statusCode: 413,
      response: errorResponse('PAYLOAD_TOO_LARGE', 'Request body is too large'),
    };
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return {
        statusCode: 413,
        response: errorResponse('PAYLOAD_TOO_LARGE', 'Image exceeds the configured size limit'),
      };
    }
    return {
      statusCode: 400,
      response: errorResponse('MULTIPART_INVALID', 'Invalid multipart upload'),
    };
  }
  if (
    err &&
    (err.type === 'entity.parse.failed' ||
      (err instanceof SyntaxError && err.status === 400 && 'body' in err))
  ) {
    return {
      statusCode: 400,
      response: errorResponse('INVALID_JSON', 'Request body must be valid JSON'),
    };
  }
  return null;
}

function errorHandler(err, _req, res, _next) {
  const classified = classifyError(err);

  if (!classified) {
    let nodeEnv = null;
    try {
      nodeEnv = loadConfig().nodeEnv;
    } catch {
      // Config may itself be unavailable during startup failures.
    }
    logger.error('Unhandled error', {
      reason: err && err.message ? err.message : String(err),
      stack: nodeEnv === 'production' ? undefined : err && err.stack,
    });
  }

  const { statusCode, response } = classified || {
    statusCode: 500,
    response: errorResponse('INTERNAL_ERROR', 'Internal server error'),
  };

  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(statusCode).json(response);
}

function notFoundHandler(_req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
}

module.exports = { errorHandler, notFoundHandler };

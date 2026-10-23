'use strict';

/**
 * HTTP-aware error type so route handlers and services can produce
 * consistent error responses without leaking internals (AGENT.md §10).
 */
class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message, details) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }

  static notFound(message) {
    return new ApiError(404, 'NOT_FOUND', message);
  }
}

module.exports = { ApiError };

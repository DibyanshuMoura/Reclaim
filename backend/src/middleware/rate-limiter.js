'use strict';

/**
 * Per-IP rate limiting for public endpoints (AGENT.md §10).
 *
 * Express-rate-limit's in-memory store is per-process; acceptable for a
 * single-instance MVP documented in the README. If the deployment ever runs
 * multiple instances, the store must become shared (e.g. Redis) or limits
 * will be counted per instance.
 */
const rateLimit = require('express-rate-limit');

function createRateLimiters(config) {
  const build = (limit) =>
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      limit,
      standardHeaders: true,
      legacyHeaders: false,
      handler(_req, res) {
        res.status(429).json({
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests, please try again later.',
          },
        });
      },
    });

  return {
    apiLimiter: build(config.rateLimit.max),
    reportCreateLimiter: build(config.rateLimit.reportCreateMax),
  };
}

module.exports = { createRateLimiters };

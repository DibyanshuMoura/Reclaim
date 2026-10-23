'use strict';

/**
 * Central environment configuration (AGENT.md §11).
 *
 * Reads process.env and validates required variables at first use so the
 * server fails fast with a clear, non-secret error message. Values are never
 * logged or stringified anywhere; only names of missing variables are reported.
 */
function required(name) {
  const value = process.env[name];
  if (value == null || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer`);
  }
  return parsed;
}

function csvList(name) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const items = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function floatInRange(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function intInRange(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// Optional-with-validation variant: unset is null (feature off), a set value
// must be a positive integer or startup fails fast.
function positiveIntOrNull(name) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name}, when set, must be a positive integer`);
  }
  return parsed;
}

let cached = null;

function loadConfig() {
  if (cached) return cached;

  const port = positiveInt('PORT', 5000);
  const aiJobTimeoutMs = positiveInt('AI_JOB_TIMEOUT_MS', 120000);
  const emailEnabled = bool('EMAIL_ENABLED', false);

  cached = Object.freeze({
    nodeEnv: process.env.NODE_ENV || 'development',
    port,
    mongoUri: required('MONGODB_URI'),
    // Used to build links returned to reporters (their private report URL).
    appBaseUrl: (process.env.APP_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    // null means allow all origins. The API uses no cookies or credentials,
    // so wildcard is safe; list intended origins in production via
    // APP_CORS_ORIGINS (comma-separated).
    corsOrigins: csvList('APP_CORS_ORIGINS'),
    // Number of reverse-proxy hops in front of this process (APP_CORS-style
    // opt-in, TRUST_PROXY=1 behind exactly one nginx/Render/Railway). Unset
    // means direct exposure: the per-IP rate limits must NEVER trust the
    // (spoofable) X-Forwarded-For header in that case.
    trustProxy: positiveIntOrNull('TRUST_PROXY'),
    logLevel: process.env.LOG_LEVEL || 'info',
    rateLimit: Object.freeze({
      windowMs: positiveInt('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      max: positiveInt('RATE_LIMIT_MAX', 100),
      reportCreateMax: positiveInt('REPORT_RATE_LIMIT_MAX', 10),
    }),
    // --- Image handling (AGENT.md §5) ---
    maxImageBytes: positiveInt('MAX_IMAGE_BYTES', 5242880),
    imageRetentionMs: positiveInt('IMAGE_RETENTION_HOURS', 24) * 60 * 60 * 1000,
    // Compressed images are decanted to at most this pixel width before
    // being sent for analysis; the height follows the aspect ratio.
    imageMaxWidthPx: positiveInt('IMAGE_MAX_WIDTH_PX', 1280),
    // --- AI analysis (AGENT.md §6, §9) ---
    geminiApiKey: required('GEMINI_API_KEY'),
    geminiModel: required('GEMINI_MODEL'),
    aiMaxAttempts: positiveInt('AI_MAX_ATTEMPTS', 3),
    aiJobTimeoutMs,
    // A `processing` lease older than this is stale and may be requeued.
    aiStaleLeaseMs: positiveInt('AI_JOB_STALE_MS', aiJobTimeoutMs * 3),
    analysisWorkerIntervalMs: positiveInt('ANALYSIS_WORKER_INTERVAL_MS', 5000),
    // --- Matching (AGENT.md §8) ---
    matching: Object.freeze({
      notifyThreshold: intInRange('MATCH_NOTIFY_THRESHOLD', 55, 0, 100),
      candidateLimit: positiveInt('MATCH_CANDIDATE_LIMIT', 50),
      weights: Object.freeze({
        category: floatInRange('MATCH_WEIGHT_CATEGORY', 0.3, 0, 1),
        colors: floatInRange('MATCH_WEIGHT_COLORS', 0.2, 0, 1),
        brand: floatInRange('MATCH_WEIGHT_BRAND', 0.1, 0, 1),
        text: floatInRange('MATCH_WEIGHT_TEXT', 0.2, 0, 1),
        venue: floatInRange('MATCH_WEIGHT_VENUE', 0.1, 0, 1),
        time: floatInRange('MATCH_WEIGHT_TIME', 0.1, 0, 1),
      }),
    }),
    // --- Email notifications (AGENT.md §2, §9) ---
    // SMTP credentials must be provided explicitly; when disabled, matches
    // still work and notifications are recorded honestly as `disabled`.
    email: Object.freeze({
      enabled: emailEnabled,
      host: emailEnabled ? required('EMAIL_HOST') : null,
      port: emailEnabled ? positiveInt('EMAIL_PORT', 587) : 587,
      secure: emailEnabled ? bool('EMAIL_SECURE', false) : false,
      user: emailEnabled ? required('EMAIL_USER') : null,
      pass: emailEnabled ? required('EMAIL_PASS') : null,
      from: emailEnabled ? required('EMAIL_FROM') : null,
      maxAttempts: positiveInt('EMAIL_MAX_ATTEMPTS', 5),
    }),
    notifications: Object.freeze({
      workerIntervalMs: positiveInt('NOTIFICATIONS_WORKER_INTERVAL_MS', 10000),
      // A `processing` notification claim older than this is stale.
      staleLeaseMs: positiveInt('NOTIFICATIONS_STALE_MS', 5 * 60 * 1000),
    }),
  });
  return cached;
}

module.exports = { loadConfig };

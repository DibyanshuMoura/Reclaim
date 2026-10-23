'use strict';

/**
 * Minimal structured logger. Never log request bodies, tokens, credentials,
 * or image payloads — callers must pass only safe metadata.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = 'info';

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function emit(level, message, meta) {
  if (!shouldLog(level)) return;
  const entry = { ts: new Date().toISOString(), level, message };
  if (meta !== undefined) entry.meta = meta;
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  setLevel(level) {
    if (LEVELS[level]) currentLevel = level;
  },
  debug(message, meta) {
    emit('debug', message, meta);
  },
  info(message, meta) {
    emit('info', message, meta);
  },
  warn(message, meta) {
    emit('warn', message, meta);
  },
  error(message, meta) {
    emit('error', message, meta);
  },
};

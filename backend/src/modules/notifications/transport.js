'use strict';

/**
 * SMTP transport (AGENT.md §11).
 *
 * The transport is created ONLY when email is explicitly enabled, and it is
 * injected everywhere (workers, tests) — so test code never opens network
 * connections and a disabled deployment bootstraps cleanly. With no real
 * SMTP credentials on hand, the server runs with `EMAIL_ENABLED=false` and
 * notification records are marked `disabled` instead of pretending an email
 * was sent.
 */
const nodemailer = require('nodemailer');

function createTransportFromConfig(emailConfig) {
  if (!emailConfig || !emailConfig.enabled) return null;
  return nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: emailConfig.user ? { user: emailConfig.user, pass: emailConfig.pass } : undefined,
  });
}

module.exports = { createTransportFromConfig };

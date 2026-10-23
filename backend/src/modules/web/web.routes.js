'use strict';

/**
 * Web frontend routes (AGENT.md §2, §12).
 *
 * Serves the dependency-free HTML/CSS/JS frontend from /public. Clean URLs
 * are handled by express.static's `extensions` fallback (/lost → lost.html);
 * token-bearing page paths get explicit routes. The token is NEVER embedded
 * into the served markup — client JS reads it from the location bar — and
 * all HTML responses carry no-store plus a Self-only CSP, so private links
 * are not cached by intermediaries and user text is render-safe by policy.
 *
 * In a split deployment the frontend ships from its own static host while
 * this app still serves `../frontend` by default (development, tests, and
 * single-app hosting share one process and origin).
 */
const path = require('path');
const express = require('express');
const { Router } = express;

// Repo layout: backend/src/modules/web → backend/src → backend → repo root.
const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', '..', 'frontend');

// No inline handlers ship in the frontend, so a strict Self-only policy is
// possible. `img-src data:` covers the inline SVG favicon.
const PAGE_CSP = [
  "default-src 'self'",
  // blob: covers the client-side preview of the user's own chosen file.
  "img-src 'self' data: blob:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
].join('; ');

function createWebRouter() {
  const router = Router();

  function page(file) {
    return (req, res, next) => {
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      res.sendFile(path.join(PUBLIC_DIR, file), (error) => {
        if (error) next(error);
      });
    };
  }

  router.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      extensions: ['html'],
      fallthrough: true,
      setHeaders(res, filePath) {
        // HTML and code always reload (no-store); the fonts are immutable
        // binaries worth caching for repeat visits. HTML adds the Self-only
        // CSP; the CSP on .css/.js is unnecessary (they are plain assets).
        if (filePath.endsWith('.woff2')) {
          res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-store');
          if (filePath.endsWith('.html')) {
            res.setHeader('Content-Security-Policy', PAGE_CSP);
          }
        }
      },
    })
  );

  // Token pages: the shell is public; access checks happen in the API call.
  router.get('/report/:token', page('report.html'));
  router.get('/match/:token', page('match.html'));

  return router;
}

module.exports = { createWebRouter, PAGE_CSP };

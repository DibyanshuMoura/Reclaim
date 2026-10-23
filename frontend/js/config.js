/**
 * Deployment wiring for split-stack hosting.
 *
 * Empty string keeps every API call same-origin — the single-app mode the
 * backend serves by default (development, tests, self-hosting).
 *
 * For a split deployment (frontend on Vercel, API on Render), set the
 * backend origin here — e.g.:
 *   window.RECLAIM_API_BASE = 'https://reclaim-api.onrender.com';
 * …and allow the same origin in the CSP's `connect-src` inside
 * vercel.json. No secrets belong in this file: it ships to browsers.
 */
window.RECLAIM_API_BASE = '';

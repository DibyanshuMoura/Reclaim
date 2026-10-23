# Reclaim

**Get back what's yours.** Reclaim connects people who lost something with
the people who found it — at concerts, malls, campuses, and events. No
accounts, no public listings, no message board. Two reports, one photo, and
an honest match both sides confirm themselves.

```
person A (lost it)  ──reports──▶  report + one-time private token
person B (found it) ──photo───▶  AI extracts what's visible, photo is deleted
          matching engine scores overlapping reports
both sides get one private review link each
     both confirm  ──▶  contact emails exchange  ──▶  item home
```

## How it works

1. **Lose something** → file what you lost (`/lost`): item, description,
   where and when. You receive a private one-time token — shown exactly
   once — that is your only key to the report. Keep it.
2. **Someone finds it** → the finder uploads one photo (`/found`), an email,
   and optionally the venue and time. They never type what it looks like:
   the vision model extracts the visible attributes (item type, colors,
   brand, condition, features) and the finder gets a private report link.
3. **Reclaim matches** → a deterministic, weighted scorer compares lost and
   found reports (item type, colors, brand, descriptive detail, venue, event
   time) and explains every factor in plain language. When a pair clears the
   notify threshold, both sides get exactly one email with their own private
   review link.
4. **Both confirm** → the match page shows only the other side's structured
   report — never their free text — with confirm and decline actions. Only
   when **both** people confirm are the two contact emails exchanged and
   marked as matched. Either side can decline at any time.
5. **Close the loop** → a resolved report is closed from its private page.

## The promises

- **No accounts.** Nothing to register, nothing to remember except a token.
  Losing the token ends access to that report — by design, because nothing
  else can identify you.
- **Unforgeable private links.** Tokens are 43-character base64url secrets;
  the database stores only their SHA-256 hash, so a leaked dump yields no
  usable tokens. There is deliberately no lookup by ID (anti-enumeration),
  and malformed and unknown tokens are indistinguishable.
- **Photos are deleted.** Originals are dropped at upload; the normalized
  working copy is deleted the moment analysis ends — on success, on failure,
  on replacement, with a TTL index as a crash backstop. Only extracted
  attributes persist.
- **Double confirmation.** Contact details are exchanged only after both
  sides confirm the match. Until then, each view shows structured attributes
  only — no free text, no descriptions, no contact fields.
- **Honesty in the loop.** Real status text and elapsed time instead of fake
  progress bars. A photo the model cannot adequately see never completes as
  empty data — it asks for a re-upload. With email disabled, notifications
  are recorded `disabled`, never faked as sent.
- **Calm, accessible design.** A monochrome, boxy design system; one shared
  content column on every page; light/dark themes with a circular-reveal
  switch (instant under reduced motion); keyboard-only flows; no inline
  scripts under a strict `default-src 'self'` CSP; layouts verified from a
  320px phone to a 2560px display.

## Run your own instance

The repository is split for independent hosting:

```
frontend/   the dependency-free web UI (static — Vercel-ready)
backend/    the Express API, workers, tests, and scripts (Render-ready)
```

In **single-app mode** the backend also serves the frontend (development,
tests, and self-hosting share one process and origin):

```sh
cd backend
npm install
cp .env.example .env   # then fill in MONGODB_URI, GEMINI_API_KEY, and EMAIL_* (optional)
npm run dev            # or: npm start — then open http://localhost:5000
```

Requires Node.js >= 20. Configuration is validated at startup; the server
fails fast with a clear, non-secret error message when something required is
missing. Email stays disabled until `EMAIL_*` values exist — matching,
analysis, and the whole frontend work without it, and notifications are
recorded `disabled` rather than pretended.

### Split deployment: Vercel + Render

Deploy **`backend/`** to Render (or any long-running host — a "Web Service",
not serverless: two in-process workers and an in-memory rate-limit store
need a persistent process):

1. Build command `npm ci`, start command `npm start`.
2. Environment: `MONGODB_URI`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
   `APP_BASE_URL` = the **frontend** URL users open, `APP_CORS_ORIGINS` =
   that same frontend origin (the API is then called cross-origin),
   optional `EMAIL_*`, and `TRUST_PROXY=1` (Render terminates a proxy).

Deploy **`frontend/`** to Vercel (static site, "Other" framework preset,
root directory `frontend`):

1. No build step and no secrets — everything is plain files.
2. Edit **one marked line in `frontend/vercel.json`**: replace
   `https://YOUR-BACKEND-HOST.onrender.com` in the CSP's `connect-src`
   with your Render backend URL (pages still ship `no-store` and the
   strict Self-only policy).
3. Optional but cleaner: in `frontend/js/config.js` set
   `window.RECLAIM_API_BASE` to the backend origin; empty keeps requests
   same-origin, which is the single-app mode.

Private links in emails point wherever `APP_BASE_URL` (the frontend) says,
while browsers talk to the API at the backend's CORS-allowed origin.

Health endpoint: `/api/v1/health` (`ok` with a connected database,
`degraded`/503 otherwise), deliberately mounted before rate limiting.

## The pages

Served by the Express app (single-app mode), or as the static `frontend/`
directory on its own host with `vercel.json` mapped to the same URLs:

| Page | Purpose |
|---|---|
| `/` | Landing: the product story and how it works. CTAs live in the navbar. No accounts. |
| `/lost` | Lost-item form. Optional fields are marked. Success shows the one-time token with a copy button. |
| `/found` | Found-item flow: photo with live preview and a camera hint on touch devices, contact email, optional venue/time. Polling is honest: real status text, elapsed time, no fake progress. Failures offer a re-upload recovery path. |
| `/report/:token` | Private report page: status, own data, close action (two-step), photo re-upload when analysis needs a better image, live polling while analysis runs. |
| `/match/:token` | Private match page per party token: score plus plain-language factor explanations, the other side's structured data only, two-step confirm/decline, contact revealed only on mutual confirmation. |

Tokens never appear in served markup; pages read them from the location bar,
and `Referrer-Policy: no-referrer` keeps links out of third-party references.
Suggested-match emails deep-link into `/match/<token>`.

## Try the guarantees

```sh
cd backend
npm test        # 99 backend tests (in-memory MongoDB, no external services)
npm run e2e     # full browser journey via Playwright (downloads Chromium on first run)
```

The e2e runs hermetically — in-memory database, stubbed vision analyzer,
email disabled — and covers: the full user journey (landing → lost → found
with photo → AI attributes → automatic match → mutual confirm → contact
reveal → close), the AI-outage → re-upload recovery path, a viewport audit
at 320/375/640/641/768/1024/1440/1920/2560px (overflow, layout, console and
request errors), both color schemes with manual persistence, reduced motion,
and a keyboard-only reporting flow.

| Command (from `backend/`) | Purpose |
|---|---|
| `npm run dev` | Run with watch mode |
| `npm start` | Run server |
| `npm test` | Unit/API suite (in-memory MongoDB, no external services) |
| `npm run e2e` | Headless-browser end-to-end journey |

## API (base: `/api/v1`)

| Endpoint | Description |
|---|---|
| `GET /health` | Liveness + database state (`ok`/`degraded`) |
| `POST /reports/lost` | Create lost report (JSON). Requires `itemName`, `description` (≥10 chars), `contactEmail` |
| `POST /reports/found` | Create found report (multipart). Field `image` (JPEG/PNG/WEBP ≤ `MAX_IMAGE_BYTES`) plus `contactEmail` — the finder never types visual attributes |
| `GET /private/reports/:token` | Reporter's own report view. Token required |
| `POST /private/reports/:token/image` | Re-upload an image for reports in `needs_user_action`/`permanent_failed`; resets analysis and retry budget |
| `POST /private/reports/:token/close` | Close the reporter's own report (`open`/`matched` → `closed`, idempotent). Active matches referencing it resolve; their undelivered notifications are cancelled |
| `GET /private/matches/:token` | A party's scoped view of a suggested match (no counterparty contact or free text before mutual confirmation) |
| `POST /private/matches/:token/confirm` | The viewer confirms the match. With BOTH parties confirmed: contact emails are exchanged, `contacts_shared` emails enqueue, and both reports become `matched` |
| `POST /private/matches/:token/reject` | The viewer declines the match (terminal; pending notifications cancelled) |

**Tokens:** creation responses include `accessToken` and `privateReportPath`.
The token is shown exactly once; the database stores only its hash, never the
raw value, and tokens are never logged. The same discipline applies to
**match tokens** — each suggested match carries two independent per-party
tokens (loser / finder), delivered by email and never shown to the other
side; only hashes are stored.

## Under the hood

- **Modular monolith** (`src/`): `config/`, `middleware/`, `modules/`,
  `infrastructure/`, `utils/`. Handlers are thin; rules live in services;
  database access lives in models and infrastructure.
- **Validation:** Zod parses every body server-side; strict object mode
  rejects unknown fields; optional fields normalize whitespace-only strings
  to absent. The private contact email and token hash are `select: false` —
  any query that forgets to opt in cannot leak them by construction.
- **Image pipeline:** uploads are size-checked, magic-byte sniffed (the
  client's MIME type is never trusted), decode-bounded (~25MP), EXIF-
  oriented, and decanted to a JPEG ≤1280px for analysis. `temporary_images`
  is separate from the report document, and attribute persistence is ordered
  before image deletion so a crash can orphan an image (harmless) but can
  never lose a result.
- **Analysis worker:** atomic per-attempt claims (oldest first), stale-lease
  recovery, exponential backoff with jitter, and bounded retries. Transient
  failures retry within budget, then surface a re-upload state; quota,
  rejected-image, and safety-block outcomes go straight to
  `needs_user_action`; auth/config errors stop as `permanent_failed` for the
  operator. An output that parses but carries nothing usable never completes
  as empty data.
- **Matching engine:** a pure `scorePair` with per-factor weights in [-1, 1]
  where missing data is neutral (never positive) and confirmed conflicts
  (different brands, venues, far-apart times) are negative. Triggers are
  best-effort on analysis completion and lost-report creation, idempotent
  through a unique pair index — a re-run can never duplicate a match or its
  notifications.
- **Notification store:** every email is a durable record first, keyed by a
  unique `idempotencyKey` per (match, role, type) — at most one send per
  event. The worker claims atomically under a lease, retries with backoff
  and jitter, recovers stale leases after crashes, and reaches only honest
  terminal states: `sent` or `failed`.
- **Vision adapter:** plain `fetch` against Gemini's REST API (no SDK
  dependency), the model chosen by `GEMINI_MODEL`, JSON enforced via
  structured output, the image passed only through `inline_data`, hard
  timeouts via `AbortController`. Model output is validated and normalized
  server-side regardless of what the model returns.
- **Frontend:** plain HTML/CSS/JS with no build step; Iosevka typography
  self-hosted as woff2 (OFL-1.1); client-side validation mirrors the server
  for convenience, but the server stays authoritative; light/dark themes
  follow the OS until a saved choice, persisted in `localStorage`.
- **Hardening:** per-IP rate limiting (a general API limiter and a stricter
  report-creation limiter), 32kb JSON body cap, conservative response
  headers (`nosniff`, `frame-deny`, `no-referrer`, `no-store`), a strict
  Self-only CSP on every HTML page, `x-powered-by` disabled, and CORS with
  no cookies or credentials — origins unrestricted by default, lockable via
  `APP_CORS_ORIGINS` in production.
- **Lifecycle:** SIGTERM/SIGINT stop both workers, close the HTTP server,
  and disconnect the database — with a 5-second force exit if anything hangs.

## Security notes

- Never commit the real `.env`. `.gitignore` already excludes it.
- Access tokens and contact details are never logged; error responses
  contain no stack traces or payload echoes.
- If the Gemini API key or database credentials are ever shared insecurely
  (chat, screenshots), rotate them.

## Documentation

`AGENT.md` is the engineering spec: architecture invariants, product rules,
and the plan of record. This README is the product view.

---

Get back what's yours — hand found things to Reclaim, and let it hand them
back.

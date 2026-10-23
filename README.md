# Reclaim

**Get back what's yours.** An anonymous, privacy-conscious lost-and-found application
for venues — concerts, malls, colleges, events.

This repository implements the product described in `AGENT.md` (read it first).

## Status: Phase 5 complete

Implemented: anonymous lost/found report creation, server-side validation,
private access tokens, rate limiting, centralized error handling, health
endpoint, graceful shutdown, **image intake pipeline (magic bytes → bounded
decode → EXIF-aware decant to JPEG), temporary image store with TTL backstop,
Gemini vision analysis via a structured-output adapter, an in-process
analysis worker with atomic claims, stale-lease recovery, bounded retries
with backoff, and an image re-upload recovery path**, plus **deterministic
matching (weighted, explainable scoring between lost and found reports),
per-party match tokens with both-party confirmation, an idempotent
notification store, and real Gmail SMTP email delivery through an in-process
worker**, and the **dependency-free web frontend** (monochrome boxy design
system, light/dark themes, forms with inline validation, photo preview,
honest polling states, private report and match pages, close/reject/recovery
actions) — 97 backend tests + a Playwright browser e2e (journey + viewport
matrix 320→2560 + themes + reduced motion + keyboard-only flow via
`npm run e2e`).

Not yet implemented: deployment documentation (Phase 6).

## Setup

```sh
npm install
cp .env.example .env   # then fill in MONGODB_URI, GEMINI_API_KEY, and EMAIL_* (optional)
npm run dev            # or: npm start
```

Requires Node.js >= 20. Configuration is validated at startup; the server
fails with a clear, non-secret error if required variables are missing.
Email stays disabled until `EMAIL_*` values exist — the rest of the app
works without it (notifications are recorded `disabled`, never faked).

Deployment notes: run `npm start` (not the watcher). Behind exactly one
reverse proxy (nginx, Render, Railway, …) set `TRUST_PROXY=1` so per-IP
rate limits count real visitors; leave it unset when the Node process is
exposed directly so the spoofable `X-Forwarded-For` header is never trusted.
The health endpoint is `/api/v1/health` (200 with a connected database, 503
otherwise) and is deliberately mounted before rate limiting.

## Web frontend (Phase 5)

Served by the same Express app — open the server root in a browser:

| Page | Purpose |
|---|---|
| `/` | Landing: product story + how it works; CTAs live in the navbar. No accounts. |
| — | One shared 1120px content column on every page (landing matches the form pages). |
| `/lost` | Lost-item form. Optional fields explicitly marked. Success shows the one-time token with a copy button. |
| `/found` | Found-item flow: photo (+ preview, camera hint on touch devices), contact email, optional venue/time. Honest polling: real status text, elapsed time, no fake progress bars. Failure states offer a re-upload recovery path. |
| `/report/:token` | Private report page: status chips, own data, close action (two-step confirm), photo re-upload for failed analyses, live polling while analysis runs. |
| `/match/:token` | Private match page per party token: score + plain-language factor explanations, the other side's structured data only (no free text), two-step confirm/decline, contact details revealed only after both sides confirm. |

Frontend facts:

- Plain HTML/CSS/JS in `public/` — no build step, no framework, per §3.
- Strict CSP (`default-src 'self'`, `img-src self data: blob:`, no inline
  scripts), `no-store` on all HTML, tokens are never rendered into markup;
  pages read them from the location bar (`Referrer-Policy: no-referrer`
  keeps them out of third-party references).
- Monochrome design tokens in `public/css/styles.css` drive light and dark
  themes, switched with a single borderless icon toggle (the icon shows the
  theme you would switch to) on the translucent blurred navbar; switching
  reveals the new theme as a ~380ms circle expanding from the toggle via the
  View Transition API (body-color fade on engines without it, instant under
  reduced motion); until a choice is saved
  the OS theme is followed live, a choice persists in `localStorage`; CTAs and
  hover states invert contrast but never carry state alone (focus-visible,
  disabled, error, success are explicit).
- Typography is Iosevka everywhere: the locally installed "Iosevka Nerd
  Font" is preferred, with self-hosted woff2 files (`public/fonts/`,
  OFL-1.1) as the fallback so fresh browsers render the same faces.
- Validation is mirrored client-side for convenience but the server stays
  authoritative; server field errors map onto the matching inputs.
- Suggested-match emails link to `/match/<token>` (deep-link into the UI).

## Verification

```sh
npm test        # 97 backend tests (in-memory MongoDB, no external services)
npm run e2e     # Playwright browser e2e (downloads Chromium on first run)
```

The e2e runs hermetically: in-memory MongoDB, stubbed vision analyzer,
email disabled. It covers the §15 user journey (landing → lost → found with
AI-attributes → automatic match → mutual confirm → close), the AI-outage →
re-upload recovery path, a 320/375/640/641/768/1024/1440/1920/2560 viewport
audit (horizontal overflow, layout, console/page/request errors), both color
schemes, manual theme persistence, reduced motion, and a keyboard-only
reporting flow. Chromium download (~120 MB) is the only first-run cost.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with watch mode |
| `npm start` | Run server |
| `npm test` | Run the jest suite (in-memory MongoDB, no external services) |

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

**Tokens:** creation responses include `accessToken` (a 43-char unguessable
base64url string) and `privateReportPath`. The token is shown **exactly once**;
the database stores only its SHA-256 hash. There is deliberate **no public
report lookup by ID** (anti-enumeration per `AGENT.md` §10). Malformed and
unknown tokens both produce the same 404. The same discipline applies to
**match tokens**: each suggested match carries two independent per-party
tokens (loser / finder), delivered by email and never shown to the other
side; only hashes are stored.

## Design decisions

- **Modular monolith** (`src/`): `config/`, `middleware/`, `modules/reports/`,
  `infrastructure/database/`, `utils/`. Handlers are thin; rules live in
  services; DB access lives in `report.model.js` + `infrastructure/`.
- **Validation:** Zod (v3 for its stable API) parses every body server-side;
  strict object mode rejects unknown fields; optional fields normalize
  whitespace-only strings to absent.
- **Privacy:** `contactEmail` and `accessTokenHash` are `select: false` — any
  query that forgets to opt in cannot leak them by construction.
- **States:** report lifecycle (`open → matched → … → closed`) and analysis
  status are separate fields with validated transition maps.
- **Image pipeline** (`src/modules/image-analysis/image.processing.js`):
  uploads are size-checked, magic-byte sniffed (client MIME never trusted),
  decode-bounded (~25MP), EXIF-oriented, and decanted to a JPEG ≤1280px.
  Original upload bytes are dropped immediately; only the normalized copy is
  ever retained.
- **Temporary image store** (`temporary_images` collection): separate from
  the report document (BSON doc-size limit; scoped access). A TTL index on
  `expiresAt` is only an async backstop — every lifecycle transition deletes
  payloads explicitly (success, retry exhaustion, replacement). Attribute
  persistence is ordered BEFORE temporary deletion so a crash between the
  two steps can orphan an image (harmless, TTL-cleaned) but can never lose a
  result.
- **Analysis worker** (`analysis.worker.js`): atomic claims per attempt
  (oldest first), stale-lease recovery after `AI_JOB_STALE_MS`, exponential
  backoff (2s base, 5min cap) with jitter, and honest failure states:
  - transient (network/timeout/5xx/malformed output) → retry within
    `AI_MAX_ATTEMPTS`, then `needs_user_action` (image deleted)
  - quota / rejected-image / safety-blocked → `needs_user_action`
    immediately
  - auth/model/config errors → `permanent_failed` (operator fix required)
  - `processing` reports whose attributes already persisted complete without
    a duplicate provider call (crash between persist and completion).
- **Matching engine** (`src/modules/matching/match.service.js`): a pure,
  deterministic `scorePair` scores a (lost, found) pair from six factors —
  item type, colors, brand, descriptive detail, venue, event time. Weights
  come from `MATCH_WEIGHT_*` (normalized internally); factor scores live in
  [-1, 1] where missing data is neutral (never positive) and confidently
  known conflicts (different brands/venues/colors, far-apart times) are
  negative. Pairs at or above `MATCH_NOTIFY_THRESHOLD` become matches.
  - **Trigger points:** found-report analysis completion and lost-report
    creation. Both are best-effort (a matching failure never fails the
    report/analysis itself) and idempotent via the unique
    `(lostReportId, foundReportId)` index — re-running the engine can
    never duplicate a pair or its notifications.
  - **Statuses:** `suggested → notified` (once BOTH parties' suggested
    emails were actually delivered), `confirmed` (both parties confirmed;
    contact emails exchanged, both reports `matched`), `rejected`
    (either party declines; terminal), `resolved` (a related report closes).
  - **Privacy of views:** a match view shows the other side's *structured*
    data only (found attributes / lost item name) — never a description or
    any free text that could embed contact details. `counterpartyContactEmail`
    is `null` until BOTH sides confirm.
- **Notifications** (`src/modules/notifications/`): every email is a stored
  record first (`notifications` collection) with a unique
  `idempotencyKey` (`<matchId>:<role>:<type>`) guaranteeing at most one
  record — and one send — per (match, role, type). The worker claims
  atomically (oldest first), runs inside a lease, retries with exponential
  backoff + jitter via `notBefore`, recovers stale leases after crashes,
  and reaches honest terminal states only: `sent` (real provider accepted)
  or `failed` (budget exhausted, bounded error stored).
  - **Honest disabled semantics:** with `EMAIL_ENABLED=false`, notifications
    are recorded `disabled` — matches match, views work, and the system
    never pretends an email was sent. `suggested` matches only advance to
    `notified` through the `onDelivered` hook after both real sends.
  - **Email content:** subject + text + matching HTML, no tracking, no
    logging of recipients; the suggested email contains one private review
    link and explicitly states nothing is shared until both sides confirm.
  - **Transport:** nodemailer over SMTP (`EMAIL_*` config; for Gmail use
    port 465 + `EMAIL_SECURE=true` and a 16-char app password). Secrets
    live only in `.env`.
- **Vision adapter** (`src/infrastructure/gemini/client.js`): plain `fetch`
  against the REST API (no SDK dependency), model from `GEMINI_MODEL`, JSON
  enforced via `responseMimeType` + `responseSchema`, the image passed only
  through `inline_data`, thought-summary parts excluded from the parsed
  text, hard timeouts via `AbortController`. Model output is validated and
  normalized server-side regardless.
- **Limiter scoping:** the global API limiter covers endpoints including the
  image recovery path; the stricter report-create limiter covers lost/found
  report creation.
- **Rate limiting:** per-IP, configurable (`RATE_LIMIT_*`,
  `REPORT_RATE_LIMIT_MAX`). Uses express-rate-limit's in-memory store: single
  instance only — a shared store (e.g. Redis) is required if the API runs
  multiple processes/replicas.
- **Body limit:** JSON capped at 32kb (photo uploads arrive with Phase 3 and
  will have their own limits).
- **Workers:** two in-process workers (image analysis, notification
  delivery), both started/stopped by the server lifecycle. Single instance
  only — horizontal scaling needs a shared job store first.
- **CORS:** no cookies or credentials are used; origins are unrestricted by
  default and lockable down via `APP_CORS_ORIGINS` in production.
- **Tests:** jest + supertest + mongodb-memory-server (each suite boots its
  own throwaway MongoDB). The driver's `runtimeAdapters` option is passed
  explicitly because Jest's CommonJS sandbox cannot fulfill the driver's
  dynamic `import('os')` adapter load (see `src/infrastructure/database/connect.js`).
- **Graceful shutdown:** SIGTERM/SIGINT close the HTTP server, disconnect the
  database, and force-exit after 5s if properly hung.

## Security notes

- Never commit the real `.env`. `.gitignore` already excludes it.
- Access tokens and contact details are never logged; error responses contain
  no stack traces or payload echoes (`PAYLOAD_TOO_LARGE`/`INVALID_JSON` are the
  only client-error echoes).
- If the Gemini API key or database credentials are ever shared insecurely
  (chat, screenshots), rotate them.

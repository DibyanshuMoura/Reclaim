# AGENT.md — Reclaim

**Product name:** Reclaim  
**Tagline:** Get back what’s yours.


> **Purpose:** This file is the source of truth for the product's behavior, architecture, engineering standards, UI direction, and verification requirements. Read it before changing code.
>
> **Priority:** Inspect the existing repository first. Preserve working behavior and the current stack unless a change is justified by a concrete requirement. This document describes the target product; it is not permission to rewrite the project blindly.

## 1. Product vision

Build **Reclaim**, a simple, fast, privacy-conscious item-recovery web application for places such as concerts, malls, colleges, public events, and other crowded venues.

The product connects:
- A person who **lost** an item and can describe it.
- A person who **found** an item and can take a photograph of it.

AI extracts visible attributes from found-item photos. The backend compares those attributes with lost-item reports and identifies **potential matches**. When a match meets the configured notification policy, the people involved are notified by email and can proceed with recovery.

### Product principles

- Reporting must not require creating an account or logging in.
- Reporting should take as few steps as reasonably possible.
- A person reporting a found item should not have to manually describe every visible attribute. The AI should infer those attributes from the photograph.
- A person reporting a lost item must be able to describe details that may not be visible in a found-item photograph.
- AI output is an estimate, not proof of identity or ownership.
- Do not permanently retain item photos by default. Retain extracted attributes and the minimum report data needed for matching and recovery.
- Keep the system understandable, testable, and maintainable. Prefer simple, explicit code over abstractions without a demonstrated need.
- Never claim that a match, email, test, or deployment succeeded unless it has been verified.

## 2. Required user experience

### Landing page

The first screen is the product story (how it works, privacy model). The two
primary actions travel in the navbar on every page (user-directed, 2026-10):

1. **Lost an item**
2. **Found an item**

No accounts, no login, no profile creation, and no multi-step onboarding.

### Lost-item report

The lost-item reporter supplies the information they know. Keep the form short, accessible, and validated.

Required or recommended fields:
- Item name/category.
- Description and distinguishing physical details.
- Color(s).
- Brand, if known.
- Approximate date and time it was lost.
- Venue and approximate location, if known.
- Contact email for match notifications.

Do not require users to know every attribute. Clearly mark optional fields. Location and time are useful matching signals, but do not make them absolute requirements if the user does not know them. A photo of the lost item may be supported as an optional enhancement, but matching must work without it.

### Found-item report

The finder should not be required to type the item's category, color, brand, or visual description.

The flow should be:
1. Take or upload a photo.
2. Provide a contact email for notifications.
3. Optionally provide the venue, approximate place, and time found, because a photograph cannot reliably establish these facts.
4. Submit.

The browser should offer camera capture on supported mobile devices and ordinary file selection on desktop. Use a file input with an appropriate `accept` value and `capture` hint where supported; do not assume every browser or desktop has a camera.

The backend sends the image to the configured vision model and asks for structured, machine-readable attributes. Show a clear progress state while analysis runs. If analysis fails, do not silently fabricate attributes or lose the report.

### Match and recovery experience

- Show a potential match only to authorized parties through an unguessable, time-limited or revocable private link.
- Explain the matching signals in plain language, without exposing private verification details.
- Notify both parties by email when the configured threshold and notification policy are satisfied.
- Do not publish contact information on public report pages or expose it through enumerable IDs.
- By default, share contact details only after the relevant parties confirm the potential match or an authorized venue operator verifies the recovery. If a product decision later changes this policy, document the privacy and abuse implications first.
- Provide a way to report an incorrect match and close a resolved report.
- Do not require a login to view a private report link; possession of a secure token grants only the specific permissions intended for that link.

## 3. Repository-first instructions

Before implementation:

1. Inspect the repository tree, `package.json` files, scripts, current routes, models, middleware, upload logic, email logic, environment examples, tests, and deployment configuration.
2. Identify the actual frontend stack. The original project may use HTML/CSS/JavaScript, with Node.js, Express, MongoDB/Mongoose, Multer, Gemini, and Nodemailer. Do not assume this is still the current structure; verify it.
3. Write a short audit of what works, what is broken, what security gaps exist, and what needs to change.
4. Preserve the existing stack and working functionality where practical. Do not migrate to React, Next.js, TypeScript, a new CSS framework, or a different database merely because the agent prefers it.
5. If a migration is genuinely needed, explain the concrete problem it solves, compare simpler options, and make the smallest justified change.
6. Do not overwrite project files, remove features, or change dependencies without inspecting their current use.
7. Work in small, reviewable stages. After each stage, run the relevant tests and report the results.
8. If repository facts conflict with this document, explain the conflict and prefer a safe, minimal adaptation rather than silently inventing structure.

## 4. Target architecture

Use a **modular monolith**: one backend application with clear module boundaries. Do not begin with microservices, Kubernetes, Kafka, or multiple independently deployed services.

### Frontend

Use the repository's current frontend stack.

Responsibilities:
- Landing page and lost/found choice.
- Lost-item form.
- Found-item camera/upload flow.
- Analysis progress, retry, and failure states.
- Private match/recovery pages.
- Responsive and accessible UI.

### Backend

Use Node.js and Express if already present.

Responsibilities:
- Request validation and rate limiting.
- Anonymous report creation and private report access.
- Image validation and temporary handling.
- Gemini image analysis.
- Matching and match persistence.
- Email notification jobs.
- Report lifecycle and recovery status.
- Centralized error handling and safe logging.

### MongoDB

Use the existing MongoDB deployment and Mongoose if already present. Store report data, extracted attributes, match records, notification state, and durable job state. Do not store permanent photo data by default.

### External integrations

- **Vision:** Google Gemini API, configured through environment variables. Verify the selected model supports image input and structured output using the current SDK/API and the account's available quota. Do not assume that a model or free quota is permanently available; make the model name configurable.
- **Email:** Use the existing Nodemailer setup if it works. Keep email delivery behind a notification module so the provider can be changed without changing matching logic.
- **Image storage:** No permanent image-storage provider is required for the initial product. Use short-lived temporary storage only if needed for retries, as described below.

### Suggested module boundaries

Adapt these to the current repository; do not reorganize everything for cosmetic reasons.

```text
src/
  config/
  middleware/
  modules/
    reports/
    image-analysis/
    matching/
    notifications/
    recovery/
  jobs/
  infrastructure/
    database/
    email/
    temporary-images/
  utils/
  app.js
  server.js
tests/
.env.example
```

Keep route handlers thin. Put business rules in named service functions. Keep database access, external API calls, validation, and presentation concerns separate. Avoid giant controllers, circular imports, hidden side effects, and generic helper layers that make simple code harder to follow.

## 5. Image processing and retention policy

### The default rule

**Do not permanently store the original image or its Base64 representation.** The image is input to analysis; extracted attributes are the lasting data needed for matching.

Base64 is an encoding, not compression. It increases the payload size by roughly one third. Use it only in the format required by the chosen API. Never paste the Base64 text into an ordinary text prompt: pass it through the provider's supported image-input field.

### Image request flow

1. Validate the file's declared type, size, and actual decoded content. Do not trust the filename or client-provided MIME type.
2. Enforce a configurable maximum upload size and a reasonable maximum pixel dimension.
3. Resize and compress the image where practical, preferably before upload and/or on the server. Correct image orientation and reject unsupported or malformed files.
4. Do not log the Base64 payload or return it in API responses.
5. Send the image to Gemini using the supported image-input format and request a defined JSON schema for extracted attributes.
6. Validate the model's response on the server before accepting it.
7. Persist the report and extracted attributes.
8. After successful analysis and durable persistence, delete all temporary copies of the image and discard the Base64 string from memory as soon as it is no longer needed.
9. Do not include image payloads in error logs, analytics, exception traces, or email notifications.

### Temporary retention for retry and crash recovery

There is a trade-off: if the image is not stored anywhere and the process crashes before analysis is durably saved, the server cannot reconstruct the original image. In that case, the user must upload it again. Do not pretend that a lost in-memory image can be recovered.

Preferred MVP behavior:
- Persist the report/job record first with a state such as `pending_analysis`.
- If reliable automatic retries across process restarts are required, keep the image in a **separate temporary job record or temporary file store**, not in the permanent report document.
- If MongoDB is used for temporary payloads, enforce strict compressed-image limits, store the payload in a separate collection, and configure a TTL cleanup policy. A TTL index is asynchronous cleanup, not an exact deletion deadline; also explicitly delete the payload immediately after success or after the retry policy is exhausted.
- Do not put large Base64 strings inside the main report document. Remember MongoDB's BSON document size limit applies to the entire document.
- If the deployment has no durable temporary storage, use bounded in-memory handling and clearly tell the user to retry/re-upload after a failure. Do not claim crash-safe retries in that configuration.
- Define a maximum retry count and backoff. Do not retry indefinitely or retry permanent errors (invalid image, unsupported format, invalid API key, exhausted quota) as if they were transient.
- After retries are exhausted, keep the report and contact details safely, mark analysis as needing user action, remove the temporary image according to the retention policy, and provide a way to retry by uploading the image again.
- Restrict access to temporary image data. Never expose it through public report endpoints.

Document the chosen temporary-storage implementation and its operational cost after inspecting the existing deployment.

## 6. AI attribute extraction contract

The vision model should identify **visible, generic features**, not assert ownership or invent hidden details.

Expected output shape, adapted as needed:

```json
{
  "category": "backpack",
  "primaryColor": "black",
  "secondaryColors": ["red"],
  "brand": null,
  "visibleFeatures": [
    "front zipper pocket",
    "two shoulder straps"
  ],
  "itemType": "backpack",
  "condition": "unknown",
  "uncertainAttributes": [],
  "analysisVersion": "1"
}
```

Requirements:
- Ask for valid structured JSON and validate it against a server-side schema.
- Allow `null`, `unknown`, and empty arrays when information cannot be inferred.
- Do not invent brand names, serial numbers, contents, ownership, exact location, or exact time from an image.
- Treat model output as untrusted input. Normalize and bound all strings and arrays.
- Use timeouts and handle rate limits, provider errors, malformed output, and quota exhaustion.
- Keep the model identifier configurable through `GEMINI_MODEL`.
- Do not assume AI-generated color labels are always correct. Matching should tolerate uncertainty and use other signals.
- Store only the extracted attributes and any minimal analysis metadata needed for debugging and future migration. Do not store hidden chain-of-thought or unnecessary provider responses.
- Never tell users that an item has definitely been identified as theirs solely because the model produced a match.

## 7. Data model and workflow states

Adapt existing schemas instead of creating duplicate models.

### Report

A report should contain only fields required for the workflow, such as:
- `reportType`: `lost` or `found`
- `description` (required for lost reports; optional/generated for found reports)
- `attributes` (validated structured attributes)
- `venue` and `locationDescription` when supplied
- `incidentAt` or an explicitly approximate date/time
- `contactEmail` or a reference to a protected contact record
- `status`
- `analysisStatus`
- timestamps and minimal audit metadata

Do not expose contact details in public report listings. Avoid storing redundant copies of the same information.

### Suggested analysis states

- `not_required` — for reports that do not need image analysis.
- `pending` — accepted and waiting for analysis.
- `processing` — currently claimed by a worker.
- `completed` — valid attributes have been persisted.
- `retryable_failed` — a transient failure occurred and retry is allowed.
- `needs_user_action` — retries are exhausted or a new image is required.
- `permanent_failed` — invalid input or another non-retryable error.

### Suggested report lifecycle

- `open`
- `matched`
- `recovery_in_progress`
- `recovered`
- `closed`

Validate all state transitions on the server. Do not use one status field to represent both report lifecycle and AI analysis state.

### Match

A match should reference a lost report and a found report and contain:
- A bounded score or ranking value.
- Per-factor comparison results suitable for explaining the match.
- A status such as `suggested`, `notified`, `confirmed`, `rejected`, or `resolved`.
- Timestamps.

Create a unique constraint or equivalent idempotency mechanism for a normalized lost/found pair. A high score is not a calibrated probability unless it has been validated as one.

### Notification

Track logical notifications and their delivery status. Use idempotency keys so retries do not send the same notification repeatedly. Record provider acceptance and failures without claiming guaranteed inbox delivery.

## 8. Matching engine

Start with transparent, deterministic matching. Do not send every stored image or every report to an LLM for every new report.

### Candidate filtering

- Compare lost reports only with eligible found reports, and vice versa.
- Exclude closed or otherwise ineligible reports.
- Prefer the same venue or compatible location.
- Consider time proximity when known.
- Limit candidate counts and paginate or batch queries where needed.

### Scoring

Use configurable, documented weights for:
- Category compatibility.
- Primary and secondary color compatibility.
- Brand compatibility, when known.
- Description and visible-feature similarity.
- Date/time proximity.
- Venue/location compatibility.

Missing data must not be silently treated as a positive match. A conflicting, confidently known attribute may lower the score. Keep the score within its defined range and explain the contribution of each factor.

Thresholds must be configurable and covered by tests. Treat initial weights and thresholds as hypotheses to validate with examples, not as scientifically established probabilities.

### Notification policy

- Low-confidence candidates should not trigger contact sharing.
- Qualifying candidates can trigger privacy-safe potential-match emails.
- Do not expose private contact details publicly.
- Require the appropriate confirmation or authorized verification before sharing contact information by default.
- Avoid duplicate notifications when jobs retry or the same pair is rediscovered.

Build the simplest reliable matcher first. Add embeddings or more advanced AI ranking only if test data demonstrates that deterministic matching is inadequate.

## 9. Reliability and crash recovery

External AI calls and email delivery are unreliable network operations. The report submission endpoint must not depend on all of them succeeding synchronously.

- Validate and persist the report/job state before starting asynchronous work.
- Claim jobs atomically where possible, using a lease or lock and a `lockedAt`/`attemptedAt` timestamp.
- If a worker crashes, recover stale `processing` jobs after a configured timeout; do not immediately run duplicate jobs just because a worker is slow.
- Make each job idempotent.
- Persist extracted attributes and update the analysis state safely. Where possible, commit these related database changes in a transaction; do not assume all MongoDB deployments support transactions unless the deployment is configured appropriately.
- On recovery, inspect persisted attributes and job state before calling the vision model again. If valid attributes already exist, complete the job without paying for duplicate analysis.
- Recognize that a crash can occur after the provider processes a request but before the application records the result. Exactly-once execution across an external API and MongoDB cannot be assumed; use idempotency, durable state, and bounded retries to make the workflow safe.
- Use exponential backoff with jitter for transient failures and a maximum attempt count.
- Do not retry invalid input, invalid credentials, or other permanent failures without changing the underlying condition.
- If an email send times out, its delivery outcome may be unknown. Use provider idempotency support if available and track attempts; do not blindly send unlimited duplicates.
- Provide a safe manual/re-upload recovery path for reports whose temporary image has expired.

For a small MVP, use the simplest durable job mechanism that fits the deployment. Do not introduce Redis or another queue unless the reliability requirement and deployment justify it.

## 10. API and validation

Follow the existing route conventions. If no conventions exist, use consistent REST endpoints under `/api/v1`.

Possible endpoint groups:
- `POST /api/v1/reports/lost`
- `POST /api/v1/reports/found`
- `GET /api/v1/reports/:id` (public-safe fields only)
- `GET /api/v1/private/reports/:token` (restricted token-based access)
- `GET /api/v1/private/matches/:token`
- `POST /api/v1/private/matches/:token/confirm`
- `POST /api/v1/private/matches/:token/reject`
- `POST /api/v1/private/reports/:token/close`

These are examples, not commands to duplicate existing routes. Choose endpoint names and response shapes consistently.

Requirements:
- Validate body, query, route parameters, uploaded files, and model output on the server.
- Return consistent error responses with appropriate HTTP status codes.
- Apply request and upload size limits and rate limiting to public endpoints.
- Use unguessable, cryptographically secure private tokens. Store token hashes where practical, scope each token to specific actions, support expiration/revocation, and never log raw tokens.
- Do not trust a report ID as authorization.
- Do not expose internal stack traces, database details, provider errors, image payloads, or private contact information in API responses.
- Prevent NoSQL injection and unsafe query construction.
- Configure CORS for intended origins; do not allow arbitrary origins with credentials.
- Use safe HTML rendering and output encoding for user-submitted text.

## 11. Environment configuration and secrets

Read configuration from environment variables. Never hard-code credentials or commit a real `.env` file.

Maintain a `.env.example` with placeholders, for example:

```dotenv
NODE_ENV=development
PORT=5000
MONGODB_URI=
GEMINI_API_KEY=
GEMINI_MODEL=
EMAIL_HOST=
EMAIL_PORT=
EMAIL_SECURE=
EMAIL_USER=
EMAIL_PASS=
EMAIL_FROM=
APP_BASE_URL=
MAX_IMAGE_BYTES=5242880
IMAGE_RETENTION_HOURS=24
AI_MAX_ATTEMPTS=3
AI_JOB_TIMEOUT_MS=120000
```

Adapt names to the existing codebase and chosen email provider. Do not invent required variables that the implementation does not use. Validate required environment variables at startup and fail with a clear, non-secret error message.

Never print API keys or credentials. Document how to create a local `.env` without including real values in Git. Verify the current Gemini model's image-input support and available quota; do not promise unlimited or permanently free inference.

## 12. UI design system: minimal, boxy, monochrome

The UI must look deliberately designed by a human product designer, not like generic AI-generated SaaS UI.

### Visual direction

- Primarily black, white, and neutral grays.
- Boxy geometry: square or only slightly rounded corners.
- Strong alignment, clear spacing, restrained typography, crisp borders.
- Use a small number of consistent type sizes and spacing values.
- Prefer thin borders and flat surfaces over shadows.
- No unnecessary gradients, neon colors, glassmorphism, glowing borders, oversized pill buttons, decorative blobs, or excessive animation.
- Avoid stock illustrations and decorative visuals that do not help users report or recover an item.
- Use icons only where they clarify an action; do not use emoji as UI icons.
- Keep layouts calm, functional, and information-dense without feeling cramped.

Round-2 deviations, explicitly authorized by the user (2026-10): the navbar
uses a translucent blurred background (`backdrop-filter`, with an opaque
fallback when unsupported); the theme switch is a single borderless icon-only
toggle (the icon shows the theme you would switch to) that transitions with a
~380ms circle reveal expanding from the toggle button (View Transition API;
body-color fade fallback; instant under reduced motion), and pages play a
one-shot ~10px top-down entrance on load. Reduced motion removes the entrance
and the reveal entirely. No essential
information depends on any of these; the rest of §12 stands.

### Theme behavior

Support a coherent light theme and dark theme.

**Dark theme**
- Main background: near-black or black.
- Surfaces: slightly differentiated dark neutral shades.
- Primary text: white.
- Secondary text: neutral gray with sufficient contrast.
- Borders: subdued neutral gray.
- Hovered/selected controls: white surface with black text where appropriate.

**Light theme**
- Main background: white.
- Surfaces: white or very light gray.
- Primary and secondary text: dark gray/neutral gray with sufficient contrast.
- Borders: subtle neutral gray.
- Hovered/selected controls: black surface with white text where appropriate.

Hover and selected states should invert contrast clearly, but must not be the only way to communicate state. Add focus-visible, disabled, error, and success states. Maintain accessible contrast; do not use low-contrast gray just to match the aesthetic.

Use semantic design tokens/CSS variables rather than scattering literal colors throughout components. Keep both themes visually equivalent and consistent.

### Interaction and motion

- Use restrained, purposeful transitions.
- Respect `prefers-reduced-motion`.
- Never make essential information depend on animation.
- Provide explicit loading, empty, success, retry, and failure states.
- Do not leave buttons decorative or nonfunctional.
- Forms need inline validation, clear labels, keyboard support, and understandable errors.
- File upload must show the chosen image preview before submission and explain file constraints.
- Show the AI analysis state honestly; do not fake progress or invent results.

## 13. Responsive behavior and cross-screen testing

The application must work on small phones, large phones, tablets, laptops, desktop monitors, ultrawide displays, and browser zoom settings. Do not optimize only for the developer's current monitor.

Requirements:
- Use responsive layout constraints, flexible grids, and sensible `max-width` values.
- Avoid fixed page widths and positioning that depends on one viewport.
- Prevent horizontal overflow, clipped content, overlapping elements, and animation elements leaving the viewport.
- Recalculate animation geometry when the viewport changes. Handle resize events safely and clean up listeners/observers.
- Check `vh`/`dvh`, safe areas, and mobile viewport behavior where relevant.
- Ensure dialogs, menus, forms, and primary actions remain usable on narrow screens.
- Test keyboard navigation, focus, reduced motion, and touch targets.
- Test browser zoom and long text/large content, not just the default screenshot.

If browser automation exists or can be added without excessive project disruption, use Playwright or the repository's existing end-to-end test tool to test multiple viewport sizes. Include representative widths such as 320, 375, 768, 1024, 1440, 1920, and 2560 CSS pixels, plus a tall/narrow mobile viewport. These are test cases, not a guarantee that every device has exactly these dimensions.

For each critical page and animation:
1. Capture or inspect the page at small, medium, large, and ultrawide widths.
2. Check for console errors, failed network requests, horizontal overflow, clipped text, and overlapping controls.
3. Verify animations after initial load, on resize, after orientation changes where applicable, and with reduced motion enabled.
4. Confirm layout changes at breakpoints and test widths just above and below each breakpoint.
5. Fix the underlying layout or animation calculation rather than adding arbitrary one-off media queries.
6. Re-run the tests after fixes and inspect the result. Never assume a fix worked because the code changed.

When no physical ultrawide monitor is available, use browser developer tools and automated browser viewport tests. Clearly distinguish viewport testing from testing on a real physical device.

## 14. Code quality requirements

Write code that another developer can understand and maintain.

- Use clear, descriptive names.
- Keep functions small and focused on one responsibility.
- Separate route handling, validation, business logic, persistence, and external integrations.
- Prefer straightforward control flow over clever abstractions.
- Avoid giant files, duplicated business rules, deeply nested conditionals, magic numbers, broad catch-and-ignore blocks, and unnecessary indirection.
- Generalize repeated behavior only after the shared behavior is understood. Do not create a framework inside the application for a single use case.
- Follow the repository's existing linting and formatting conventions; add tools only when useful and compatible.
- Use async/await consistently and handle rejected promises.
- Do not silently swallow errors or return fake success data.
- Avoid unnecessary dependencies. Explain a new dependency's purpose and operational cost.
- Add comments to explain non-obvious decisions, invariants, and trade-offs—not to narrate obvious code.
- Never disable lint rules or tests just to make a check pass.
- Do not refactor unrelated areas while fixing a focused bug.
- Update types/interfaces/schemas and tests whenever contracts change.

## 15. Testing and release gates

Inspect the existing scripts first. Use the actual commands defined in `package.json`; do not invent scripts and then claim they passed.

### Unit tests

Test:
- Lost/found request validation.
- AI response schema validation and malformed output.
- Attribute normalization and missing values.
- Matching scores, conflicting attributes, and thresholds.
- State transitions.
- Token validation, expiry, and permissions.
- Retry limits and backoff decisions.
- Idempotency and duplicate notification prevention.
- Temporary image cleanup and retention rules.

### Integration tests

Test:
- A report is persisted even if AI analysis fails.
- A valid image is sent to the vision adapter in the expected format.
- Invalid files are rejected before provider calls.
- Successful analysis saves validated attributes and deletes temporary image data.
- Transient provider errors retry only within the configured limit.
- Permanent provider errors do not loop indefinitely.
- Expired temporary images trigger the re-upload path.
- A stale `processing` job is recovered safely.
- Existing attributes prevent unnecessary repeat analysis after a crash.
- Duplicate jobs do not create duplicate matches or notifications.
- Contact details are not present in public API responses.
- Private tokens cannot access unrelated reports or actions.
- Closed reports do not trigger inappropriate new notifications.

### End-to-end tests

Verify the complete user journey:
1. A visitor opens the landing page without an account.
2. They submit a lost-item report.
3. Another visitor submits a found-item photo without manually describing its visual attributes.
4. The system extracts and validates attributes.
5. The matcher creates a potential match when appropriate.
6. Both parties receive the intended email notifications through a mocked provider in automated tests.
7. Private links show only authorized information.
8. A party can reject an incorrect match.
9. A confirmed recovery can be closed.
10. An AI outage leaves the report recoverable and displays a useful message.

### UI and regression tests

- Run lint, type checks if present, unit tests, integration tests, and build.
- Run end-to-end tests when available.
- Inspect the browser console and network failures.
- Verify light and dark themes.
- Test responsive widths, including ultrawide.
- Verify keyboard navigation and reduced-motion behavior.
- Test failure states, not only the happy path.

Do not report tests as passing unless they were executed and passed. If a test cannot run due to missing credentials, unavailable services, or environment limitations, state that explicitly and run the remaining tests.

## 16. Implementation order

Work in these phases and verify each phase before proceeding.

### Phase 1 — Audit and baseline
- Inspect repository and current deployment.
- Identify existing features and bugs.
- Run current checks and record the baseline.
- Review secret handling, uploads, and contact-data exposure.

### Phase 2 — Stable reporting flow
- Implement or refine anonymous lost/found reports.
- Validate all inputs and uploaded files.
- Persist report/job state reliably.
- Add private access tokens without account creation.

### Phase 3 — AI image analysis
- Integrate Gemini through a dedicated adapter.
- Validate structured output.
- Add timeouts, bounded retries, and explicit failure states.
- Ensure temporary image payloads are removed according to the retention policy.

### Phase 4 — Matching and notifications
- Implement deterministic matching and configurable thresholds.
- Persist match pairs idempotently.
- Send privacy-safe emails through a notification module.
- Implement confirmation, rejection, and recovery closure.

### Phase 5 — UI and responsive quality
- Apply the monochrome design system.
- Refine forms, upload preview, match views, and failure states.
- Test all critical screens at narrow, standard, large, and ultrawide widths.
- Fix animation and layout bugs based on observed evidence.

### Phase 6 — Verification and documentation
- Run all available checks.
- Test AI/email failures and recovery paths.
- Update `.env.example` and setup instructions.
- Document known limitations, provider costs/quotas, image retention, and deployment assumptions.

Do not attempt a large, unreviewed rewrite of all phases in one change.

## 17. Definition of done

A feature is done only when:
- Its behavior matches the product requirements.
- Server-side validation and authorization are correct.
- Errors and loading states are handled.
- Relevant tests have been run and their results are known.
- No real secrets or image payloads have been committed or logged.
- Responsive behavior has been checked at representative viewports.
- Existing functionality has not regressed.
- Documentation and environment examples are current.
- Any remaining limitations are explicitly reported.

At the end of each implementation phase, summarize:
1. What changed.
2. Why the approach was chosen.
3. Simpler alternatives considered and why they were not selected, when relevant.
4. Tests actually run and their results.
5. Known issues and remaining work.

## Final engineering rule

Build the smallest reliable system that helps people recover lost belongings. Use AI where it removes friction, but keep validation, authorization, matching policy, persistence, and recovery behavior explicit and testable. Favor simple, generalizable, production-conscious code over impressive-looking complexity.

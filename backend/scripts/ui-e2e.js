'use strict';

/**
 * UI end-to-end verification (AGENT.md §13, §15).
 *
 * Runs the FULL browser journey against a hermetic stack: in-memory MongoDB,
 * a real Express server on an ephemeral port, the real matching + notification
 * modules, a stubbed vision analyzer (capability is UI behavior, not the
 * provider), and email disabled (notifications recorded `disabled`, honest).
 *
 * Verifies:
 *  1-5. The §15 user journey: landing → lost report → found photo with
 *       AI-extracted attributes → automatic match → both confirms.
 *  6-9. Private views, decline/close, and the AI-outage → re-upload recovery
 *       path incl. an honest failure state (nothing fabricated).
 *  §13: viewport matrix (320/375/768/1024/1440/1920/2560 + tall-narrow,
 *       just-above/below the 640px breakpoint), console/error/overflow
 *       audits, dark + light themes, reduced motion, keyboard-only flow.
 *
 * Viewport checks run in a headless browser: this is NOT a claim about
 * physical devices (AGENT.md §13 says to distinguish the two).
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));
const sharp = require(path.join(__dirname, '..', 'node_modules', 'sharp'));

// Environment placeholders BEFORE any config module is loaded.
require('../tests/env');

const { startTestDb, stopTestDb } = require('../tests/helpers/db');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { startAnalysisWorker } = require('../src/modules/image-analysis/analysis.worker');
const matchingService = require('../src/modules/matching/match.service');
const Notification = require('../src/modules/notifications/notification.model');
const Match = require('../src/modules/matching/match.model');
const Report = require('../src/modules/reports/report.model');
const { GeminiPermanentError } = require('../src/infrastructure/gemini/client');
const { once } = require('events');

const ANALYZER_OUTPUT = {
  category: 'backpack',
  itemType: 'backpack',
  primaryColor: 'black',
  secondaryColors: [],
  brand: null,
  condition: 'good',
  visibleFeatures: ['two shoulder straps', 'laptop compartment'],
  uncertainAttributes: [],
  analysisVersion: '1',
};

const LOST_EMAIL = 'loser@example.test';
const FINDER_EMAIL = 'finder@example.test';

/** Collects per-page problems: console errors, uncaught errors, failed requests. */
function attachAuditors(page, problems, label) {
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push({ label, kind: 'console', text: message.text() });
  });
  page.on('pageerror', (error) => {
    problems.push({ label, kind: 'pageerror', text: String(error && error.message) });
  });
  page.on('requestfailed', (request) => {
    problems.push({ label, kind: 'requestfailed', text: `${request.url()} — ${request.failure() && request.failure().errorText}` });
  });
}

async function checkLayout(page, problems, label) {
  const audit = await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const horizontalOverflow =
      docEl.scrollWidth - docEl.clientWidth > 2 || body.scrollWidth - body.clientWidth > 2;
    const header = document.querySelector('.site-header');
    const main = document.querySelector('#main');
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0
        && rect.left < window.innerWidth && rect.top < window.innerHeight;
    };
    return {
      horizontalOverflow,
      headerVisible: visible(header),
      mainVisible: visible(main),
    };
  });
  if (audit.horizontalOverflow) problems.push({ label, kind: 'overflow', text: 'horizontal overflow detected' });
  if (!audit.headerVisible) problems.push({ label, kind: 'layout', text: 'header not visible' });
  if (!audit.mainVisible) problems.push({ label, kind: 'layout', text: 'main content not visible' });
}

async function main() {
  const problems = [];
  const notes = [];

  const mongod = await startTestDb();
  const app = createApp();
  const server = app.listen(0);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  notes.push(`server: ${baseUrl}`);

  const config = loadConfig();
  let analyzerMode = 'good';
  const analyzer = async () => {
    if (analyzerMode === 'good') return { ...ANALYZER_OUTPUT };
    throw new GeminiPermanentError('auth', 'Vision provider rejected the configured credentials');
  };
  const analysisWorker = startAnalysisWorker({ analyzer, config, logger: { info() {}, warn() {}, error() {} } });
  const matchingHooks = matchingService;
  const notificationsWorker = require('../src/modules/notifications/notification.worker')
    .startNotificationsWorker({
      transport: null, // email disabled in this hermetic run: honest disabled records
      config,
      logger: { info() {}, warn() {}, error() {} },
      onDelivered: (matchId) => matchingHooks.markSuggestionsDelivered(matchId),
    });

  const browser = await chromium.launch();

  try {
    /* ================= Journey (§15 steps 1–9) ================= */
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    attachAuditors(page, problems, 'journey');
    page.setDefaultTimeout(30000);

    // 1. Landing: product story; the primary CTAs live in the navbar.
    await page.goto(`${baseUrl}/`);
    await page.waitForSelector('[data-nav="lost"]');
    const navCtas = await page.locator('[data-nav]').count();
    if (navCtas !== 2) problems.push({ label: 'landing', kind: 'journey', text: `expected 2 navbar CTAs, got ${navCtas}` });
    notes.push('1. landing: navbar CTAs visible');

    // 2. Lost-item report through the form.
    await page.goto(`${baseUrl}/lost`);
    await page.fill('#itemName', 'black backpack');
    await page.fill('#description', 'A black backpack with two shoulder straps and a laptop inside.');
    await page.fill('input[name="color-0"]', 'black');
    await page.fill('#venue', 'Central Library');
    await page.fill('#incidentAt', new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 16));
    await page.fill('#contactEmail', LOST_EMAIL);
    await page.click('#submit-button');
    await page.waitForSelector('#token-code', { state: 'visible' });
    const lostToken = (await page.locator('#token-code').innerText()).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(lostToken)) {
      problems.push({ label: 'lost-flow', kind: 'journey', text: 'token not shown once in 43-char format' });
    }
    notes.push('2. lost report created; private token shown once');

    // 3. Found-item photo flow: no manual attribute typing.
    await page.goto(`${baseUrl}/found`);
    const photoPng = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).png().toBuffer();
    await page.setInputFiles('#image', { name: 'photo.png', mimeType: 'image/png', buffer: photoPng });
    await page.waitForSelector('#preview.is-visible');
    const previewAlt = await page.locator('#preview-image').getAttribute('alt');
    if (!previewAlt) problems.push({ label: 'found-flow', kind: 'journey', text: 'preview alt missing' });
    await page.fill('#contactEmail', FINDER_EMAIL);
    await page.fill('#venue', 'Central Library');
    await page.fill('#incidentAt', new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 16));
    await page.click('#submit-button');
    // 4-5. Honest polling → completed attributes.
    await page.waitForSelector('#attributes-panel:not([hidden])', { timeout: 60000 });
    const attributesText = await page.locator('#attributes-list').innerText();
    if (!attributesText.toLowerCase().includes('backpack')) {
      problems.push({ label: 'found-flow', kind: 'journey', text: `extracted attributes not shown: ${attributesText}` });
    }
    notes.push('3-4. found flow completed; AI attributes displayed (photo-only inputs)');

    await page.waitForSelector('#token-code', { state: 'visible' });
    const foundToken = (await page.locator('#token-code').innerText()).trim();

    // 5. The matcher created a potential match automatically.
    const notifications = await Notification.find({}).select('+partyMatchToken').lean();
    const loserToken = notifications.find((n) => n.role === 'loser');
    const finderToken = notifications.find((n) => n.role === 'finder');
    if (!loserToken || !finderToken) {
      problems.push({ label: 'matching', kind: 'journey', text: 'notifications for the match were not created' });
    } else {
      notes.push('5. match created automatically; both parties notified (records exist, email disabled)');
    }

    // 6. Loser's private match view: scoped, confirmable, no contact leak.
    const loserPage = await context.newPage();
    attachAuditors(loserPage, problems, 'match-loser');
    loserPage.setDefaultTimeout(15000);
    await loserPage.goto(`${baseUrl}/match/${loserToken.partyMatchToken}`);
    await loserPage.waitForSelector('#factors-panel:not([hidden])');
    const contactBefore = await loserPage.locator('#contact-panel').isVisible();
    if (contactBefore) problems.push({ label: 'privacy', kind: 'journey', text: 'contact panel visible before mutual confirm' });
    await loserPage.click('#confirm-arm');
    await loserPage.click('#confirm-confirm');
    await loserPage.waitForFunction(() =>
      document.querySelector('#match-state') && document.querySelector('#match-state').textContent.includes('Suggested')
    );
    const loserStillNoContact = await loserPage.locator('#contact-panel').isVisible();
    if (loserStillNoContact) {
      problems.push({ label: 'privacy', kind: 'journey', text: 'contact visible after only ONE confirmation' });
    }
    notes.push('6. loser confirmed; contact still withheld after one-sided confirm');

    // 7. Finder confirms → contact revealed on their view.
    const finderPage = await context.newPage();
    attachAuditors(finderPage, problems, 'match-finder');
    finderPage.setDefaultTimeout(15000);
    await finderPage.goto(`${baseUrl}/match/${finderToken.partyMatchToken}`);
    await finderPage.waitForSelector('#confirm-row:not([hidden])');
    await finderPage.click('#reject-arm'); // cancel-path sanity: arm, then NOT decline
    await finderPage.click('#reject-cancel');
    await finderPage.click('#confirm-arm');
    await finderPage.click('#confirm-confirm');
    await finderPage.waitForSelector('#contact-panel:not([hidden])');
    const revealed = await finderPage.locator('#contact-email').innerText();
    if (revealed.trim() !== LOST_EMAIL) {
      problems.push({ label: 'confirm', kind: 'journey', text: `unexpected contact revealed: ${revealed}` });
    }
    notes.push('7. mutual confirm → contact details revealed (only now)');

    // 8. Close the lost report through its private page.
    const reportPage = await context.newPage();
    attachAuditors(reportPage, problems, 'report-page');
    reportPage.setDefaultTimeout(15000);
    await reportPage.goto(`${baseUrl}/report/${lostToken}`);
    await reportPage.waitForSelector('#close-panel:not([hidden])');
    await reportPage.click('#close-arm');
    await reportPage.click('#close-confirm');
    await reportPage.waitForFunction(() =>
      document.querySelector('#close-banner') && document.querySelector('#close-banner').textContent.includes('closed')
    );
    const lostRow = await Report.findOne({ 'contactEmail': LOST_EMAIL });
    if (!lostRow || lostRow.status !== 'closed') {
      problems.push({ label: 'close', kind: 'journey', text: 'lost report not closed in DB' });
    }
    notes.push('8. report closed through the UI; match resolved');

    const matchRow = await Match.findOne({});
    if (!matchRow || matchRow.status !== 'resolved') {
      problems.push({ label: 'close', kind: 'journey', text: `match should be resolved after close, got ${matchRow && matchRow.status}` });
    }

    // 9. AI outage → honest failure state → re-upload recovery.
    analyzerMode = 'auth-error';
    const outagePage = await context.newPage();
    attachAuditors(outagePage, problems, 'outage');
    outagePage.setDefaultTimeout(60000);
    await outagePage.goto(`${baseUrl}/found`);
    const outagePhoto = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 90, g: 90, b: 90 } },
    }).png().toBuffer();
    await outagePage.setInputFiles('#image', { name: 'dim.png', mimeType: 'image/png', buffer: outagePhoto });
    await outagePage.fill('#contactEmail', FINDER_EMAIL);
    await outagePage.click('#submit-button');
    await outagePage.waitForSelector('#action-panel:not([hidden])', { timeout: 60000 });
    const outageText = await outagePage.locator('#action-title').innerText();
    if (!/new photo/i.test(outageText)) {
      problems.push({ label: 'outage', kind: 'journey', text: `failure state not honest: "${outageText}"` });
    }
    notes.push('9. AI outage kept the report recoverable with a useful message');

    // Recovery: fixed analyzer, different photo via the re-upload control.
    analyzerMode = 'good';
    const recoveryPhoto = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 20, g: 20, b: 120 } },
    }).png().toBuffer();
    await outagePage.setInputFiles('#retry-image', { name: 'fixed.png', mimeType: 'image/png', buffer: recoveryPhoto });
    await outagePage.click('#retry-button');
    await outagePage.waitForSelector('#attributes-panel:not([hidden])', { timeout: 60000 });
    notes.push('9b. re-upload recovered the analysis; attributes rendered');

    /* ================= Viewport matrix (§13) ================= */
    const widths = [320, 375, 640, 641, 768, 1024, 1440, 1920, 2560];
    const matrixUrls = [
      ['landing', `${baseUrl}/`],
      ['lost-form', `${baseUrl}/lost`],
      ['found-form', `${baseUrl}/found`],
      ['report-page', `${baseUrl}/report/${lostToken}`],
      ...(!loserToken ? [] : [['match-page', `${baseUrl}/match/${loserToken.partyMatchToken}`]]),
    ];
    for (const [pageName, url] of matrixUrls) {
      for (const width of widths) {
        const height = width === 320 ? 1200 : 900; // tall/narrow mobile for 320
        const ctx = await browser.newContext({ viewport: { width, height } });
        const matrixPage = await ctx.newPage();
        const label = `${pageName}@${width}`;
        attachAuditors(matrixPage, problems, label);
        try {
          await matrixPage.goto(url, { waitUntil: 'load' });
          await matrixPage.waitForTimeout(150);
          await checkLayout(matrixPage, problems, label);
        } catch (error) {
          problems.push({ label, kind: 'exception', text: String(error && error.message) });
        } finally {
          await ctx.close();
        }
      }
    }
    notes.push('§13 viewport matrix done (320…2560 incl. just-above/below 640px, tall-narrow at 320)');

    /* ================= Themes, motion, keyboard (§12/§13) ================= */
    for (const scheme of ['dark', 'light']) {
      const ctx = await browser.newContext({
        viewport: { width: 1024, height: 800 },
        colorScheme: scheme,
      });
      const themePage = await ctx.newPage();
      attachAuditors(themePage, problems, `theme-${scheme}`);
      await themePage.goto(`${baseUrl}/`);
      await themePage.waitForSelector('.site-header');
      const colors = await themePage.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      const expectedBg = scheme === 'dark' ? 'rgb(15, 15, 15)' : 'rgb(255, 255, 255)';
      if (colors.bg !== expectedBg) {
        problems.push({ label: `theme-${scheme}`, kind: 'theme', text: `body bg ${colors.bg}, expected ${expectedBg}` });
      }
      notes.push(`theme ${scheme}: body bg ${colors.bg}, text ${colors.text}`);
      await ctx.close();
    }

    // Explicit theme toggle persists across reload (single icon button: the
    // context starts system-light, so one click switches to dark).
    const themeCtx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
    const themePage = await themeCtx.newPage();
    await themePage.goto(`${baseUrl}/`);
    await themePage.click('[data-theme-toggle]');
    // The switch applies via document.startViewTransition (async callback)
    // and is then eased by the body-color transition; wait for the settled
    // final background regardless of engine path.
    await themePage.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor === 'rgb(15, 15, 15)',
      null,
      { timeout: 3000 },
    );
    const afterManualDark = await themePage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (afterManualDark !== 'rgb(15, 15, 15)') {
      problems.push({ label: 'theme-manual', kind: 'theme', text: `manual dark choice failed: ${afterManualDark}` });
    }
    await themePage.reload();
    const persisted = await themePage.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (persisted !== 'rgb(15, 15, 15)') {
      problems.push({ label: 'theme-manual', kind: 'theme', text: 'manual theme did not persist across reload' });
    }
    await themeCtx.close();
    notes.push('theme switch: explicit dark choice persists across reload');

    // Reduced motion: transitions collapse to the safe minimum duration.
    const motionCtx = await browser.newContext({
      viewport: { width: 1024, height: 800 },
      reducedMotion: 'reduce',
    });
    const motionPage = await motionCtx.newPage();
    await motionPage.goto(`${baseUrl}/lost`); // .btn lives on form pages
    const motionDuration = await motionPage.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionDuration);
    // Chromium normalizes 0.01ms → 1e-05s; both mean "effectively no motion".
    const motionHonored = ['0s', '0.01ms', '1e-05s'].includes(motionDuration) ||
      parseFloat(motionDuration) <= 0.001;
    if (!motionHonored) {
      problems.push({ label: 'reduced-motion', kind: 'motion', text: `transition still ${motionDuration}` });
    }
    await motionCtx.close();
    notes.push('reduced motion honored (transitions ~0ms)');

    // Keyboard-only journey on the lost form. The datetime control consumes
    // several internal tab stops (month/day/year segments in Chromium), so
    // focus jumps are used for traversal while all typing stays keyboard-only.
    const kbCtx = await browser.newContext({ viewport: { width: 375, height: 850 } });
    const kbPage = await kbCtx.newPage();
    attachAuditors(kbPage, problems, 'keyboard');
    await kbPage.goto(`${baseUrl}/lost`);
    await kbPage.focus('#itemName');
    await kbPage.keyboard.type('keyboard backpack');
    await kbPage.keyboard.press('Tab');
    await kbPage.keyboard.type('A keyboard-only description of a black backpack, typed without a mouse.');
    await kbPage.focus('#contactEmail');
    await kbPage.keyboard.type(LOST_EMAIL);
    await kbPage.keyboard.press('Enter');
    await kbPage.waitForSelector('#token-code', { state: 'visible' });
    notes.push('keyboard-only journey: complete lost report via keyboard + Enter');
    await kbCtx.close();

    await context.close();

    /* ================= Verdict ================= */
    const unique = problems.filter(
      (item, index, all) => all.findIndex((other) => other.label === item.label && other.kind === item.kind && other.text === item.text) === index
    );
    if (unique.length > 0) {
      console.log('\n=== UI E2E: PROBLEMS FOUND ===');
      for (const item of unique) {
        console.log(`[${item.label}] ${item.kind}: ${item.text}`);
      }
      process.exitCode = 1;
    } else {
      console.log('\n=== UI E2E: ALL CHECKS PASSED ===');
    }
    for (const note of notes) console.log('—', note);
  } finally {
    // Hard-clean hermetic state (guaranteed run even after failures).
    await browser.close().catch(() => {});
    analysisWorker.stop();
    notificationsWorker.stop();
    server.close();
    await Report.deleteMany({}).catch(() => {});
    await Match.deleteMany({}).catch(() => {});
    await Notification.deleteMany({}).catch(() => {});
    await stopTestDb(mongod).catch(() => {});
  }
}

main().catch((error) => {
  console.error('UI E2E harness failed:', error);
  process.exit(1);
});

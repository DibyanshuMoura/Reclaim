'use strict';

/**
 * Reclaim frontend helpers — dependency-free, no build step.
 *
 * Loaded synchronously in <head> so the theme is applied before first paint
 * (CSP forbids inline scripts). All functions attach to window.Reclaim;
 * per-page scripts load with `defer` and only call these helpers.
 */
(function () {
  /* ---- Server contract, mirrored for client-side convenience -----------
     Mirrors src/modules/reports/report.validation.js LIMITS. The server
     remains authoritative; these only make obvious mistakes cheap to fix. */
  const LIMITS = Object.freeze({
    itemName: 100,
    description: 2000,
    descriptionMin: 10,
    color: 30,
    colors: 5,
    brand: 50,
    venue: 120,
    locationDescription: 300,
    contactEmail: 254,
  });

  const IMAGE = Object.freeze({
    field: 'image',
    maxBytes: 5 * 1024 * 1024,
    accepts: 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp',
    label: 'JPEG, PNG, or WEBP, up to 5 MB',
  });

  /* Split-stack hosting: js/config.js may point the API at another origin
     (frontend on Vercel, API on Render). Empty keeps this origin — the
     single-app mode the backend serves by default. */
  const API_BASE = `${window.RECLAIM_API_BASE || ''}/api/v1`;

  /* ---- Theme: single icon toggle (light / dark) ----------------------------
     No visible "system" state: a saved choice is applied as-is; with no
     choice saved the OS theme is resolved and followed live. The button's
     icon is CSS-rendered from html[data-theme] — moon while light, sun
     while dark (SVG ignores the `hidden` IDL property, so CSS owns the
     swap) — and aria-pressed reflects the active theme. */

  const THEME_STORAGE_KEY = 'reclaim-theme';

  function readSavedTheme() {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'light' || saved === 'dark' ? saved : null;
    } catch (storageError) {
      return null; // Private modes can deny storage access.
    }
  }

  function writeSavedTheme(theme) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (storageError) {
      /* The choice still applies for this session if persistence fails. */
    }
  }

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /** Saved choice if one exists, else the resolved OS theme. Never "system". */
  function effectiveTheme() {
    return readSavedTheme() || systemTheme();
  }

  function applyThemeChoiceUi(active) {
    /* The icon swap is rendered entirely in CSS, keyed on
       html[data-theme] (moon while light, sun while dark): SVG elements
       ignore the `hidden` IDL property, so toggling attributes from JS
       is unreliable. JS only tracks pressed state and labels here. */
    const button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    button.setAttribute('aria-pressed', active === 'dark' ? 'true' : 'false');
    const nextLabel = active === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    button.setAttribute('aria-label', nextLabel);
    button.setAttribute('title', nextLabel);
  }

  function applyTheme(theme) {
    if (theme !== 'light' && theme !== 'dark') theme = effectiveTheme();
    document.documentElement.dataset.theme = theme;
    applyThemeChoiceUi(theme);
    const metaColor = document.querySelector('meta[name="theme-color"]');
    if (metaColor) metaColor.setAttribute('content', theme === 'dark' ? '#0f0f0f' : '#ffffff');
  }

  /**
   * Theme switch with a whole-page reveal: in the View Transition API the
   * new theme expands as a circle from the toggle button (the button's
   * center is passed as the reveal origin); browsers without the API, and
   * users with reduced motion, keep the softer body-color transition from
   * CSS, or an instant change under reduce.
   */
  function applyTransitionedTheme(theme, origin) {
    const supportsViewTransition = typeof document.startViewTransition === 'function';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!supportsViewTransition || reducedMotion) {
      applyTheme(theme);
      return;
    }
    if (origin && typeof origin.x === 'number' && typeof origin.y === 'number') {
      const { x, y } = origin;
      const maxRadius = Math.ceil(Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      ));
      document.documentElement.style.setProperty('--theme-reveal-x', `${Math.round(x)}px`);
      document.documentElement.style.setProperty('--theme-reveal-y', `${Math.round(y)}px`);
      document.documentElement.style.setProperty('--theme-reveal-max', `${maxRadius + 2}px`);
    }
    document.startViewTransition(() => applyTheme(theme));
  }

  function initTheme() {
    applyTheme(effectiveTheme());
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-toggle]');
      if (!button) return;
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      writeSavedTheme(next);
      // The reveal grows from the clicked button (its center, viewport coords).
      const rect = button.getBoundingClientRect();
      applyTransitionedTheme(next, {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    });
    /* Until a choice is saved, follow live OS changes, not a snapshot. */
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const followSystem = () => {
      if (!readSavedTheme()) applyTheme(effectiveTheme());
    };
    if (media.addEventListener) {
      media.addEventListener('change', followSystem);
    } else if (media.addListener) {
      media.addListener(followSystem); // older Safari
    }
  }

  applyTheme(effectiveTheme()); // before first paint (script runs in <head>)
  document.addEventListener('DOMContentLoaded', initTheme);

  /* ---- Small utilities -------------------------------------------------- */

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(
      /[&<>"']/g,
      (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[ch])
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return '—';
    return parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  /** Local datetime → ISO conversion for datetime-local inputs. */
  function datetimeLocalToIso(rawValue) {
    if (!rawValue) return undefined;
    const parsed = new Date(rawValue);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return parsed.toISOString();
  }

  /* ---- API ------------------------------------------------------------ */

  async function api(path, options = {}) {
    const init = { method: options.method || 'GET', headers: {} };
    if (options.body !== undefined) {
      if (options.body instanceof FormData) {
        init.body = options.body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch (networkError) {
      return {
        ok: false,
        status: 0,
        data: { message: 'Network request failed. Check your connection and try again.' },
      };
    }
    let data = {};
    try {
      data = await response.json();
    } catch (parseError) {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  }

  /* ---- Tokens ----------------------------------------------------------- */

  const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

  /**
   * Private tokens arrive as the LAST path segment (/report/<token>) or a
   * ?token= query. Kept out of markup by the server; the page reads the bar.
   */
  function tokenFromLocation() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    if (TOKEN_RE.test(last)) return last;
    const fromQuery = new URLSearchParams(window.location.search).get('token') || '';
    return TOKEN_RE.test(fromQuery) ? fromQuery : '';
  }

  function invalidTokenBanner() {
    return {
      title: 'This link is not valid',
      body: 'Private links carry an access token. Check that the link was copied completely, or contact the sender for a fresh one.',
    };
  }

  /* ---- Text maps (plain language, no jargon) ----------------------------- */

  const LABELS = Object.freeze({
    lifecycle: Object.freeze({
      open: 'Open',
      matched: 'Matched',
      recovery_in_progress: 'Recovery in progress',
      recovered: 'Recovered',
      closed: 'Closed',
    }),
    analysis: Object.freeze({
      not_required: 'Not needed',
      pending: 'Analysis queued',
      processing: 'Analyzing photo',
      completed: 'Analysis complete',
      retryable_failed: 'Analysis retrying',
      needs_user_action: 'Needs your attention',
      permanent_failed: 'Analysis failed',
    }),
    match: Object.freeze({
      suggested: 'Suggested',
      notified: 'Notified',
      confirmed: 'Confirmed',
      rejected: 'Rejected',
      resolved: 'Resolved',
    }),
    role: Object.freeze({
      loser: 'You reported the lost item',
      finder: 'You reported the found item',
    }),
  });

  function label(group, value) {
    return (LABELS[group] && LABELS[group][value]) || value || '—';
  }

  /* ---- Rendering helpers -------------------------------------------------- */

  function chip(group, value) {
    const good = ['completed', 'confirmed', 'recovered'].includes(value);
    const bad = ['needs_user_action', 'permanent_failed', 'rejected', 'resolved', 'closed'].includes(value);
    const tone = good ? ' chip--good' : bad ? ' chip--bad' : '';
    return `<span class="chip${tone}">${escapeHtml(label(group, value))}</span>`;
  }

  function bannerHtml(kind, html) {
    return `<div class="banner banner--${kind}" role="status">${html}</div>`;
  }

  function showBanner(container, kind, html) {
    container.innerHTML = bannerHtml(kind, html);
  }

  /**
   * Backends return { message, details: [{ field, message }] }; map server
   * field errors onto the matching inputs. Unknown fields go to the summary.
   */
  function applyFieldErrors(form, details, summaryContainer) {
    Object.values(form.querySelectorAll('.field')).forEach((field) => {
      field.classList.remove('has-error');
      const text = field.querySelector('.field__error');
      if (text) text.textContent = '';
    });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    const unknown = [];
    (details || []).forEach(({ field, message }) => {
      const input = form.querySelector(`[name="${CSS.escape(field)}"]`);
      const colorInput = form.querySelector(`[data-color-group] [name="${CSS.escape(field + '-0')}"]`);
      const wrapper = field === 'image' ? form.querySelector('[data-image-fields]') : null;
      if (input) {
        const holder = input.closest('.field') || wrapper;
        if (holder) {
          holder.classList.add('has-error');
          const text = holder.querySelector('.field__error');
          if (text) text.textContent = message;
          input.setAttribute('aria-invalid', 'true');
          return;
        }
      }
      if (colorInput || field.startsWith('colors')) {
        const group = form.querySelector('[data-color-group]');
        if (group) {
          group.classList.add('has-error');
          const text = group.querySelector('.field__error');
          if (text) text.textContent = message;
          return;
        }
      }
      if (wrapper) {
        wrapper.classList.add('has-error');
        const text = wrapper.querySelector('.field__error');
        if (text) text.textContent = message;
        return;
      }
      unknown.push(message);
    });
    if (unknown.length > 0 && summaryContainer) {
      showBanner(summaryContainer, 'error', escapeHtml(unknown.join(' — ')));
      return true;
    }
    return unknown.length > 0;
  }

  function clearFieldErrors(form) {
    Object.values(form.querySelectorAll('.field')).forEach((field) => {
      field.classList.remove('has-error');
      const text = field.querySelector('.field__error');
      if (text) text.textContent = '';
    });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  }

  /** Marks a button busy without changing its width or meaning. */
  function setBusy(button, busy) {
    if (busy) {
      button.dataset.label = button.textContent;
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      button.textContent = 'Working…';
    } else {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /* ---- Copy helpers (delegated, works for dynamically rendered views) ----- */

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      // Clipboard API may be missing on http origins; fall back to selection.
      const scratch = document.createElement('textarea');
      scratch.value = value;
      scratch.setAttribute('readonly', 'readonly');
      scratch.style.position = 'fixed';
      scratch.style.left = '-9999px';
      document.body.appendChild(scratch);
      scratch.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch (fallbackError) {
        copied = false;
      }
      document.body.removeChild(scratch);
      return copied;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy]');
    if (!button) return;
    const copied = await copyText(button.dataset.copy);
    const previous = button.textContent;
    button.textContent = copied ? 'Copied ✓' : 'Copy failed — select the text manually';
    button.disabled = true;
    setTimeout(() => {
      button.textContent = previous;
      button.disabled = false;
    }, 1600);
  });

  /* ---- Private report polling -------------------------------------------- */

  const TERMINAL_ANALYSIS = ['completed', 'needs_user_action', 'permanent_failed'];

  /**
   * Polls the private report endpoint until analysis reaches a terminal
   * state (or retryable retries exhaust the window). Honest by construction:
   * the UI shows the ACTUAL status text, never a fabricated progress bar.
   */
  async function pollReport(token, hooks) {
    const { intervalMs = 3000, timeoutMs = 180000, onTick, onPollError, onTimeout } = hooks;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { ok, status, data } = await api(`${API_BASE}/private/reports/${encodeURIComponent(token)}`);
      if (!ok) {
        if (onPollError) onPollError(status, data);
        return null;
      }
      const report = data.report;
      if (!report) {
        if (onPollError) onPollError(status || 500, {});
        return null;
      }
      if (onTick) onTick(report);
      if (TERMINAL_ANALYSIS.includes(report.analysisStatus)) return report;
      await sleep(intervalMs);
    }
    if (onTimeout) onTimeout();
    return null;
  }

  /* ---- Score presentation (honest, static data displays) ------------------ */

  /**
   * Ten-cell meter, cells filled = round(score/10). A static display of the
   * actual value — no animation, no fake fill progression.
   */
  function scoreMeterHtml(score) {
    const bounded = Math.max(0, Math.min(100, Number(score) || 0));
    const filled = Math.round(bounded / 10);
    const cells = [];
    for (let i = 0; i < 10; i += 1) {
      cells.push(`<span class="meter__cell${i < filled ? ' is-filled' : ''}"></span>`);
    }
    return `<div class="meter" role="img" aria-label="Affinity ${bounded} of 100, shown as ${filled} of 10 filled cells">${cells.join('')}</div>
      <div class="meter-caption"><span>weak evidence</span><span><strong>${bounded}</strong> / 100</span><span>strong evidence</span></div>`;
  }

  /** Factor direction symbol: + strong agreement, ~ partial, − conflict, 0 neutral. */
  function factorSymbol(score) {
    if (score >= 0.3) return { glyph: '+', cls: 'factor__sym--plus' };
    if (score <= -0.05) return { glyph: '−', cls: 'factor__sym--minus' };
    if (score > 0) return { glyph: '~', cls: '' };
    return { glyph: '0', cls: '' };
  }

  window.Reclaim = {
    LIMITS,
    IMAGE,
    API_BASE,
    escapeHtml,
    sleep,
    formatDateTime,
    datetimeLocalToIso,
    api,
    tokenFromLocation,
    invalidTokenBanner,
    label,
    chip,
    bannerHtml,
    showBanner,
    applyFieldErrors,
    clearFieldErrors,
    setBusy,
    copyText,
    pollReport,
    TERMINAL_ANALYSIS,
    scoreMeterHtml,
    factorSymbol,
  };
})();

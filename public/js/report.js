'use strict';

/* Private report page: renders the reporter's own report via token,
   with honest status, close action, and photo re-upload recovery. */
(function () {
  const {
    api, escapeHtml, tokenFromLocation, invalidTokenBanner, showBanner,
    setBusy, pollReport, label: mapLabel, formatDateTime, chip, IMAGE,
  } = window.Reclaim;

  const summary = document.getElementById('error-summary');
  const statusPanel = document.getElementById('status-panel');
  const detailsPanel = document.getElementById('details-panel');
  const attributesPanel = document.getElementById('attributes-panel');
  const closePanel = document.getElementById('close-panel');
  const retryPanel = document.getElementById('retry-panel');
  const closeBanner = document.getElementById('close-banner');
  const retryBanner = document.getElementById('retry-banner');
  const pollLine = document.getElementById('poll-line');

  let currentReport = null;
  const accessToken = tokenFromLocation();

  const DETAIL_LABELS = {
    itemName: 'Item name',
    description: 'Description',
    colors: 'Colors',
    brand: 'Brand',
    venue: 'Venue',
    locationDescription: 'Where exactly',
    incidentAt: 'Reported time',
    contactEmail: 'Contact email',
  };

  const ATTRIBUTE_LABELS = {
    category: 'Category',
    itemType: 'Item type',
    primaryColor: 'Main color',
    secondaryColors: 'Other colors',
    brand: 'Brand',
    condition: 'Condition',
    visibleFeatures: 'Visible features',
    uncertainAttributes: 'Unsure about',
  };

  function renderList(value) {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  function renderKv(listElement, entries) {
    listElement.innerHTML = entries.map(([name, value]) =>
      `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join('');
  }

  function renderStatus(report) {
    document.getElementById('status-report-type').textContent =
      report.reportType === 'lost' ? 'Lost item' : 'Found item';
    document.getElementById('status-lifecycle').innerHTML = chip('lifecycle', report.status);
    document.getElementById('status-analysis').innerHTML = chip('analysis', report.analysisStatus);
    document.getElementById('status-created').textContent = formatDateTime(report.createdAt);
  }

  function renderDetails(report) {
    const entries = Object.entries(DETAIL_LABELS)
      .filter(([key]) => {
        if (report.reportType === 'found' && key === 'itemName') return false;
        return report[key] !== undefined && report[key] !== null;
      })
      .map(([key, name]) => {
        const value = key === 'incidentAt' && report.incidentAt
          ? formatDateTime(report.incidentAt)
          : renderList(report[key]);
        return [name, value];
      });
    renderKv(document.getElementById('details-list'), entries);
    detailsPanel.hidden = entries.length === 0;
  }

  function renderAttributes(report) {
    if (report.reportType !== 'found' || !report.attributes) {
      attributesPanel.hidden = true;
      return;
    }
    const entries = Object.entries(report.attributes)
      .filter(([key]) => Object.prototype.hasOwnProperty.call(ATTRIBUTE_LABELS, key))
      .filter(([, value]) => !(value === null || value === undefined || value === '' ||
        (Array.isArray(value) && value.length === 0) || value === 'unknown'))
      .map(([key, value]) => [ATTRIBUTE_LABELS[key], renderList(value)]);
    renderKv(document.getElementById('attributes-list'), entries);
    attributesPanel.hidden = entries.length === 0;
  }

  function renderActions(report) {
    const closable = report.status === 'open' || report.status === 'matched';
    closePanel.hidden = !closable;
    resetCloseButtons();

    const retryable =
      report.reportType === 'found' &&
      ['needs_user_action', 'permanent_failed'].includes(report.analysisStatus);
    retryPanel.hidden = !retryable;
    pollLine.hidden = true;
  }

  function resetCloseButtons() {
    document.getElementById('close-arm').hidden = false;
    document.getElementById('close-confirm').hidden = true;
    document.getElementById('close-cancel').hidden = true;
  }

  /* ---- Loading and live polling -------------------------------------------- */

  function applyReport(report) {
    currentReport = report;
    statusPanel.hidden = false;
    renderStatus(report);
    renderDetails(report);
    renderAttributes(report);
    renderActions(report);
  }

  async function loadTokenPage(token) {
    const { ok, status, data } = await api(
      `${window.Reclaim.API_BASE}/private/reports/${encodeURIComponent(token)}`
    );
    if (!ok) {
      if (status === 404) {
        const invalid = invalidTokenBanner();
        showBanner(summary, 'error', `<strong>${invalid.title}.</strong> ${invalid.body}`);
        return;
      }
      showBanner(summary, 'error', escapeHtml(data.message || 'Loading the report failed. Try again later.'));
      return;
    }
    applyReport(data.report);
    maybeWatchAnalysis(token, data.report);
  }

  function maybeWatchAnalysis(token, report) {
    const watching = ['pending', 'processing', 'retryable_failed'].includes(report.analysisStatus);
    if (!watching) return;
    const startedAt = Date.now();
    pollLine.hidden = false;
    pollReport(token, {
      intervalMs: 4000,
      timeoutMs: 120000,
      onTick(latest) {
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        pollLine.textContent =
          `Analysis status: ${mapLabel('analysis', latest.analysisStatus)} · ${elapsed}s elapsed · checking every 4 s`;
      },
      onPollError() {},
      onTimeout() {
        pollLine.textContent = 'Analysis is taking longer than expected. Reload this page later to see the result.';
      },
    }).then((finalReport) => {
      if (!finalReport) {
        if (currentReport) renderActions(currentReport);
        return;
      }
      applyReport(finalReport);
      if (finalReport.analysisStatus === 'completed') {
        showBanner(summary, 'success', 'The photo analysis finished — extracted attributes are shown below.');
      } else {
        showBanner(
          summary,
          'error',
          'The analysis could not complete with the current photo. Upload a different one below — nothing was invented to fill the gaps.'
        );
      }
      pollLine.hidden = true;
    });
  }

  /* ---- Close flow: two explicit steps, no surprise state changes ------------ */

  const closeArm = document.getElementById('close-arm');
  const closeConfirm = document.getElementById('close-confirm');
  const closeCancel = document.getElementById('close-cancel');

  closeArm.addEventListener('click', () => {
    closeArm.hidden = true;
    closeConfirm.hidden = false;
    closeCancel.hidden = false;
    closeConfirm.focus();
  });

  closeCancel.addEventListener('click', () => {
    resetCloseButtons();
    closeBanner.innerHTML = '';
  });

  closeConfirm.addEventListener('click', async () => {
    if (!currentReport) return;
    closeConfirm.hidden = true;
    closeCancel.hidden = true;
    setBusy(closeArm, true);
    // The close endpoint authenticates by the private ACCESS TOKEN, not the
    // report id — tokens never leave the URL bar context.
    const { ok, status, data } = await api(
      `${window.Reclaim.API_BASE}/private/reports/${encodeURIComponent(accessToken)}/close`,
      { method: 'POST' }
    );
    setBusy(closeArm, false);

    if (ok && data.report) {
      showBanner(closeBanner, 'success', 'Report closed. Matching has stopped for this report.');
      closePanel.hidden = true;
      applyReport(data.report);
      return;
    }
    closeArm.hidden = false;
    showBanner(
      closeBanner,
      'error',
      escapeHtml(
        status === 409
          ? 'This report cannot be closed from its current state.'
          : data.message || 'Closing the report failed'
      )
    );
  });

  /* ---- Photo recovery -------------------------------------------------------- */

  const retryInput = document.getElementById('retry-image');
  const retryButton = document.getElementById('retry-button');

  function validateRetryFile(file) {
    if (!file) return 'Choose a photo of the item';
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (file.type && !allowed.includes(file.type)) {
      return `Unsupported image type (${file.type}). Accepted: ${IMAGE.label}`;
    }
    if (file.size > IMAGE.maxBytes) {
      return 'This file is too large. The limit is 5 MB.';
    }
    return null;
  }

  retryButton.addEventListener('click', async () => {
    const file = retryInput.files && retryInput.files[0];
    const problem = validateRetryFile(file);
    if (problem) {
      showBanner(retryBanner, 'error', escapeHtml(problem));
      return;
    }
    if (!currentReport) return;

    const payload = new FormData();
    payload.append(IMAGE.field, file);
    // Token-based auth again: the report id is not a credential.
    setBusy(retryButton, true);
    const { ok, status, data } = await api(
      `${window.Reclaim.API_BASE}/private/reports/${encodeURIComponent(accessToken)}/image`,
      { method: 'POST', body: payload }
    );
    setBusy(retryButton, false);

    if (ok && data.report) {
      showBanner(retryBanner, 'success', 'New photo accepted — the analysis restarts automatically.');
      retryInput.value = '';
      applyReport(data.report);
      maybeWatchAnalysis(accessToken, data.report);
      return;
    }
    showBanner(
      retryBanner,
      'error',
      escapeHtml(
        status === 404
          ? 'This report link is not valid.'
          : data.message || 'Uploading the photo failed'
      )
    );
  });

  /* ---- Entry ------------------------------------------------------------------ */

  if (!accessToken) {
    const invalid = invalidTokenBanner();
    showBanner(summary, 'error', `<strong>${invalid.title}.</strong> ${invalid.body}`);
  } else {
    loadTokenPage(accessToken);
  }
})();

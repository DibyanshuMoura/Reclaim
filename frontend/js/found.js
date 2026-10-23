'use strict';

/* Found-item flow (AGENT.md §2): photo → attributes inferred by AI.
   The analysis state is shown honestly; the report itself is already safe. */
(function () {
  const {
    api, escapeHtml, datetimeLocalToIso, showBanner,
    applyFieldErrors, setBusy, pollReport, label: statusLabel, IMAGE,
  } = window.Reclaim;

  const form = document.getElementById('found-form');
  const formSection = document.getElementById('form-section');
  const progressSection = document.getElementById('progress-section');
  const progressLine = document.getElementById('progress-line');
  const resultSection = document.getElementById('result-section');
  const resultBanner = document.getElementById('result-banner');
  const summary = document.getElementById('error-summary');
  const submitButton = document.getElementById('submit-button');
  const retryButton = document.getElementById('retry-button');

  /* Camera hint only where a camera is the primary input device. */
  const imageInput = form.elements.image;
  if (window.matchMedia('(pointer: coarse)').matches) {
    imageInput.setAttribute('capture', 'environment');
  }

  /* The server rejects future times; the picker should not offer them. */
  const incidentAtInput = form.elements.incidentAt;
  incidentAtInput.max = new Date(Date.now() - 60 * 1000)
    .toISOString()
    .slice(0, 16);

  /* ---- File selection + preview ------------------------------------------ */

  const preview = document.getElementById('preview');
  const previewImage = document.getElementById('preview-image');
  const previewMeta = document.getElementById('preview-meta');
  const removePreviewButton = document.getElementById('remove-preview');
  const imageFields = form.querySelector('[data-image-fields]');

  function humanBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function revokePreviewUrl() {
    if (previewImage.src && previewImage.src.startsWith('blob:')) {
      URL.revokeObjectURL(previewImage.src);
    }
  }

  function resetImagePreview() {
    revokePreviewUrl();
    preview.classList.remove('is-visible');
    previewImage.removeAttribute('src');
    previewImage.removeAttribute('alt');
    previewMeta.textContent = '';
    imageInput.value = '';
  }

  function showImagePreview(file) {
    revokePreviewUrl();
    const url = URL.createObjectURL(file);
    previewImage.src = url;
    previewImage.alt = `Preview of ${file.name}`;
    previewMeta.textContent = `${file.name} · ${file.type || 'unknown type'} · ${humanBytes(file.size)}`;
    preview.classList.add('is-visible');
    imageFields.classList.remove('has-error');
  }

  removePreviewButton.addEventListener('click', () => {
    resetImagePreview();
    imageInput.focus();
  });

  function validateImageFile(file) {
    if (!file) return 'Choose a photo of the item';
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (file.type && !allowed.includes(file.type)) {
      return `Unsupported image type (${file.type}). Accepted: ${IMAGE.label}`;
    }
    if (file.size > IMAGE.maxBytes) {
      return `This file is ${humanBytes(file.size)}. The limit is 5 MB.`;
    }
    return null;
  }

  imageInput.addEventListener('change', () => {
    const file = imageInput.files && imageInput.files[0];
    const problem = validateImageFile(file);
    if (problem) {
      imageFields.classList.add('has-error');
      imageFields.querySelector('.field__error').textContent = problem;
      resetImagePreview();
      imageInput.value = '';
      return;
    }
    showImagePreview(file);
  });

  /* ---- Submission ---------------------------------------------------------- */

  function validateForm(file, values) {
    const details = [];
    const imageProblem = validateImageFile(file);
    if (imageProblem) details.push({ field: 'image', message: imageProblem });
    if (values.contactEmail === '') {
      details.push({ field: 'contactEmail', message: 'Contact email is required' });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) {
      details.push({ field: 'contactEmail', message: 'Contact email must be a valid email address' });
    }
    return details;
  }

  function collect() {
    const incidentRaw = form.elements.incidentAt.value;
    return {
      contactEmail: form.elements.contactEmail.value.trim(),
      venue: form.elements.venue.value.trim() || undefined,
      locationDescription: undefined,
      description: form.elements.description.value.trim() || undefined,
      incidentAt: datetimeLocalToIso(incidentRaw),
    };
  }

  function renderTokenPanel({ accessToken, report }) {
    document.getElementById('token-code').textContent = accessToken;
    document.getElementById('copy-token').dataset.copy = accessToken;
    document.getElementById('report-link').href = `/report/${encodeURIComponent(accessToken)}`;
    showBanner(
      resultBanner,
      'success',
      `Found-item report submitted. ${escapeHtml(report.venue ? `Venue: ${report.venue}.` : '')} The analysis continues below and on your private page.`
    );
  }

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

  function renderListValue(value) {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  function renderAttributes(attributes) {
    const list = document.getElementById('attributes-list');
    // Only display-known keys render; internal metadata (e.g. analysisVersion)
    // stays out of the user-facing list on purpose.
    const rows = Object.entries(attributes)
      .filter(([key]) => Object.prototype.hasOwnProperty.call(ATTRIBUTE_LABELS, key))
      .filter(([, value]) => !(value === null || value === undefined || value === '' ||
        (Array.isArray(value) && value.length === 0) || value === 'unknown'))
      .map(([key, value]) => {
        const name = ATTRIBUTE_LABELS[key];
        return `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(renderListValue(value))}</dd></div>`;
      });
    list.innerHTML = rows.length > 0 ? rows.join('') : '<div><dt>Result</dt><dd>No attributes could be inferred from this photo.</dd></div>';
    const panel = document.getElementById('attributes-panel');
    panel.hidden = rows.length === 0;
  }

  function renderFailurePanel(report) {
    const panel = document.getElementById('action-panel');
    const title = document.getElementById('action-title');
    const text = document.getElementById('action-text');
    panel.hidden = false;
    title.textContent = 'The analysis needs a new photo';
    text.textContent =
      'The current photo could not be analyzed completely. Nothing was invented to fill the gaps, and the report — including your contact email — is intact. Choose a brighter, clearer photo and retry; matching uses whichever analysis succeeds.';
  }

  let pollStartedAt = Date.now();
  let createdToken = null;

  function startPolling(token) {
    createdToken = token;
    pollStartedAt = Date.now();
    formSection.hidden = true;
    progressSection.hidden = false;
    resultSection.hidden = true;
    pollReport(token, {
      intervalMs: 3000,
      timeoutMs: 180000,
      onTick(report) {
        const elapsed = Math.round((Date.now() - pollStartedAt) / 1000);
        progressLine.textContent = `Status: ${statusLabel('analysis', report.analysisStatus)} · ${elapsed}s elapsed · checking every 3 s`;
      },
      onPollError(status, data) {
        progressSection.hidden = true;
        resultSection.hidden = false;
        renderTokenPanel({ accessToken: token, report: {} });
        showBanner(
          resultBanner,
          'error',
          status === 404
            ? 'This report link is not valid.'
            : (data && data.message) || 'The analysis status could not be checked. You can reopen your private report page later.'
        );
      },
      onTimeout() {
        progressSection.hidden = true;
        resultSection.hidden = false;
        renderTokenPanel({ accessToken: token, report: {} });
        showBanner(
          resultBanner,
          'info',
          'The analysis is still not finished after 3 minutes. Open your private report page later to see the current state — the report is safe.'
        );
      },
    }).then((report) => {
      if (!report) return;
      progressSection.hidden = true;
      resultSection.hidden = false;
      renderTokenPanel({ accessToken: token, report: { venue: report.venue } });
      if (report.analysisStatus === 'completed') {
        renderAttributes(report.attributes || {});
      } else {
        renderFailurePanel(report);
      }
    });
  }

  function showProgress() {
    formSection.hidden = true;
    progressSection.hidden = false;
    resultSection.hidden = true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    summary.innerHTML = '';
    const file = imageInput.files && imageInput.files[0];
    const values = collect();
    const problems = validateForm(file, values);
    if (problems.length > 0) {
      applyFieldErrors(form, problems, summary);
      return;
    }

    const payload = new FormData();
    payload.append('image', file);
    Object.entries(values).forEach(([key, value]) => {
      if (value !== undefined) payload.append(key, value);
    });

    setBusy(submitButton, true);
    const { ok, status, data } = await api(`${window.Reclaim.API_BASE}/reports/found`, {
      method: 'POST',
      body: payload,
    });
    setBusy(submitButton, false);

    if (ok && status === 201 && data.accessToken) {
      renderTokenPanel(data);
      startPolling(data.accessToken);
      return;
    }

    const details = Array.isArray(data.details) ? data.details : [];
    applyFieldErrors(form, details, summary);
    if (details.length === 0 || ok === false) {
      showBanner(
        summary,
        'error',
        escapeHtml(
          status === 429
            ? 'Too many reports were submitted from this network. Please wait a moment and try again.'
            : status === 413
              ? `The photo is too large. ${IMAGE.label} is accepted.`
              : data.message || 'Submitting the report failed'
        )
      );
    }
  });

  /* ---- Retry with a different photo ---------------------------------------- */

  const retryInput = document.getElementById('retry-image');
  const retryBanner = document.getElementById('retry-banner');

  retryInput.addEventListener('change', () => {
    const file = retryInput.files && retryInput.files[0];
    const problem = validateImageFile(file);
    if (problem) {
      showBanner(retryBanner, 'error', escapeHtml(problem));
      retryInput.value = '';
      return;
    }
    retryBanner.innerHTML = '';
  });

  retryButton.addEventListener('click', async () => {
    const file = retryInput.files && retryInput.files[0];
    const problem = validateImageFile(file);
    if (problem) {
      showBanner(retryBanner, 'error', escapeHtml(problem));
      return;
    }
    // Token auth: the just-created token from this session, never an id.
    const token = createdToken;
    if (!token) return;

    const payload = new FormData();
    payload.append(IMAGE.field, file);
    setBusy(retryButton, true);
    const { ok, status, data } = await api(
      `${window.Reclaim.API_BASE}/private/reports/${encodeURIComponent(token)}/image`,
      { method: 'POST', body: payload }
    );
    setBusy(retryButton, false);

    if (ok && data.report) {
      showBanner(retryBanner, 'success', 'New photo accepted — restarting analysis.');
      retryInput.value = '';
      startPolling(token);
      return;
    }
    showBanner(
      retryBanner,
      'error',
      escapeHtml(
        status === 404
          ? 'This report link is not valid.'
          : (data.message || 'Uploading the photo failed')
      )
    );
  });
})();

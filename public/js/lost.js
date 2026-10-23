'use strict';

/* Lost-report form (AGENT.md §2, §12): short, validated, honest errors. */
(function () {
  const { LIMITS, api, escapeHtml, datetimeLocalToIso, showBanner, clearFieldErrors } = window.Reclaim;

  const form = document.getElementById('lost-form');
  const formSection = document.getElementById('form-section');
  const successSection = document.getElementById('success-section');
  const successBanner = document.getElementById('success-banner');
  const summary = document.getElementById('error-summary');
  const submitButton = document.getElementById('submit-button');

  /* Live description counter mirrors the server's hard bounds. */
  const description = form.elements.description;
  const counter = document.getElementById('description-count');
  function updateCounter() {
    counter.textContent = String(description.value.length);
  }
  description.addEventListener('input', updateCounter);
  updateCounter();

  /* The server rejects future incident times; the picker agrees. */
  form.elements.incidentAt.max = new Date(Date.now() - 60 * 1000)
    .toISOString()
    .slice(0, 16);

  function clientValidate(values) {
    const details = [];
    if (values.itemName === '') {
      details.push({ field: 'itemName', message: 'Item name is required' });
    } else if (values.itemName.length > LIMITS.itemName) {
      details.push({ field: 'itemName', message: `Item name must be at most ${LIMITS.itemName} characters` });
    }
    if (values.description.length < LIMITS.descriptionMin) {
      details.push({
        field: 'description',
        message: `Description must be at least ${LIMITS.descriptionMin} characters`,
      });
    } else if (values.description.length > LIMITS.description) {
      details.push({
        field: 'description',
        message: `Description must be at most ${LIMITS.description} characters`,
      });
    }
    if (values.contactEmail === '') {
      details.push({ field: 'contactEmail', message: 'Contact email is required' });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) {
      details.push({ field: 'contactEmail', message: 'Contact email must be a valid email address' });
    }
    const colorCount = values.colors.length;
    if (colorCount > LIMITS.colors) {
      details.push({ field: 'colors', message: `At most ${LIMITS.colors} colors are allowed` });
    }
    return details;
  }

  function collect() {
    const colors = ['color-0', 'color-1', 'color-2']
      .map((name) => (form.elements[name] ? form.elements[name].value.trim() : ''))
      .filter(Boolean);
    const incidentRaw = form.elements.incidentAt.value;
    return {
      itemName: form.elements.itemName.value.trim(),
      description: description.value.trim(),
      colors,
      brand: form.elements.brand.value.trim() || undefined,
      venue: form.elements.venue.value.trim() || undefined,
      locationDescription: form.elements.locationDescription.value.trim() || undefined,
      incidentAt: datetimeLocalToIso(incidentRaw),
      contactEmail: form.elements.contactEmail.value.trim(),
    };
    // undefined optional fields are dropped by JSON stringify automatically.
  }

  function dropUndefined(payload) {
    // JSON.stringify omits undefined properties; this keeps the payload honest.
    return JSON.parse(JSON.stringify(payload));
  }

  function renderSuccess({ accessToken, report }) {
    formSection.hidden = true;
    successSection.hidden = false;
    const code = document.getElementById('token-code');
    const link = document.getElementById('report-link');
    const copyButton = document.getElementById('copy-token');
    code.textContent = accessToken;
    copyButton.dataset.copy = accessToken;
    link.setAttribute('href', `/report/${encodeURIComponent(accessToken)}`);
    showBanner(
      successBanner,
      'success',
      `Report submitted. ${escapeHtml(report.itemName ? `You reported: ${report.itemName}` : '')} Notifications go to <strong>${escapeHtml(form.elements.contactEmail.value.trim())}</strong> if a match is found.`
    );
    successSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    summary.innerHTML = '';
    const values = collect();
    const clientErrors = clientValidate(values);
    if (clientErrors.length > 0) {
      window.Reclaim.applyFieldErrors(form, clientErrors, summary);
      return;
    }

    clearFieldErrors(form);
    window.Reclaim.setBusy(submitButton, true);
    const { ok, status, data } = await api(`${window.Reclaim.API_BASE}/reports/lost`, {
      method: 'POST',
      body: dropUndefined(values),
    });
    window.Reclaim.setBusy(submitButton, false);

    if (ok && status === 201 && data.accessToken) {
      renderSuccess(data);
      return;
    }

    const details = Array.isArray(data.details) ? data.details : [];
    const mapped = details.length > 0 ? details : [{ field: 'form', message: data.message || 'Submitting the report failed' }];
    const pageFieldErrors = mapped.map(({ field, message }) => ({ field, message }));
    const hadUnknown = window.Reclaim.applyFieldErrors(form, pageFieldErrors, summary);
    if (!hadUnknown) {
      showBanner(
        summary,
        'error',
        details.length > 0
          ? 'Some fields need attention before the report can be submitted.'
          : escapeHtml(
              status === 429
                ? 'Too many reports were submitted from this network. Please wait a moment and try again.'
                : data.message || 'Submitting the report failed'
            )
      );
    }
  });
})();

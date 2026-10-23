'use strict';

/* Private match page: scoped by the per-party token. Renders only what the
   API returns for this viewer; contact details appear only after BOTH sides
   confirmed (the API enforces this; the UI just presents it honestly). */
(function () {
  const {
    api, escapeHtml, tokenFromLocation, invalidTokenBanner, showBanner,
    setBusy, label: mapLabel, chip,
  } = window.Reclaim;

  const summary = document.getElementById('error-summary');
  const actionBanner = document.getElementById('action-banner');

  let currentMatch = null;
  let token = null;

  const ATTRIBUTE_LABELS = {
    category: 'Category',
    itemType: 'Item type',
    primaryColor: 'Main color',
    secondaryColors: 'Other colors',
    brand: 'Brand',
    condition: 'Condition',
  };

  function renderList(value) {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  function renderKv(listElement, entries) {
    listElement.innerHTML = entries.map(([name, value]) =>
      `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`
    ).join('');
  }

  function attributeEntries(attributes) {
    return Object.entries(attributes)
      .filter(([, value]) => !(value === null || value === undefined || value === '' ||
        (Array.isArray(value) && value.length === 0)))
      .map(([key, value]) => [ATTRIBUTE_LABELS[key] || key, renderList(value)]);
  }

  function factorSign(score) {
    if (score > 0.3) return 'agrees';
    if (score < -0.05) return 'conflicts';
    if (score > 0) return 'agrees somewhat';
    return 'not comparable';
  }

  function renderFactor(factor) {
    const sym = window.Reclaim.factorSymbol(factor.score);
    const weight = factor.score > 0 ? `+${factor.score}` : `${factor.score}`;
    return `<div class="factor">
      <span class="factor__sym ${sym.cls}" aria-hidden="true">${sym.glyph}</span>
      <span>
        <div class="factor__label">${escapeHtml(factor.label || factor.key || 'Factor')}</div>
        <div class="factor__desc">${escapeHtml(factor.description || '')}</div>
      </span>
      <span class="factor__weight"><span aria-hidden="true">${escapeHtml(factorSign(factor.score))}</span> · ${escapeHtml(weight)}</span>
    </div>`;
  }

  function renderMatch(match) {
    document.getElementById('match-meter').innerHTML =
      `${window.Reclaim.scoreMeterHtml(match.score)}`;
    document.getElementById('match-state').innerHTML = chip('match', match.status);
    document.getElementById('match-role').textContent = mapLabel('role', match.role);
    document.getElementById('match-panel').hidden = false;

    /* Factors: symbol square + server-provided plain-language description. */
    const factors = match.factors || [];
    document.getElementById('factors-list').innerHTML = factors.map(renderFactor).join('');
    document.getElementById('factors-panel').hidden = factors.length === 0;

    /* Other side: structured data only, per privacy policy. */
    const other = match.otherItem || {};
    const otherEntries =
      other.reportType === 'found'
        ? [[ 'Report', 'Found item' ], ...attributeEntries(other.attributes || {})]
        : [[ 'Report', 'Lost item' ], ...(other.itemName ? [['Named as', other.itemName]] : [])];
    renderKv(document.getElementById('other-list'), otherEntries);
    document.getElementById('other-title').textContent =
      other.reportType === 'found' ? 'The found-item report' : 'The lost-item report';
    document.getElementById('other-panel').hidden = otherEntries.length === 0;

    /* Own report summary. */
    const own = match.ownReport || {};
    const ownEntries =
      own.reportType === 'lost'
        ? [['Report', 'Lost item'], ...(own.itemName ? [['Named as', own.itemName]] : [])]
        : [['Report', 'Found item'], ...attributeEntries(own.attributes || {})];
    renderKv(document.getElementById('own-list'), ownEntries);
    document.getElementById('own-title').textContent =
      own.reportType === 'lost' ? 'Your lost-item report' : 'Your found-item report';
    document.getElementById('own-panel').hidden = ownEntries.length === 0;

    /* Contact only after both confirmed — API nulls it otherwise. */
    const contactPanel = document.getElementById('contact-panel');
    if (match.counterpartyContactEmail) {
      document.getElementById('contact-email').textContent = match.counterpartyContactEmail;
      document.getElementById('contact-copy').dataset.copy = match.counterpartyContactEmail;
      contactPanel.hidden = false;
    } else {
      contactPanel.hidden = true;
    }

    renderActions(match);
  }

  function resetConfirmButtons() {
    document.getElementById('confirm-arm').hidden = false;
    document.getElementById('confirm-confirm').hidden = true;
    document.getElementById('confirm-cancel').hidden = true;
    document.getElementById('reject-arm').hidden = false;
    document.getElementById('reject-confirm').hidden = true;
    document.getElementById('reject-cancel').hidden = true;
    actionBanner.innerHTML = '';
  }

  function renderActions(match) {
    const panel = document.getElementById('action-panel');
    const active = match.actions && (match.actions.canConfirm || match.actions.canReject);
    panel.hidden = !active;
    if (!active) return;
    resetConfirmButtons();

    const confirmRow = document.getElementById('confirm-row');
    const rejectRow = document.getElementById('reject-row');
    confirmRow.hidden = !match.actions.canConfirm;
    rejectRow.hidden = !match.actions.canReject;

    if (match.actions.canConfirm && match.actions.canReject) {
      document.getElementById('action-intro').textContent =
        'Nothing is shared with the other party until BOTH sides confirm. ' +
        'If the items clearly do not belong together, decline the match instead.';
    } else if (match.actions.canConfirm) {
      document.getElementById('action-intro').textContent =
        'Confirm only if this really is your item.';
    } else {
      document.getElementById('action-intro').textContent =
        'You already confirmed your side. You can still decline before the other party confirms.';
    }
  }

  async function postAction(pathSuffix) {
    const { ok, status, data } = await api(
      `${window.Reclaim.API_BASE}/private/matches/${encodeURIComponent(token)}/${pathSuffix}`,
      { method: 'POST' }
    );
    if (!ok) {
      const message =
        status === 404
          ? 'This match link is not valid.'
          : status === 409
            ? 'This match can no longer be changed from its current state.'
            : (data.message || 'The action failed');
      showBanner(actionBanner, 'error', escapeHtml(message));
      return null;
    }
    return data.match;
  }

  /* ---- Two-step confirming and declining (explicit, keyboard reachable) ---- */

  function wireArming({ arm, confirm, cancel, run }) {
    arm.addEventListener('click', () => {
      arm.hidden = true;
      confirm.hidden = false;
      cancel.hidden = false;
      confirm.focus();
    });
    cancel.addEventListener('click', () => {
      resetConfirmButtons();
    });
    confirm.addEventListener('click', async () => {
      if (!currentMatch) return;
      setBusy(confirm, true);
      const updated = await postAction(run);
      setBusy(confirm, false);
      if (!updated) return;
      currentMatch = updated;
      resetConfirmButtons();
      renderMatch(updated);
      showBanner(actionBanner, 'success', escapeHtml(
        updated.status === 'confirmed'
          ? 'Both parties confirmed — contact details are now shared above.'
          : updated.status === 'rejected'
            ? 'The match was declined. The other party keeps their own report; neither side sees new actions here.'
            : 'Your response was recorded. The other party has not answered yet.'
      ));
    });
  }

  wireArming({
    arm: document.getElementById('confirm-arm'),
    confirm: document.getElementById('confirm-confirm'),
    cancel: document.getElementById('confirm-cancel'),
    run: 'confirm',
  });
  wireArming({
    arm: document.getElementById('reject-arm'),
    confirm: document.getElementById('reject-confirm'),
    cancel: document.getElementById('reject-cancel'),
    run: 'reject',
  });

  /* ---- Entry ------------------------------------------------------------------ */

  token = tokenFromLocation();
  if (!token) {
    const invalid = invalidTokenBanner();
    showBanner(summary, 'error', `<strong>${invalid.title}.</strong> ${invalid.body}`);
  } else {
    (async () => {
      const { ok, status, data } = await api(
        `${window.Reclaim.API_BASE}/private/matches/${encodeURIComponent(token)}`
      );
      if (!ok) {
        if (status === 404) {
          const invalid = invalidTokenBanner();
          showBanner(summary, 'error', `<strong>${invalid.title}.</strong> ${invalid.body}`);
          return;
        }
        showBanner(summary, 'error', escapeHtml(data.message || 'Loading the match failed. Try again later.'));
        return;
      }
      currentMatch = data.match;
      renderMatch(currentMatch);
    })();
  }
})();

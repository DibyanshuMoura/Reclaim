'use strict';

/**
 * Email templates (AGENT.md §2 privacy rules).
 *
 * Hard privacy invariants:
 * - Neither suggested-match email names the OTHER party or their contact
 *   details; each contains only the recipient's own private match link.
 * - Counterparty contact details appear ONLY in the `contacts_shared`
 *   email, which is enqueued after BOTH parties have confirmed.
 * - Recipient-supplied text is sanitized to single lines (no header or
 *   body injection through raw content).
 * - No item photos, no attribute dumps, no report tokens in email bodies.
 */

/** Collapses any whitespace/newlines so user text can never inject lines. */
function line(value, max = 200) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function matchSuggestedEmail({ role, ownLabel, matchUrl }) {
  const intro =
    role === 'loser'
      ? 'Good news: a found-item report that may match your lost item has been submitted to Reclaim.'
      : 'Good news: a lost-item report that may match the item you found has been submitted to Reclaim.';
  const subject =
    role === 'loser'
      ? 'Reclaim: someone may have found your lost item'
      : 'Reclaim: a lost-item report may match the item you found';

  const body = [
    intro,
    '',
    role === 'loser'
      ? `Your report describes: ${line(ownLabel)}`
      : 'Open the private review link to see what was reported lost.',
    '',
    'Review and confirm (or decline) the match here:',
    line(matchUrl, 500),
    '',
    'This link is private to you. Nothing is shared with the other party',
    'until BOTH sides confirm the match. If you no longer recognize this',
    'report, you can decline the match or close your own report.',
    '',
    '— Reclaim',
  ].join('\n');

  return { subject, body };
}

function contactsSharedEmail({ counterpartyEmail }) {
  const subject = 'Reclaim: your match is confirmed — contact details shared';
  const body = [
    'Both parties have confirmed the match, so contact details are now',
    'shared between you.',
    '',
    `The other party's contact email: ${line(counterpartyEmail, 254)}`,
    '',
    'You can arrange the return directly. When the item is back with its',
    'owner, close your report from your private report page so matching',
    'stops for it.',
    '',
    '— Reclaim',
  ].join('\n');
  return { subject, body };
}

module.exports = { matchSuggestedEmail, contactsSharedEmail, line };

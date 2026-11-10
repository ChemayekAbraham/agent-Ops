/**
 * Agent Care (self-support fee) server refusals, written for people to read.
 * The server sends "CODE: sentence"; screens show the sentence after the colon.
 */
export function afterColon(raw: string, code: string): string | null {
  const at = raw.indexOf(code);
  if (at < 0) return null;
  const rest = raw.slice(at + code.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const text = rest.slice(colon + 1).trim();
  return text.length > 0 ? text : null;
}

/** Friendly text for the Agent Care refusal codes, or null when the error is something else. */
export function selfSupportFeeErrorMessage(raw: string): string | null {
  if (raw.includes('PLANS_EXCEED_AMOUNT')) {
    return 'The promised amount must cover the selected plans, Agent Care included.';
  }
  if (raw.includes('COMPANY_MANAGED_NOTES_CLOSED')) {
    return afterColon(raw, 'COMPANY_MANAGED_NOTES_CLOSED')
      ?? 'Promissory notes are self-support only. Select the tenant rent plans the partner will support.';
  }
  if (raw.includes('PSM_TOPUP_WINDOW_CLOSED')) {
    return afterColon(raw, 'PSM_TOPUP_WINDOW_CLOSED')
      ?? 'Self-support portfolios are not topped up. Support more tenants or houses with a new portfolio.';
  }
  return null;
}

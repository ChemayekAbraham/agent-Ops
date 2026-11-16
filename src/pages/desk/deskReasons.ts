import type { Stage } from './reviewTypes';

/**
 * The reasons each desk may give, in the order the desk sees them, with SHORT
 * labels (never the catalogue's internal meanings such as "Reviewed weekly to
 * create new codes"). One list per desk, used by every reason picker on the
 * desks: the send-back sheet, the COO's bulk send-back, the Service Centre's
 * bulk dialog and the review drawer. A code shows only when it is in the
 * desk's list AND active on the server; Partner Ops and system codes
 * (PARTNER_OPS_RETIRED, RULE_FOLLOWED, FUNDERS_BOARD_DEMOTED) are in no list.
 */

export type DeskReason = { code: string; label: string };

const DATA_ERROR: DeskReason = { code: 'DATA_ERROR', label: 'Information is wrong' };
const RISK_JUDGEMENT: DeskReason = { code: 'RISK_JUDGEMENT', label: 'My judgement (explain)' };
const OTHER: DeskReason = { code: 'OTHER', label: 'Other (explain)' };

export const DESK_REASONS: Record<string, DeskReason[]> = {
  service_centre: [
    DATA_ERROR,
    { code: 'DOC_MISSING', label: 'Document missing' },
    { code: 'FAKE_REQUEST', label: 'Fake request' },
    { code: 'DUPLICATE_REQUEST', label: 'Duplicate' },
    { code: 'STALE_REQUEST', label: 'Old / stale request' },
    RISK_JUDGEMENT,
    OTHER,
  ],
  agent_ops: [
    { code: 'DOC_MISSING', label: 'Document missing' },
    { code: 'DOC_UNREADABLE', label: 'Document unreadable' },
    { code: 'TENANT_ID_MISSING', label: 'Tenant ID missing' },
    { code: 'AGENT_NONE', label: 'No real agent' },
    { code: 'AGENT_PERFORMANCE', label: "Agent's repayment record" },
    { code: 'TENANT_NOT_FIT', label: 'Tenant not fit' },
    { code: 'FAKE_REQUEST', label: 'Fake request' },
    DATA_ERROR,
    RISK_JUDGEMENT,
    OTHER,
  ],
  tenant_ops: [
    { code: 'TENANT_UNREACHABLE', label: 'Tenant not reachable' },
    { code: 'TENANT_UNAWARE', label: "Tenant didn't understand the terms" },
    { code: 'NO_SMARTPHONE', label: 'No smartphone' },
    { code: 'TENANT_NO_DASHBOARD', label: 'No Welile dashboard' },
    { code: 'RENT_MISMATCH', label: "Rent doesn't match" },
    { code: 'DUPLICATE_REQUEST', label: 'Duplicate' },
    DATA_ERROR,
    RISK_JUDGEMENT,
    OTHER,
  ],
  landlord_ops: [
    { code: 'LANDLORD_UNREACHABLE', label: 'Landlord not reachable' },
    { code: 'LANDLORD_WRONG_NUMBER', label: "Not the landlord's number" },
    { code: 'LANDLORD_DOES_NOT_KNOW_TENANT', label: "Landlord doesn't know the tenant" },
    { code: 'LANDLORD_NO_CONSENT', label: "Landlord didn't confirm" },
    { code: 'LANDLORD_REFUSES_TERMS', label: 'Landlord refuses the terms' },
    { code: 'LANDLORD_RENT_MISMATCH', label: "Rent doesn't match (explain)" },
    { code: 'TENANT_IN_ARREARS', label: 'Tenant in arrears with landlord' },
    { code: 'LANDLORD_UNVERIFIED', label: 'Landlord not verified' },
    DATA_ERROR,
    RISK_JUDGEMENT,
    OTHER,
  ],
  coo: [
    { code: 'LANDLORD_UNVERIFIED', label: 'Landlord not verified' },
    { code: 'AGENT_NONE', label: 'No real agent' },
    { code: 'FB_DETAILS_WRONG', label: 'Details look wrong' },
    { code: 'FB_DUPLICATE', label: 'Same house listed twice' },
    { code: 'FB_NOT_AVAILABLE', label: 'House no longer available' },
    { code: 'FB_NOT_QUALIFIED', label: "Doesn't qualify" },
    { code: 'FB_PHOTOS_POOR', label: 'Photos not good enough' },
    DATA_ERROR,
    RISK_JUDGEMENT,
    OTHER,
  ],
};

/** The short label for a code at a desk; the code itself when the desk has no label for it. */
export function reasonLabel(stage: Stage | string, code: string): string {
  return (DESK_REASONS[stage] ?? []).find((r) => r.code === code)?.label ?? code;
}

/**
 * The desk's reasons from what the server holds active: only the desk's own
 * codes, in the desk's order, with the short label as `meaning` so every
 * existing picker shows it. `requires_text` stays the server's.
 */
export function allowedReasons<T extends { code: string; meaning?: string | null; requires_text?: boolean | null }>(
  serverCodes: readonly T[],
  stage: Stage | string,
): (T & { meaning: string })[] {
  const byCode = new Map(serverCodes.map((r) => [r.code, r]));
  const out: (T & { meaning: string })[] = [];
  for (const r of DESK_REASONS[stage] ?? []) {
    const s = byCode.get(r.code);
    if (s) out.push({ ...s, meaning: r.label });
  }
  return out;
}

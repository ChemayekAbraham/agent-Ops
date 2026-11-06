// Pure helpers for the landlord SMS sent when partner-funded rent lands on the
// agent's dashboard (see notify-partner-float-landlords). No Deno or network
// calls here so the wording can be unit-tested.
//
// Rules for the copy:
//  - the funding partner is NEVER named;
//  - tenants are named by first name only;
//  - the payout number is masked;
//  - no loan / lender / interest / ROI wording (regulatory terminology);
//  - one SMS segment where possible: the platform appends "Help: <phone>" and
//    sometimes a sign-up link, so the body is kept short.

export interface LandlordFloatNotice {
  landlord_phone?: string | null;
  agent_name?: string | null;
  amount: number;
  tenant_count?: number | null;
  tenant_first_names?: string[] | null;
}

const MAX_NAME = 14;

export const ugx = (n: number): string => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

/** "+256 742 799 042" -> "0742***042" (first 4 and last 3 digits only). */
export function maskPhone(raw: string | null | undefined): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("256") && d.length >= 12) d = "0" + d.slice(3);
  if (d.length < 8) return "";
  return `${d.slice(0, 4)}***${d.slice(-3)}`;
}

const cleanName = (n: string): string => {
  const first = String(n ?? "").trim().split(/\s+/)[0] ?? "";
  return first.length > MAX_NAME ? first.slice(0, MAX_NAME) : first;
};

/** "Sarah", "Sarah and John", "Sarah, John and 2 more tenants", or "3 tenants". */
export function tenantPhrase(names: string[] | null | undefined, count: number | null | undefined): string {
  const list = (names ?? []).map(cleanName).filter(Boolean);
  const total = Math.max(Number(count) || 0, list.length, 1);
  if (list.length === 0) return total === 1 ? "1 tenant" : `${total} tenants`;
  if (total === 1) return list[0];
  if (total === 2 && list.length >= 2) return `${list[0]} and ${list[1]}`;
  const rest = total - 2;
  return rest > 0
    ? `${list[0]}, ${list[1] ?? "another tenant"} and ${rest} more tenant${rest === 1 ? "" : "s"}`
    : `${list[0]} and ${list[1]}`;
}

export function buildLandlordMessage(n: LandlordFloatNotice): string {
  const tenants = tenantPhrase(n.tenant_first_names, n.tenant_count);
  const agentFirst = String(n.agent_name ?? "").trim().split(/\s+/)[0];
  const masked = maskPhone(n.landlord_phone);
  const payer = agentFirst ? `Agent ${agentFirst} will pay you` : "Your agent will pay you";
  const where = masked ? ` on ${masked}` : " on your registered number";
  const base = `WELILE: ${ugx(n.amount)} rent for ${tenants} is approved. ${payer}${where}.`;
  const tail = " Keep your phone on.";
  return base.length + tail.length <= 118 ? base + tail : base;
}

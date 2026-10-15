// Pure helpers for the tenant consent code on a Rent Plan renewal. No Deno, network or Supabase imports, so Vitest loads this file as it is.
//
// The code confirms ONE renewal: this rent over these days. It is hashed together with both figures, so a code issued for one rent
// or one number of days is not a valid code for another.

/** "UGX 1,234" — whole shillings, thousands separated by commas. */
export function formatUgx(n: number): string {
  return `UGX ${String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** The figures a code is bound to, as one stable string ("450000:60"). */
export function renewalBindingKey(rent: number | string, days: number | string): string {
  return `${Number(rent)}:${Number(days)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The value stored in rent_renewal_otps.code_hash: previous plan, new rent, new days and the code itself. */
export function renewalCodeHash(prevId: string, rent: number | string, days: number | string, code: string): Promise<string> {
  return sha256Hex(`${prevId}:${renewalBindingKey(rent, days)}:${code}`);
}

export interface RenewalSmsInput {
  agentName: string;
  code: string;
  rent: number;
  days: number;
  daily: number;
  supportPhone: string;
}
export interface RenewalSmsDeps {
  /** transliterates to the GSM-7 alphabet (sendSmsMultiProvider.toGsm7) */
  toGsm7: (s: string) => string;
  /** the footer the sender appends when the text does not already carry it (smsFooter.appendSupportFooter) */
  appendSupportFooter: (s: string) => string;
}

export const SMS_MAX_CHARS = 160;

/**
 * The tenant sees the NEW rent, the NEW number of days and the NEW daily payment before they hand the code over.
 * One SMS part: the final transmitted body (footer included) is at most 160 GSM-7 characters. The agent's name is the only thing
 * that gives way when space runs short; the figures and the code never do.
 */
export function buildRenewalSms(i: RenewalSmsInput, deps: RenewalSmsDeps): string {
  const name = deps.toGsm7((i.agentName || "Your agent").trim()).replace(/\s+/g, " ");
  const plan = `Rent Plan renewal ${formatUgx(i.rent)}, ${Math.round(i.days)} days, ${formatUgx(i.daily)}/day.`;
  const tail = ` Code ${i.code}. Share only if you agree. Contact Welile Support on ${i.supportPhone}`;
  for (let n = Math.min(name.length, 30); n >= 0; n--) {
    const who = n === 0 ? "" : `Agent ${name.slice(0, n).trim()}: `;
    const body = `Welile: ${who}${plan}${tail}`;
    if (deps.toGsm7(deps.appendSupportFooter(body)).length <= SMS_MAX_CHARS) return body;
  }
  throw new Error("SMS_TOO_LONG");
}

// Single source of Angel Pool share maths for edge functions.
// Mirrors src/components/angel-pool/constants.ts (UI).
export const ANGEL_TOTAL_SHARES = 25_000;
export const ANGEL_PRICE_PER_SHARE = 20_000;
export const ANGEL_POOL_PERCENT = 8;

export function computeAngelShares(amount: number) {
  const actualAmount = Math.round(amount);
  const shares = Number((actualAmount / ANGEL_PRICE_PER_SHARE).toFixed(6));
  return {
    amount: actualAmount,
    shares,
    poolOwnershipPercent: (shares / ANGEL_TOTAL_SHARES) * 100,
    companyOwnershipPercent: (shares / ANGEL_TOTAL_SHARES) * ANGEL_POOL_PERCENT,
  };
}

export function newAngelReference(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const seq = String(Math.floor(1000 + Math.random() * 9000));
  return `ANG${yy}${mm}${dd}${seq}`;
}

/** Shares confirmed + shares reserved by open onboarding requests. */
// deno-lint-ignore no-explicit-any
export async function sharesCommitted(admin: any, excludeRequestId?: string): Promise<number> {
  const [{ data: confirmed }, { data: open }] = await Promise.all([
    admin.from("angel_pool_investments").select("shares").eq("status", "confirmed"),
    admin.from("share_onboarding_requests").select("id, shares")
      .in("status", ["awaiting_signature", "submitted"]),
  ]);
  const a = (confirmed || []).reduce((s: number, r: any) => s + Number(r.shares), 0);
  const b = (open || []).filter((r: any) => r.id !== excludeRequestId)
    .reduce((s: number, r: any) => s + Number(r.shares), 0);
  return a + b;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function formatAllocationDate(d: string | Date): string {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

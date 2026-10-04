/**
 * Welile Bread — Claim Codes & Partner Sellers
 *
 * Tenants apply a Welile receipt → earn a 5% credit → get a one-time
 * 6-digit CLAIM CODE they show at a partner mall / bakery / supermarket.
 * Sellers (in /seller-portal) enter the code to release the bread at the
 * correct price (free or discounted).
 *
 * Everything lives in localStorage so the flow works fully offline; both
 * sides reconcile visually when they next come online (server sync is a
 * future enhancement — kept out of v1 by product decision).
 */

export const BREAD_PRICE = 6500;
export const BREAD_DISCOUNT_RATE = 0.05;
export const BREAD_MIN_PAYABLE = 500;

// localStorage keys
export const TENANT_CLAIMS_KEY = 'welile.bread.claims.v1';
export const SELLER_REDEMPTIONS_KEY = 'welile.bread.redemptions.v1';
export const SELLER_ACTIVE_STORE_KEY = 'welile.bread.seller.activeStore.v1';

export interface PartnerSeller {
  id: string;
  name: string;
  type: 'mall' | 'bakery' | 'supermarket';
  city: string;
}

/**
 * Curated v1 partner list. Extend this freely — the seller portal reads
 * directly from here so no DB write is needed.
 */
export const PARTNER_SELLERS: PartnerSeller[] = [
  { id: 'victoria-mall-entebbe', name: 'Victoria Mall', type: 'mall', city: 'Entebbe' },
  { id: 'ss-mall-nkumba', name: 'S&S Mall', type: 'mall', city: 'Nkumba' },
  { id: 'sortgate-supermarket', name: 'Sort Gate Supermarket', type: 'supermarket', city: 'Kampala' },
  { id: 'quality-bakery-kampala', name: 'Quality Bakery', type: 'bakery', city: 'Kampala' },
  { id: 'hot-loaf-bakery', name: 'Hot Loaf Bakery', type: 'bakery', city: 'Kampala' },
  { id: 'capital-shoppers-ntinda', name: 'Capital Shoppers', type: 'supermarket', city: 'Ntinda' },
  { id: 'mega-standard-supermarket', name: 'Mega Standard Supermarket', type: 'supermarket', city: 'Kampala' },
];

export type ClaimStatus = 'pending' | 'fulfilled' | 'expired';

export interface BreadClaim {
  /** 6-digit code shown to the seller. */
  code: string;
  /** Welile receipt number that funded the claim. */
  receiptNumber: string;
  /** Original receipt amount (UGX). */
  receiptAmount: number;
  /** 5% credit derived from the receipt (UGX). */
  credit: number;
  /** Whole free breads earned (credit ≥ bread price). */
  freeBreads: number;
  /** Discount applied to the next paid bread (UGX). */
  nextBreadDiscount: number;
  /** Final price the seller should charge for the next bread (UGX). 0 = free. */
  payableForNext: number;
  /** Partner seller chosen by the tenant (id). */
  sellerId: string;
  sellerName: string;
  /** Created timestamp. */
  createdAt: number;
  /** Expires after 30 minutes. */
  expiresAt: number;
  status: ClaimStatus;
  /** Seller-side metadata once fulfilled. */
  fulfilledAt?: number;
  fulfilledBy?: string; // store id used at the seller portal
}

const CLAIM_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Cryptographically-strong 6-digit code (zero-padded). */
export function generateClaimCode(): string {
  // Use crypto when available; fall back to Math.random for very old WebViews.
  let n: number;
  try {
    const buf = new Uint32Array(1);
    (globalThis.crypto || (globalThis as any).msCrypto).getRandomValues(buf);
    n = buf[0] % 1_000_000;
  } catch {
    n = Math.floor(Math.random() * 1_000_000);
  }
  return n.toString().padStart(6, '0');
}

/**
 * Compute the discount math for a receipt amount.
 * Mirrors the logic already used in WelileReceiptDialog so the seller
 * sees the exact same numbers the tenant saw.
 */
export function computeBreadDiscount(receiptAmount: number) {
  const credit = Math.max(0, Math.round(receiptAmount * BREAD_DISCOUNT_RATE));
  const freeBreads = Math.floor(credit / BREAD_PRICE);
  const remainder = credit - freeBreads * BREAD_PRICE;
  const nextBreadDiscount = Math.min(
    remainder,
    Math.max(0, BREAD_PRICE - BREAD_MIN_PAYABLE),
  );
  // If user already earned at least one free bread, the "next bread" they
  // pay for is fully free up to that count; we surface payable=0 only when
  // there is at least one free bread AND no remainder discount.
  const payableForNext = freeBreads > 0
    ? 0
    : Math.max(BREAD_MIN_PAYABLE, BREAD_PRICE - nextBreadDiscount);
  return { credit, freeBreads, remainder, nextBreadDiscount, payableForNext };
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* offline-safe */
  }
}

// ---------- Tenant-side claim store ----------

export function listTenantClaims(): BreadClaim[] {
  const all = readJSON<BreadClaim[]>(TENANT_CLAIMS_KEY, []);
  return expirePast(all);
}

export function getActiveClaim(): BreadClaim | null {
  const claims = listTenantClaims();
  return claims.find((c) => c.status === 'pending') ?? null;
}

export function createClaim(input: {
  receiptNumber: string;
  receiptAmount: number;
  sellerId: string;
}): BreadClaim {
  const seller = PARTNER_SELLERS.find((s) => s.id === input.sellerId);
  if (!seller) throw new Error('Unknown seller');
  const math = computeBreadDiscount(input.receiptAmount);
  const now = Date.now();
  const claim: BreadClaim = {
    code: generateClaimCode(),
    receiptNumber: input.receiptNumber,
    receiptAmount: input.receiptAmount,
    credit: math.credit,
    freeBreads: math.freeBreads,
    nextBreadDiscount: math.nextBreadDiscount,
    payableForNext: math.payableForNext,
    sellerId: seller.id,
    sellerName: `${seller.name} — ${seller.city}`,
    createdAt: now,
    expiresAt: now + CLAIM_TTL_MS,
    status: 'pending',
  };
  const all = listTenantClaims();
  // Cancel any other pending claim — tenants only carry one active code.
  const next = all
    .map((c) => (c.status === 'pending' ? { ...c, status: 'expired' as ClaimStatus } : c))
    .concat(claim);
  writeJSON(TENANT_CLAIMS_KEY, next);
  return claim;
}

export function cancelClaim(code: string) {
  const all = listTenantClaims();
  const next = all.map((c) =>
    c.code === code && c.status === 'pending'
      ? { ...c, status: 'expired' as ClaimStatus }
      : c,
  );
  writeJSON(TENANT_CLAIMS_KEY, next);
}

function expirePast(claims: BreadClaim[]): BreadClaim[] {
  const now = Date.now();
  let mutated = false;
  const next = claims.map((c) => {
    if (c.status === 'pending' && c.expiresAt < now) {
      mutated = true;
      return { ...c, status: 'expired' as ClaimStatus };
    }
    return c;
  });
  if (mutated) writeJSON(TENANT_CLAIMS_KEY, next);
  return next;
}

// ---------- Seller-side redemption store ----------

export interface RedemptionRecord {
  code: string;
  storeId: string;
  storeName: string;
  fulfilledAt: number;
  payableCharged: number;
  freeBreads: number;
  receiptNumber: string;
}

export function listRedemptions(): RedemptionRecord[] {
  return readJSON<RedemptionRecord[]>(SELLER_REDEMPTIONS_KEY, []);
}

/**
 * Look up a claim by code from the local store. Works offline because
 * tenant + seller share the same device class (this v1 assumes the seller
 * agent is using the tenant's device or has been handed the code in
 * person; future server sync will make cross-device redemption possible).
 */
export function findClaimByCode(code: string): BreadClaim | null {
  const claims = listTenantClaims();
  return claims.find((c) => c.code === code.trim()) ?? null;
}

/** Mark a claim fulfilled and append a redemption record. */
export function fulfillClaim(
  code: string,
  store: { id: string; name: string },
): { ok: true; record: RedemptionRecord } | { ok: false; reason: string } {
  const all = listTenantClaims();
  const idx = all.findIndex((c) => c.code === code.trim());
  if (idx < 0) return { ok: false, reason: 'Claim code not found on this device' };
  const claim = all[idx];
  if (claim.status === 'fulfilled')
    return { ok: false, reason: 'This code was already redeemed' };
  if (claim.status === 'expired')
    return { ok: false, reason: 'This code has expired' };
  const fulfilled: BreadClaim = {
    ...claim,
    status: 'fulfilled',
    fulfilledAt: Date.now(),
    fulfilledBy: store.id,
  };
  all[idx] = fulfilled;
  writeJSON(TENANT_CLAIMS_KEY, all);

  const record: RedemptionRecord = {
    code: fulfilled.code,
    storeId: store.id,
    storeName: store.name,
    fulfilledAt: fulfilled.fulfilledAt!,
    payableCharged: fulfilled.payableForNext,
    freeBreads: fulfilled.freeBreads,
    receiptNumber: fulfilled.receiptNumber,
  };
  const reds = listRedemptions();
  reds.unshift(record);
  writeJSON(SELLER_REDEMPTIONS_KEY, reds.slice(0, 200));
  return { ok: true, record };
}

export function getActiveStore(): PartnerSeller | null {
  try {
    const id = localStorage.getItem(SELLER_ACTIVE_STORE_KEY);
    if (!id) return null;
    return PARTNER_SELLERS.find((s) => s.id === id) ?? null;
  } catch {
    return null;
  }
}

export function setActiveStore(id: string) {
  try {
    localStorage.setItem(SELLER_ACTIVE_STORE_KEY, id);
  } catch {
    /* noop */
  }
}

// ---------- Shareable claim URL (offline-safe, no server needed) ----------

/**
 * Public payload encoded into the share URL. The recipient opens the link
 * and sees everything needed to walk into the partner store and pick up
 * the bread — no account, no network round-trip.
 */
export interface SharedClaimPayload {
  code: string;
  sellerId: string;
  sellerName: string;
  freeBreads: number;
  payableForNext: number;
  expiresAt: number;
  /** Optional sender display name. */
  from?: string;
}

function base64UrlEncode(input: string): string {
  // btoa works on binary strings; encode to UTF-8 first.
  const b64 = btoa(unescape(encodeURIComponent(input)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  return decodeURIComponent(escape(atob(b64)));
}

export function encodeSharedClaim(payload: SharedClaimPayload): string {
  return base64UrlEncode(JSON.stringify(payload));
}

export function decodeSharedClaim(token: string): SharedClaimPayload | null {
  try {
    const raw = base64UrlDecode(token);
    const parsed = JSON.parse(raw) as SharedClaimPayload;
    if (!parsed?.code || !parsed?.sellerName) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Build a fully-qualified shareable URL for a given claim. */
export function buildShareUrl(claim: BreadClaim, opts?: { from?: string }): string {
  const payload: SharedClaimPayload = {
    code: claim.code,
    sellerId: claim.sellerId,
    sellerName: claim.sellerName,
    freeBreads: claim.freeBreads,
    payableForNext: claim.payableForNext,
    expiresAt: claim.expiresAt,
    from: opts?.from,
  };
  const token = encodeSharedClaim(payload);
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'https://welileapp.com';
  return `${origin}/bread/${claim.code}#${token}`;
}

// The og:description of a shared rent-plan / house-support link.
//
// SQL is the only composer of share text (get_or_create_plan_share_link / get_or_create_house_share_link
// write short_links.og_description from partner_new_contract_rate() on every share tap). This module
// never computes a Returns figure: it either serves the stored description or a rate-free sentence.
//
// A stored description written before the latest Returns policy change (the switch, a rate change)
// may quote an old rate, so once the policy has a cut-off it is used only when it was written at or
// after the policy's updated_at. Before any switch-on (no cut-off) every stored description is a
// correct preview and is served as is (switch-off parity).

import type { PublicReturnPolicy } from "../_shared/partnerReturnPolicy.ts";

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-UG")}`;

export interface PreviewLink {
  og_description?: string | null;
  og_updated_at?: string | null;
}
export interface PreviewPlan {
  funding_amount?: number | string | null;
}
/** Why the policy could not be read; `code` is the PostgREST / Postgres error code when there was one. */
export interface PolicyReadError {
  code: string | null;
}

/** Postgres/PostgREST codes for "get_partner_return_policy does not exist" (Phase 1 not applied yet). */
const FUNCTION_MISSING = new Set(["PGRST202", "42883"]);

/** The rate-free sentence (no stored description, or a stale one). */
export function rateFreeDescription(plan: PreviewPlan | null | undefined): string {
  const rent = Number(plan?.funding_amount ?? 0);
  return rent > 0 && Number.isFinite(rent)
    ? `Support this tenant for ${ugx(rent)} by paying their landlord on the platform and earn monthly Returns. Start here today.`
    : "Support a tenant's rent on Welile and earn monthly Returns. Support today.";
}

/**
 * True when a stored description may quote a rate that is no longer the public one.
 *   policy read          -> stale only after a cut-off exists and the description predates updated_at
 *                           (or either timestamp is missing / unreadable: fail closed);
 *   function missing     -> not stale (no policy yet means today's rate, as before Phase 1);
 *   any other read error -> stale (the rate-free sentence; never a guessed figure).
 */
export function storedDescriptionIsStale(
  link: PreviewLink,
  policy: PublicReturnPolicy | null,
  policyError: PolicyReadError | null,
): boolean {
  if (policy === null) {
    return !(policyError?.code && FUNCTION_MISSING.has(policyError.code));
  }
  if (policy.cutoffAt === null) return false;
  const updated = Date.parse(policy.updatedAt ?? "");
  const written = Date.parse(link.og_updated_at ?? "");
  if (!Number.isFinite(updated) || !Number.isFinite(written)) return true;
  return written < updated;
}

export function previewDescription(
  link: PreviewLink,
  plan: PreviewPlan | null | undefined,
  policy: PublicReturnPolicy | null,
  policyError: PolicyReadError | null,
): string {
  const stored = typeof link.og_description === "string" ? link.og_description : "";
  if (stored && !storedDescriptionIsStale(link, policy, policyError)) return stored;
  return rateFreeDescription(plan);
}

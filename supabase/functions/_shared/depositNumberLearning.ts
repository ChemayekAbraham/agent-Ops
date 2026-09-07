// Shared "known deposit numbers" logic.
//
// Money can arrive from a mobile-money number that is not the one on the user's
// profile. Historically nothing was remembered when Financial Ops routed such a
// deposit manually (or when the matcher identified the depositor by name), so
// the very next deposit from the same number went straight back into the manual
// queue. `user_deposit_numbers` is the growing third source of truth for phone
// → user resolution, alongside `profiles.phone` and
// `profiles.mobile_money_number`.
//
// Normalization is identical everywhere: strip non-digits, keep the last 9.

export type KnownPhoneSource =
  | 'profiles.phone'
  | 'profiles.mobile_money_number'
  | 'user_deposit_numbers';

export type LearnSource = 'manual_route' | 'name_match_auto';

export interface KnownPhoneMatch {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  source: KnownPhoneSource;
  match_count: number;
}

/** Strip non-digits and keep the last 9 — the platform-wide convention. */
export function toLast9(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

/**
 * Single consolidated phone → user lookup. Checks profiles.phone,
 * profiles.mobile_money_number and user_deposit_numbers in one round trip.
 * Returns every distinct user that owns the number; callers keep the existing
 * "exactly one user or no auto-credit" rule.
 */
export async function resolveUsersByKnownPhone(
  supabase: any,
  last9: string | null,
): Promise<KnownPhoneMatch[]> {
  if (!last9) return [];
  const { data, error } = await supabase.rpc('resolve_user_by_known_phone', {
    p_last9: last9,
  });
  if (error) {
    console.error('[deposit-numbers] resolve_user_by_known_phone failed', error.message);
    return [];
  }
  return ((data ?? []) as any[]).map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    source: r.source as KnownPhoneSource,
    match_count: Number(r.match_count ?? 0),
  }));
}

/** Convenience: resolve to a unique user, or null when 0 / ambiguous. */
export async function resolveUniqueUserByKnownPhone(
  supabase: any,
  last9: string | null,
): Promise<KnownPhoneMatch | null> {
  const hits = await resolveUsersByKnownPhone(supabase, last9);
  if (hits.length !== 1) return null;
  return hits[0];
}

export type LearnOutcome =
  | 'linked'          // brand-new number recorded for this user
  | 'already_known'   // this user already owns the number — no-op, no SMS
  | 'conflict'        // a DIFFERENT user owns it — flagged for review, no link
  | 'skipped';        // nothing to do (no usable phone) or a soft failure

/**
 * Teach the matcher a number after a POSITIVE identification only.
 *
 * Never silently relinks: if the number already resolves to another user we
 * record a `user_deposit_number_conflicts` row for Financial Ops (likely a SIM
 * swap or an earlier mis-route) and leave the existing link untouched.
 * Idempotent — repeat calls for a known number return 'already_known', so the
 * caller can gate the one-time SMS on the 'linked' outcome.
 */
export async function learnDepositNumber(
  supabase: any,
  args: {
    userId: string;
    phone: string | null | undefined;
    source: LearnSource;
    gmailTransactionId?: string | null;
    createdBy?: string | null;
    notes?: string | null;
  },
): Promise<{ outcome: LearnOutcome; last9: string | null; conflictUserId?: string | null }> {
  const last9 = toLast9(args.phone);
  if (!last9 || !args.userId) return { outcome: 'skipped', last9: null };

  try {
    const hits = await resolveUsersByKnownPhone(supabase, last9);
    const mine = hits.find((h) => h.user_id === args.userId);
    if (mine) return { outcome: 'already_known', last9 };

    const other = hits[0];
    if (other) {
      await supabase.from('user_deposit_number_conflicts').insert({
        phone_last9: last9,
        attempted_user_id: args.userId,
        existing_user_id: other.user_id,
        existing_source: other.source,
        gmail_transaction_id: args.gmailTransactionId ?? null,
        detected_via: args.source,
        notes: args.notes ?? null,
      });
      console.warn(
        `[deposit-numbers] conflict: last9=${last9} already owned by ${other.user_id} ` +
        `(${other.source}) — not linking to ${args.userId}`,
      );
      return { outcome: 'conflict', last9, conflictUserId: other.user_id };
    }

    const { data, error } = await supabase
      .from('user_deposit_numbers')
      .insert({
        user_id: args.userId,
        phone_last9: last9,
        source: args.source,
        linked_gmail_transaction_id: args.gmailTransactionId ?? null,
        created_by: args.createdBy ?? null,
      })
      .select('id')
      .maybeSingle();

    if (error) {
      // Unique violation = another concurrent path just learned it.
      if (String((error as any).code) === '23505') return { outcome: 'already_known', last9 };
      console.error('[deposit-numbers] insert failed', error.message);
      return { outcome: 'skipped', last9 };
    }
    if (!data?.id) return { outcome: 'skipped', last9 };
    console.log(`[deposit-numbers] learned last9=${last9} for user=${args.userId} via ${args.source}`);
    return { outcome: 'linked', last9 };
  } catch (e) {
    // Learning must never break a credit.
    console.error('[deposit-numbers] learn failed', (e as Error).message);
    return { outcome: 'skipped', last9 };
  }
}

// ── Known depositor NAMES ─────────────────────────────────────────────
//
// MTN's till/merchant "received" SMS never carries the payer's phone, only
// whatever name is on the payer's SIM — so the phone-based learning above
// cannot apply to that receipt shape at all. This is the name-keyed
// counterpart, used ONLY for third-party depositors (someone paying into
// a recipient's till on the recipient's behalf) whose name will never
// appear in `profiles` at all.
//
// Names collide far more than phone numbers, so a learned name is only
// ever trusted while UNCONTESTED: the moment it's manually routed to a
// SECOND, different user, every row for that name is frozen (contested =
// true) project-wide and auto-credit for that name stops for good.

export interface KnownNameMatch {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  match_count: number;
}

/** Trim, collapse whitespace, uppercase — the platform-wide convention for a learned name key. */
export function normalizeDepositorName(name: string | null | undefined): string | null {
  const cleaned = String(name ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return cleaned.length >= 4 ? cleaned : null;
}

/** Look up every UNCONTESTED user a normalized payer name is currently linked to. */
export async function resolveUsersByKnownName(
  supabase: any,
  normalizedName: string | null,
): Promise<KnownNameMatch[]> {
  if (!normalizedName) return [];
  const { data, error } = await supabase.rpc('resolve_user_by_known_name', {
    p_name: normalizedName,
  });
  if (error) {
    console.error('[deposit-names] resolve_user_by_known_name failed', error.message);
    return [];
  }
  return ((data ?? []) as any[]).map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name ?? null,
    phone: r.phone ?? null,
    email: r.email ?? null,
    match_count: Number(r.match_count ?? 0),
  }));
}

/** Convenience: resolve to a unique, uncontested user, or null when 0 / ambiguous. */
export async function resolveUniqueUserByKnownName(
  supabase: any,
  normalizedName: string | null,
): Promise<KnownNameMatch | null> {
  const hits = await resolveUsersByKnownName(supabase, normalizedName);
  if (hits.length !== 1) return null;
  return hits[0];
}

export type LearnNameOutcome =
  | 'linked'          // brand-new name recorded for this user
  | 'already_known'   // this user already owns the name — no-op
  | 'conflict'        // a DIFFERENT user owns it — name frozen for review, no auto-credit
  | 'skipped';        // nothing to do (no usable name) or a soft failure

/**
 * Teach the matcher a payer name after a POSITIVE identification only
 * (a real human manually routing the deposit). Never silently overwrites:
 * if the name already resolves to a different, uncontested user, BOTH the
 * existing and the new pairing are frozen (contested = true) and a
 * `user_deposit_name_conflicts` row is recorded for Financial Ops — a real
 * collision needs a human, never a guess. Idempotent for the same user.
 */
export async function learnDepositName(
  supabase: any,
  args: {
    userId: string;
    name: string | null | undefined;
    source: LearnSource;
    gmailTransactionId?: string | null;
    createdBy?: string | null;
    notes?: string | null;
  },
): Promise<{ outcome: LearnNameOutcome; normalizedName: string | null; conflictUserId?: string | null }> {
  const normalizedName = normalizeDepositorName(args.name);
  if (!normalizedName || !args.userId) return { outcome: 'skipped', normalizedName: null };

  try {
    const hits = await resolveUsersByKnownName(supabase, normalizedName);
    const mine = hits.find((h) => h.user_id === args.userId);
    if (mine) return { outcome: 'already_known', normalizedName };

    const other = hits[0];
    if (other) {
      // Real collision: freeze every existing row for this name so it can
      // never auto-credit again, record the conflict, and still log the
      // new attempted owner (contested) for a complete audit trail.
      await supabase
        .from('user_deposit_names')
        .update({ contested: true })
        .eq('normalized_name', normalizedName);
      await supabase.from('user_deposit_name_conflicts').insert({
        normalized_name: normalizedName,
        attempted_user_id: args.userId,
        existing_user_id: other.user_id,
        gmail_transaction_id: args.gmailTransactionId ?? null,
        detected_via: args.source,
        notes: args.notes ?? null,
      });
      await supabase.from('user_deposit_names').insert({
        user_id: args.userId,
        normalized_name: normalizedName,
        source: args.source,
        contested: true,
        linked_gmail_transaction_id: args.gmailTransactionId ?? null,
        created_by: args.createdBy ?? null,
      });
      console.warn(
        `[deposit-names] conflict: "${normalizedName}" already owned by ${other.user_id} ` +
        `— not linking to ${args.userId}; both frozen`,
      );
      return { outcome: 'conflict', normalizedName, conflictUserId: other.user_id };
    }

    const { data, error } = await supabase
      .from('user_deposit_names')
      .insert({
        user_id: args.userId,
        normalized_name: normalizedName,
        source: args.source,
        linked_gmail_transaction_id: args.gmailTransactionId ?? null,
        created_by: args.createdBy ?? null,
      })
      .select('id')
      .maybeSingle();

    if (error) {
      // Unique violation = another concurrent path just learned it.
      if (String((error as any).code) === '23505') return { outcome: 'already_known', normalizedName };
      console.error('[deposit-names] insert failed', error.message);
      return { outcome: 'skipped', normalizedName };
    }
    if (!data?.id) return { outcome: 'skipped', normalizedName };
    console.log(`[deposit-names] learned "${normalizedName}" for user=${args.userId} via ${args.source}`);
    return { outcome: 'linked', normalizedName };
  } catch (e) {
    // Learning must never break a credit.
    console.error('[deposit-names] learn failed', (e as Error).message);
    return { outcome: 'skipped', normalizedName };
  }
}

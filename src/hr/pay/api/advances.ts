/**
 * Salary advances (hr_pay_advances).
 *
 * Approval stamping (approved_by, approved_at, approved_position_id) is done by
 * a database trigger from the caller's position — never written from here.
 */
import { supabase, unwrap } from '../../api/client';

export interface AdvanceRow {
  id: string;
  staff_id: string;
  staff_ref: string | null;
  staff_name: string | null;
  principal: number;
  currency: string;
  purpose: string;
  recovery_mode: string;
  recovery_value: number;
  recovery_months: number | null;
  first_recovery_on: string;
  status: string;
  decision_note: string | null;
  requested_at: string;
  hr_approved_at: string | null;
  approved_at: string | null;
  disbursed_at: string | null;
  recovered: number;
  outstanding: number;
}

export async function listAdvances(): Promise<AdvanceRow[]> {
  const rows = (unwrap(
    await supabase
      .from('hr_pay_advances')
      .select(
        'id, staff_id, principal, currency, purpose, recovery_mode, recovery_value, recovery_months, first_recovery_on, status, decision_note, requested_at, hr_approved_at, approved_at, disbursed_at, hr_staff(staff_ref, user_id)',
      )
      .order('requested_at', { ascending: false }),
  ) ?? []) as Array<Record<string, any>>;

  const ids = rows.map((r) => r.id as string);
  const recoveredById = new Map<string, number>();
  if (ids.length > 0) {
    const recoveries = (unwrap(
      await supabase
        .from('hr_pay_advance_recoveries')
        .select('advance_id, amount, hr_pay_runs!hr_pay_advance_recoveries_run_id_fkey(status)')
        .in('advance_id', ids),
    ) ?? []) as Array<{
      advance_id: string;
      amount: number | string;
      hr_pay_runs: { status: string } | null;
    }>;
    for (const r of recoveries) {
      const runStatus = r.hr_pay_runs?.status;
      if (runStatus !== 'approved' && runStatus !== 'paid') continue;
      recoveredById.set(
        r.advance_id,
        (recoveredById.get(r.advance_id) ?? 0) + Number(r.amount ?? 0),
      );
    }
  }

  const userIds = Array.from(
    new Set(rows.map((r) => r.hr_staff?.user_id as string | undefined).filter(Boolean) as string[]),
  );
  const nameByUser = new Map<string, string | null>();
  if (userIds.length > 0) {
    const profiles = (unwrap(
      await supabase.from('profiles').select('id, full_name').in('id', userIds),
    ) ?? []) as Array<{ id: string; full_name: string | null }>;
    profiles.forEach((p) => nameByUser.set(p.id, p.full_name ?? null));
  }

  return rows.map((r) => {
    const principal = Number(r.principal ?? 0);
    const recovered = recoveredById.get(r.id as string) ?? 0;
    const userId = r.hr_staff?.user_id as string | undefined;
    return {
      id: r.id as string,
      staff_id: r.staff_id as string,
      staff_ref: (r.hr_staff?.staff_ref as string | null) ?? null,
      staff_name: userId ? nameByUser.get(userId) ?? null : null,
      principal,
      currency: (r.currency as string) ?? 'UGX',
      purpose: r.purpose as string,
      recovery_mode: r.recovery_mode as string,
      recovery_value: Number(r.recovery_value ?? 0),
      first_recovery_on: r.first_recovery_on as string,
      status: r.status as string,
      decision_note: (r.decision_note as string | null) ?? null,
      requested_at: r.requested_at as string,
      recovered,
      outstanding: Math.max(0, principal - recovered),
    };
  });
}

export async function requestAdvance(
  staffId: string,
  principal: number,
  purpose: string,
  recoveryMode: string,
  recoveryValue: number,
  firstRecoveryOn: string,
): Promise<void> {
  const res = await supabase
    .from('hr_pay_advances')
    .insert({
      staff_id: staffId,
      principal,
      purpose,
      recovery_mode: recoveryMode,
      recovery_value: recoveryValue,
      first_recovery_on: firstRecoveryOn,
    })
    .select('id')
    .single();
  unwrap(res);
}

export async function updateAdvance(
  advanceId: string,
  updates: {
    purpose: string;
    recovery_mode: string;
    recovery_value: number;
    first_recovery_on: string;
  },
): Promise<void> {
  const { purpose, recovery_mode, recovery_value, first_recovery_on } = updates;
  if (typeof recovery_value !== 'number' || recovery_value <= 0) {
    throw new Error('Recovery value must be a number greater than zero.');
  }
  if (recovery_mode !== 'fixed' && recovery_mode !== 'percent_of_gross') {
    throw new Error("Recovery mode must be 'fixed' or 'percent_of_gross'.");
  }
  if (!first_recovery_on || Number.isNaN(new Date(first_recovery_on).getTime())) {
    throw new Error('First recovery date must be a valid date.');
  }
  if (!purpose || purpose.trim().length === 0) {
    throw new Error('Purpose cannot be empty.');
  }
  const res = await supabase
    .from('hr_pay_advances')
    .update({
      purpose: purpose.trim(),
      recovery_mode,
      recovery_value,
      first_recovery_on,
    })
    .eq('id', advanceId)
    .select('id');
  const rows = unwrap(res) as Array<{ id: string }> | null;
  if (!rows || rows.length === 0) {
    throw new Error('The advance was not updated. You may not hold the authority to edit it.');
  }
}

export async function decideAdvance(
  advanceId: string,
  approve: boolean,
  note: string,
): Promise<void> {
  const trimmed = (note ?? '').trim();
  if (!approve && trimmed.length < 10) {
    throw new Error('A note of at least 10 characters is required to reject an advance.');
  }
  const res = await supabase
    .from('hr_pay_advances')
    .update({
      status: approve ? 'approved' : 'rejected',
      decision_note: trimmed ? trimmed : null,
    })
    .eq('id', advanceId)
    .select('id');
  const rows = unwrap(res) as Array<{ id: string }> | null;
  if (!rows || rows.length === 0) {
    throw new Error('The advance was not updated. You may not hold the authority to decide it.');
  }
}
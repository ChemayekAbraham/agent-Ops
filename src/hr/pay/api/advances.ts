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

  // Recovered totals come from a security-definer function. Staff may read
  // their own advance but not hr_pay_runs or the recovery table, so reading
  // those directly showed nothing repaid for anyone without payroll authority.
  // Only recoveries on approved or paid runs count, as in hr_pay_advance_due.
  const recoveredById = new Map<string, number>();
  if (rows.length > 0) {
    const totals = (unwrap(
      await (supabase.rpc as any)('hr_pay_advance_recovered_totals'),
    ) ?? []) as Array<{ advance_id: string; recovered: number | string }>;
    for (const t of totals) {
      recoveredById.set(t.advance_id, Number(t.recovered ?? 0));
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
      recovery_months: (r.recovery_months as number | null) ?? null,
      hr_approved_at: (r.hr_approved_at as string | null) ?? null,
      approved_at: (r.approved_at as string | null) ?? null,
      disbursed_at: (r.disbursed_at as string | null) ?? null,
      recovered,
      outstanding: Math.max(0, principal - recovered),
    };
  });
}

function assertRecoveryMonths(recoveryMonths: number): void {
  if (!Number.isInteger(recoveryMonths) || recoveryMonths < 1 || recoveryMonths > 3) {
    throw new Error('Recovery months must be a whole number of 1, 2 or 3.');
  }
}

export async function requestAdvance(
  staffId: string,
  principal: number,
  purpose: string,
  recoveryMode: string,
  recoveryValue: number,
  firstRecoveryOn: string,
  recoveryMonths: number,
): Promise<void> {
  assertRecoveryMonths(recoveryMonths);
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) {
    throw new Error('You must be signed in to request an advance.');
  }
  const instalment = Math.ceil(principal / recoveryMonths);
  const res = await supabase
    .from('hr_pay_advances')
    .insert({
      staff_id: staffId,
      principal,
      purpose,
      recovery_mode: recoveryMode,
      recovery_value: instalment,
      recovery_months: recoveryMonths,
      first_recovery_on: firstRecoveryOn,
      requested_by: userId,
    })
    .select('id')
    .single();
  unwrap(res);
}

export async function requestOwnAdvance(
  principal: number,
  purpose: string,
  recoveryMonths: number,
  firstRecoveryOn: string,
): Promise<void> {
  assertRecoveryMonths(recoveryMonths);
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) {
    throw new Error('You must be signed in to request an advance.');
  }
  const staffRows = unwrap(
    await supabase
      .from('hr_staff')
      .select('id')
      .eq('user_id', userId)
      .eq('active', true)
      .limit(1),
  ) as Array<{ id: string }> | null;
  if (!staffRows || staffRows.length === 0) {
    throw new Error('No active staff record is linked to your account.');
  }
  const instalment = Math.ceil(principal / recoveryMonths);
  const res = await supabase
    .from('hr_pay_advances')
    .insert({
      staff_id: staffRows[0].id,
      principal,
      purpose,
      recovery_mode: 'fixed',
      recovery_value: instalment,
      recovery_months: recoveryMonths,
      first_recovery_on: firstRecoveryOn,
      status: 'requested',
      requested_by: userId,
    })
    .select('id')
    .single();
  unwrap(res);
}

export async function updateAdvance(
  advanceId: string,
  updates: {
    purpose: string;
    recovery_months: number;
    first_recovery_on: string;
  },
): Promise<void> {
  const { purpose, recovery_months, first_recovery_on } = updates;
  assertRecoveryMonths(recovery_months);
  if (!first_recovery_on || Number.isNaN(new Date(first_recovery_on).getTime())) {
    throw new Error('First recovery date must be a valid date.');
  }
  if (!purpose || purpose.trim().length === 0) {
    throw new Error('Purpose cannot be empty.');
  }
  const existing = unwrap(
    await supabase.from('hr_pay_advances').select('principal').eq('id', advanceId),
  ) as Array<{ principal: number }> | null;
  if (!existing || existing.length === 0) {
    throw new Error('The advance could not be found.');
  }
  const principal = Number(existing[0].principal ?? 0);
  const res = await supabase
    .from('hr_pay_advances')
    .update({
      purpose: purpose.trim(),
      recovery_mode: 'fixed',
      recovery_value: Math.ceil(principal / recovery_months),
      recovery_months,
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
  let nextStatus = 'rejected';
  if (approve) {
    const current = unwrap(
      await supabase.from('hr_pay_advances').select('id, status').eq('id', advanceId),
    ) as Array<{ id: string; status: string }> | null;
    if (!current || current.length === 0) {
      throw new Error('The advance was not updated. You may not hold the authority to decide it.');
    }
    const status = current[0].status;
    if (status === 'requested') nextStatus = 'hr_approved';
    else if (status === 'hr_approved') nextStatus = 'ceo_approved';
    else if (status === 'ceo_approved') nextStatus = 'approved';
    else {
      throw new Error(
        `This advance cannot be approved from its current status '${status}'.`,
      );
    }
  }
  const res = await supabase
    .from('hr_pay_advances')
    .update({
      status: nextStatus,
      decision_note: trimmed ? trimmed : null,
    })
    .eq('id', advanceId)
    .select('id');
  const rows = unwrap(res) as Array<{ id: string }> | null;
  if (!rows || rows.length === 0) {
    throw new Error('The advance was not updated. You may not hold the authority to decide it.');
  }
}

export async function cancelAdvance(advanceId: string, reason: string): Promise<void> {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 10) {
    throw new Error('A reason of at least 10 characters is required to cancel an advance.');
  }
  const res = await supabase
    .from('hr_pay_advances')
    .update({
      status: 'cancelled',
      decision_note: trimmed,
    })
    .eq('id', advanceId)
    .select('id');
  const rows = unwrap(res) as Array<{ id: string }> | null;
  if (!rows || rows.length === 0) {
    throw new Error('The advance was not updated. You may not hold the authority to decide it.');
  }
}
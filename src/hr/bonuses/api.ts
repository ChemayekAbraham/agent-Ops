import { supabase } from '@/integrations/supabase/client';

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await (supabase.rpc as any)(fn, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

export interface BonusPool {
  pool_id: string; title: string; pool_amount: number; notes: string | null; status: string;
  people: number; total_pct: number; allocated: number;
  prepared_by_name: string | null; approved_by_name: string | null; paid_by_name: string | null;
  submitted_at: string | null; approved_at: string | null; paid_at: string | null; return_note: string | null;
}
export interface BonusDetailRow {
  staff_id: string; staff_ref: string | null; full_name: string | null; department: string | null;
  position: string | null; percentage: number; amount: number; paid_at: string | null;
}
export interface StaffOption {
  staff_id: string; staff_ref: string | null; full_name: string | null; department: string | null; position: string | null;
}
export interface BonusPending {
  pool_id: string; kind: 'approve' | 'pay' | 'rework'; title: string; pool_amount: number;
  allocated: number; people: number; return_note: string | null; prepared_by_name: string | null;
}

export const listPools = () => call<BonusPool[]>('hr_pay_bonus_list').then((r) => r ?? []);
export const poolDetail = (id: string) => call<BonusDetailRow[]>('hr_pay_bonus_detail', { _pool_id: id }).then((r) => r ?? []);
export const staffOptions = () => call<StaffOption[]>('hr_pay_bonus_staff_options').then((r) => r ?? []);
export const pendingForMe = () => call<BonusPending[]>('hr_pay_bonus_pending_for_me').then((r) => r ?? []);

export const savePool = (a: {
  id: string | null; title: string; amount: number; notes: string;
  allocations: { staff_id: string; percentage: number }[];
}) => call<string>('hr_pay_bonus_save', {
  _pool_id: a.id, _title: a.title, _pool_amount: a.amount, _notes: a.notes, _allocations: a.allocations,
});
export const submitPool = (id: string) => call<void>('hr_pay_bonus_submit', { _pool_id: id });
export const cancelPool = (id: string) => call<void>('hr_pay_bonus_cancel', { _pool_id: id });
export const approvePool = (id: string) => call<void>('hr_pay_bonus_approve', { _pool_id: id });
export const returnPool = (id: string, note: string) => call<void>('hr_pay_bonus_return', { _pool_id: id, _note: note });
export const payPool = (id: string) =>
  call<{ status: string; people: number; amount: number }>('hr_pay_bonus_pay', { _pool_id: id });

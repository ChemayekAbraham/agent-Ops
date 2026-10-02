import { supabase } from '@/integrations/supabase/client';

const db = supabase as any;

/** Lease row in the shape the bike screens use. `id` stays the sale id so the approval actions keep working. */
export interface BikeLeaseRecord {
  id: string;
  lease_id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  model_type: string | null;
  valuation_amount: number | null;
  total_amount: number | null;
  payment_projection: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  monthly_rate_pct: number;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
  ops_approved_at: string | null;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  disbursed_amount: number | null;
  tracking_reference: string | null;
  battery_serial: string | null;
  chassis_number: string | null;
  gps_tracker_id: string | null;
  plate_number: string | null;
  logbook_status: string;
}

export const mapLease = (l: any): BikeLeaseRecord => {
  const val = Number(l.valuation_amount || 0);
  const term = Math.max(1, Number(l.lease_term_months || 12));
  // First-month daily deduction: (equal principal + 28% of opening balance) / 30.
  const firstDaily = Math.round((Math.ceil(val / term) + Math.round(val * 0.28)) / 30);
  return {
    id: l.sale_id,
    lease_id: l.id,
    customer_id: l.agent_id,
    client_name: l.agent_name,
    client_phone: l.agent_phone,
    model_type: l.model,
    valuation_amount: val,
    total_amount: val,
    payment_projection: firstDaily,
    lease_term_months: l.lease_term_months,
    lease_daily_rate: null,
    monthly_rate_pct: 28,
    amount_outstanding: l.amount_outstanding,
    amount_paid: l.amount_paid,
    order_status: l.status,
    rejection_reason: l.rejection_reason,
    created_at: l.created_at,
    ops_approved_at: l.ops_approved_at,
    coo_approved_at: l.coo_approved_at,
    cfo_disbursed_at: l.cfo_disbursed_at,
    lease_activated_at: l.lease_activated_at,
    disbursed_amount: l.disbursed_amount,
    tracking_reference: l.tracking_reference,
    battery_serial: l.battery_serial,
    chassis_number: l.chassis_number,
    gps_tracker_id: l.gps_tracker_id,
    plate_number: l.plate_number,
    logbook_status: l.logbook_status,
  };
};

/** Staff queue (Agent Ops / COO / CFO), role-checked on the server. */
export async function fetchBikeLeaseQueue(status: string | null = null): Promise<BikeLeaseRecord[]> {
  const { data, error } = await db.rpc('list_bike_leases', { p_status: status });
  if (error) throw error;
  return (data || []).map(mapLease);
}

/** The signed-in agent's own leases. */
export async function fetchMyBikeLeases(agentId: string): Promise<BikeLeaseRecord[]> {
  const { data, error } = await db
    .from('agent_bike_leases')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapLease);
}

export interface BikeLeaseInstallment {
  installment_no: number;
  due_date: string;
  opening_balance: number;
  principal_due: number;
  interest_due: number;
  installment_amount: number;
  closing_balance: number;
  monthly_rate_pct: number;
  version: number;
}

/** Current (latest version) reducing-balance schedule for a lease. */
export async function fetchBikeLeaseSchedule(leaseId: string): Promise<BikeLeaseInstallment[]> {
  const { data, error } = await db
    .from('v_bike_lease_current_schedule')
    .select('*')
    .eq('lease_id', leaseId)
    .order('installment_no');
  if (error) throw error;
  return data || [];
}

export async function updateBikeLeaseAsset(
  leaseId: string,
  details: Partial<Pick<BikeLeaseRecord, 'battery_serial' | 'chassis_number' | 'gps_tracker_id' | 'plate_number' | 'logbook_status'>>,
) {
  const { data, error } = await db.rpc('update_bike_lease_asset', { p_lease_id: leaseId, p_details: details });
  if (error) throw error;
  return data;
}


export const LOGBOOK_STATUS_LABEL: Record<string, string> = {
  pending_registration: 'Pending registration',
  held_by_welile: 'Held by Welile',
  held_by_supplier: 'Held by supplier',
  with_agent: 'With agent',
  released: 'Released',
};

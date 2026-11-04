/**
 * Welile Homes historical (manually entered) float disbursements.
 *
 * Data only: every call goes through role-checked server functions (wh_hist_*).
 * Saving an entry never moves money, posts to the ledger, or changes a wallet, float,
 * float limit, or a Rent Plan's funding status. Entries are append-only; mistakes are reversed.
 */
import { supabase } from '@/integrations/supabase/client';

export const WH_HIST_BUCKET = 'wh-historical-evidence';

export const WH_CHANNELS = [
  { value: 'cash', label: 'Cash' },
  { value: 'mtn_momo', label: 'MTN Mobile Money' },
  { value: 'airtel_money', label: 'Airtel Money' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
] as const;

export type WhChannel = (typeof WH_CHANNELS)[number]['value'];

export function channelLabel(c?: string | null): string {
  if (c === 'in_app') return 'In-app (system)';
  return WH_CHANNELS.find((x) => x.value === c)?.label ?? (c || '—');
}

export interface WhManualRow {
  id: string;
  source: 'manual';
  agent_id: string;
  agent_name: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  subscription_id: string;
  tenant_name: string | null;
  amount: number;
  channel: string;
  reference: string;
  paid_on: string;
  notes: string | null;
  evidence_path: string | null;
  recorded_by: string;
  recorded_by_name: string | null;
  recorded_at: string;
  reversed: boolean;
  reversal_reason: string | null;
  reversed_at: string | null;
  reversed_by_name: string | null;
}

export interface WhSystemRow {
  id: string;
  source: 'system';
  agent_id: string;
  agent_name: string | null;
  amount: number;
  channel: 'in_app';
  reference: string | null;
  paid_on: string;
  notes: string | null;
  subscription_ids: string[] | null;
}

export interface WhHistOverview {
  manual: WhManualRow[];
  system: WhSystemRow[];
  manual_total: number;
  system_total: number;
  manual_count: number;
  system_count: number;
  can_write: boolean;
}

export interface WhHistFilters {
  agentId?: string | null;
  channel?: string | null;
  from?: string | null;
  to?: string | null;
  subscriptionId?: string | null;
}

export async function fetchWhHistOverview(f: WhHistFilters = {}): Promise<WhHistOverview> {
  const { data, error } = await (supabase.rpc as any)('wh_hist_overview', {
    p_agent_id: f.agentId || null,
    p_channel: f.channel || null,
    p_from: f.from || null,
    p_to: f.to || null,
    p_subscription_id: f.subscriptionId || null,
  });
  if (error) throw new Error(error.message);
  const d = data ?? {};
  return {
    manual: (d.manual ?? []).map((r: any) => ({ ...r, amount: Number(r.amount) || 0 })),
    system: (d.system ?? []).map((r: any) => ({ ...r, amount: Number(r.amount) || 0 })),
    manual_total: Number(d.manual_total) || 0,
    system_total: Number(d.system_total) || 0,
    manual_count: Number(d.manual_count) || 0,
    system_count: Number(d.system_count) || 0,
    can_write: !!d.can_write,
  };
}

export interface WhPlanOption {
  subscription_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  landlord_id: string | null;
  landlord_name: string;
  agent_id: string | null;
  agent_name: string | null;
  monthly_rent: number;
  subscription_status: string;
}

export async function searchWhPlans(search: string): Promise<WhPlanOption[]> {
  const { data, error } = await (supabase.rpc as any)('wh_hist_search_plans', { p_search: search });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function searchWhAgents(search: string): Promise<{ id: string; full_name: string | null; phone: string | null }[]> {
  const { data, error } = await (supabase.rpc as any)('wh_hist_search_agents', { p_search: search });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Kampala calendar date (YYYY-MM-DD). */
export function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
}

export function validateWhEntry(v: { amount: number; paidOn: string; reference: string; channel: string; agentId?: string | null; subscriptionId?: string | null }): string | null {
  if (!v.subscriptionId) return 'Choose the Rent Plan';
  if (!v.agentId) return 'Choose the agent who received the money';
  if (!(v.amount > 0)) return 'Amount must be greater than zero';
  if (!WH_CHANNELS.some((c) => c.value === v.channel)) return 'Choose the channel used';
  if (!v.reference.trim()) return 'Enter the transaction or receipt reference';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.paidOn)) return 'Enter the date it was paid';
  if (v.paidOn > kampalaToday()) return 'Date paid cannot be in the future';
  return null;
}

export async function uploadWhEvidence(file: File): Promise<string> {
  if (file.size > 10 * 1024 * 1024) throw new Error('Evidence file must be 10 MB or smaller');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `entries/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(WH_HIST_BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw new Error(error.message);
  return path;
}

export async function evidenceUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(WH_HIST_BUCKET).createSignedUrl(path, 600);
  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not open evidence');
  return data.signedUrl;
}

export type WhRecordResult = { saved?: boolean; already_saved?: boolean; duplicate?: boolean; id?: string; existing_id?: string };

/** clientRef must stay the same across retries of one submission so a retry never creates two records. */
export async function recordWhHistorical(args: {
  clientRef: string;
  agentId: string;
  subscriptionId: string;
  amount: number;
  channel: string;
  reference: string;
  paidOn: string;
  notes?: string | null;
  evidencePath?: string | null;
  confirmDuplicate?: boolean;
}): Promise<WhRecordResult> {
  const { data, error } = await (supabase.rpc as any)('wh_hist_record', {
    p_client_ref: args.clientRef,
    p_agent_id: args.agentId,
    p_subscription_id: args.subscriptionId,
    p_amount: args.amount,
    p_channel: args.channel,
    p_reference: args.reference.trim(),
    p_paid_on: args.paidOn,
    p_notes: args.notes?.trim() || null,
    p_evidence_path: args.evidencePath || null,
    p_confirm_duplicate: !!args.confirmDuplicate,
  });
  if (error) throw new Error(error.message);
  return data ?? {};
}

export async function reverseWhHistorical(args: { clientRef: string; entryId: string; reason: string }): Promise<WhRecordResult> {
  if (args.reason.trim().length < 10) throw new Error('Give a reason of at least 10 characters');
  const { data, error } = await (supabase.rpc as any)('wh_hist_reverse', {
    p_client_ref: args.clientRef,
    p_entry_id: args.entryId,
    p_reason: args.reason.trim(),
  });
  if (error) throw new Error(error.message);
  return data ?? {};
}

/** Group server rows for breakdown tables; reversed manual entries are excluded. */
export function breakdown(
  system: WhSystemRow[],
  manual: WhManualRow[],
  key: (r: WhSystemRow | WhManualRow) => string,
): { key: string; system: number; manual: number }[] {
  const m = new Map<string, { key: string; system: number; manual: number }>();
  const add = (k: string, field: 'system' | 'manual', amt: number) => {
    const row = m.get(k) ?? { key: k, system: 0, manual: 0 };
    row[field] += amt;
    m.set(k, row);
  };
  system.forEach((r) => add(key(r), 'system', r.amount));
  manual.filter((r) => !r.reversed).forEach((r) => add(key(r), 'manual', r.amount));
  return Array.from(m.values()).sort((a, b) => b.system + b.manual - (a.system + a.manual));
}

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildWhCsv(system: WhSystemRow[], manual: WhManualRow[]): string {
  const head = ['Source', 'Date paid', 'Agent', 'Landlord', 'Tenant', 'Amount (UGX)', 'Channel', 'Reference', 'Notes', 'Recorded by', 'Recorded at', 'Reversed', 'Reversal reason'];
  const rows = [
    ...system.map((r) => ['System recorded', r.paid_on, r.agent_name, '', '', r.amount, channelLabel(r.channel), r.reference, r.notes, 'System', '', '', '']),
    ...manual.map((r) => ['Manually entered - historical', r.paid_on, r.agent_name, r.landlord_name, r.tenant_name, r.amount, channelLabel(r.channel), r.reference, r.notes, r.recorded_by_name, r.recorded_at, r.reversed ? 'Yes' : 'No', r.reversal_reason]),
  ];
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

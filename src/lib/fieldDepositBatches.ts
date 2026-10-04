import { supabase } from '@/integrations/supabase/client';

export type DepositChannel = 'mtn' | 'airtel' | 'bank' | 'cash_merchant';
export type BatchStatus =
  | 'awaiting_proof'
  | 'pending_finops_verification'
  | 'verified'
  | 'rejected'
  | 'cancelled';

export type TargetBucket = 'operational_float' | 'withdrawable';

export interface FieldDepositBatch {
  id: string;
  agent_id: string;
  channel: DepositChannel;
  declared_total: number;
  tagged_total: number;
  surplus_total: number;
  proof_reference: string | null;
  proof_image_url: string | null;
  proof_submitted_at: string | null;
  status: BatchStatus;
  finops_verified_by: string | null;
  finops_verified_at: string | null;
  rejection_reason: string | null;
  notes: string | null;
  target_bucket: TargetBucket;
  created_at: string;
  updated_at: string;
}

export interface UnbatchedFieldCollection {
  id: string;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  amount: number;
  captured_at: string;
}

const CHANNEL_LABEL: Record<DepositChannel, string> = {
  mtn: 'MTN MoMo Merchant',
  airtel: 'Airtel Money Merchant',
  bank: 'Bank Deposit (Equity)',
  cash_merchant: 'Cash to Cash Agent',
};
export const channelLabel = (c: DepositChannel) => CHANNEL_LABEL[c];

const STATUS_LABEL: Record<BatchStatus, string> = {
  awaiting_proof: 'Awaiting proof',
  pending_finops_verification: 'Pending Finance review',
  verified: 'Verified · float credited',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const statusLabel = (s: BatchStatus) => STATUS_LABEL[s];

/** Confirmed-on-server field collections that aren't yet attached to any batch. */
export async function listUnbatchedFieldCollections(agentId: string): Promise<UnbatchedFieldCollection[]> {
  // 1. All synced/pending collections for this agent that aren't 'confirmed' or 'rejected' yet.
  const { data: rows, error } = await supabase
    .from('field_collections')
    .select('id, tenant_id, tenant_name, tenant_phone, amount, captured_at, status')
    .eq('agent_id', agentId)
    .eq('status', 'pending')
    .order('captured_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  const candidates = (rows ?? []) as UnbatchedFieldCollection[];
  if (candidates.length === 0) return [];

  // 2. Strip out ones already linked to a batch.
  const ids = candidates.map(r => r.id);
  const { data: linked, error: linkedErr } = await supabase
    .from('field_deposit_batch_items')
    .select('field_collection_id')
    .in('field_collection_id', ids);
  if (linkedErr) throw linkedErr;
  const taken = new Set((linked ?? []).map(r => r.field_collection_id));
  return candidates.filter(r => !taken.has(r.id));
}

export async function listAgentBatches(agentId: string, limit = 25): Promise<FieldDepositBatch[]> {
  const { data, error } = await supabase
    .from('field_deposit_batches')
    .select('*')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as FieldDepositBatch[];
}

export interface CreateBatchInput {
  agentId: string;
  channel: DepositChannel;
  declaredTotal: number;
  collectionIds: string[];
  itemAmounts: Record<string, number>;
  notes?: string | null;
  proofReference?: string | null;
  proofImageUrl?: string | null;
  targetBucket?: TargetBucket;
}

/**
 * Creates batch, attaches items, optionally submits proof in a single
 * client-side flow. Each step is a small RLS-safe insert/update.
 */
export async function createBatchWithItems(input: CreateBatchInput): Promise<FieldDepositBatch> {
  // 1. Insert the batch (always starts in awaiting_proof — RLS requires it).
  const { data: created, error: createErr } = await supabase
    .from('field_deposit_batches')
    .insert({
      agent_id: input.agentId,
      channel: input.channel,
      declared_total: input.declaredTotal,
      notes: input.notes ?? null,
      target_bucket: input.targetBucket ?? 'operational_float',
    })
    .select('*')
    .single();
  if (createErr) throw createErr;
  const batch = created as FieldDepositBatch;

  // 2. Attach items.
  if (input.collectionIds.length > 0) {
    const items = input.collectionIds.map(id => ({
      batch_id: batch.id,
      field_collection_id: id,
      amount: input.itemAmounts[id],
    }));
    const { error: itemErr } = await supabase.from('field_deposit_batch_items').insert(items);
    if (itemErr) {
      // best-effort cleanup so we don't leave an orphan batch
      await supabase.from('field_deposit_batches').delete().eq('id', batch.id);
      throw itemErr;
    }
  }

  // 3. Optional: submit proof immediately.
  if (input.proofReference && input.proofReference.trim().length > 0) {
    const { data: updated, error: proofErr } = await supabase
      .from('field_deposit_batches')
      .update({
        proof_reference: input.proofReference.trim(),
        proof_image_url: input.proofImageUrl ?? null,
        proof_submitted_at: new Date().toISOString(),
        status: 'pending_finops_verification',
      })
      .eq('id', batch.id)
      .select('*')
      .single();
    if (proofErr) throw proofErr;
    return updated as FieldDepositBatch;
  }

  return batch;
}

export async function submitProofForBatch(
  batchId: string,
  proofReference: string,
  proofImageUrl?: string | null,
): Promise<FieldDepositBatch> {
  const { data, error } = await supabase
    .from('field_deposit_batches')
    .update({
      proof_reference: proofReference.trim(),
      proof_image_url: proofImageUrl ?? null,
      proof_submitted_at: new Date().toISOString(),
      status: 'pending_finops_verification',
    })
    .eq('id', batchId)
    .select('*')
    .single();
  if (error) throw error;
  return data as FieldDepositBatch;
}

export async function cancelAwaitingBatch(batchId: string): Promise<void> {
  // Cascades delete batch items via FK.
  const { error } = await supabase.from('field_deposit_batches').delete().eq('id', batchId);
  if (error) throw error;
}

/**
 * Edit how much the agent says they actually banked for an `awaiting_proof`
 * batch. RLS only allows this while the batch is still awaiting proof — once
 * it's submitted to FinOps the declared total is locked.
 */
export async function updateBatchDeclaredTotal(
  batchId: string,
  newDeclaredTotal: number,
  notes?: string | null,
): Promise<FieldDepositBatch> {
  if (!Number.isFinite(newDeclaredTotal) || newDeclaredTotal <= 0) {
    throw new Error('Banked amount must be greater than zero');
  }
  const patch: Record<string, unknown> = { declared_total: newDeclaredTotal };
  if (typeof notes === 'string') patch.notes = notes.trim() || null;
  const { data, error } = await supabase
    .from('field_deposit_batches')
    .update(patch)
    .eq('id', batchId)
    .eq('status', 'awaiting_proof')
    .select('*')
    .single();
  if (error) throw error;
  return data as FieldDepositBatch;
}

/* --------------------------------------------------------------------- */
/* FinOps verification queue                                             */
/* --------------------------------------------------------------------- */

export interface BatchItemDetail {
  id: string;
  amount: number;
  field_collection_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
}

export interface PendingBatch extends FieldDepositBatch {
  agent_name: string | null;
  agent_phone: string | null;
  items: BatchItemDetail[];
}

/** Pending batches awaiting Financial Ops verification, with items + agent profile. */
export async function listPendingFinOpsBatches(limit = 50): Promise<PendingBatch[]> {
  const { data: batches, error } = await supabase
    .from('field_deposit_batches')
    .select('*')
    .eq('status', 'pending_finops_verification')
    .order('proof_submitted_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const list = (batches ?? []) as FieldDepositBatch[];
  if (list.length === 0) return [];

  const batchIds = list.map(b => b.id);
  const agentIds = Array.from(new Set(list.map(b => b.agent_id)));

  const [{ data: items, error: itemsErr }, { data: agents, error: agentsErr }] = await Promise.all([
    supabase
      .from('field_deposit_batch_items')
      .select('id, batch_id, amount, field_collection_id, field_collections(tenant_name, tenant_phone)')
      .in('batch_id', batchIds),
    supabase
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', agentIds),
  ]);
  if (itemsErr) throw itemsErr;
  if (agentsErr) throw agentsErr;

  const agentMap = new Map((agents ?? []).map((a: any) => [a.id, a]));
  const itemsByBatch = new Map<string, BatchItemDetail[]>();
  for (const it of (items ?? []) as any[]) {
    const detail: BatchItemDetail = {
      id: it.id,
      amount: Number(it.amount ?? 0),
      field_collection_id: it.field_collection_id,
      tenant_name: it.field_collections?.tenant_name ?? null,
      tenant_phone: it.field_collections?.tenant_phone ?? null,
    };
    const arr = itemsByBatch.get(it.batch_id) ?? [];
    arr.push(detail);
    itemsByBatch.set(it.batch_id, arr);
  }

  return list.map(b => ({
    ...b,
    agent_name: (agentMap.get(b.agent_id) as any)?.full_name ?? null,
    agent_phone: (agentMap.get(b.agent_id) as any)?.phone ?? null,
    items: itemsByBatch.get(b.id) ?? [],
  }));
}

export async function verifyBatchAsFinOps(batchId: string, proofEntered: string) {
  const { data, error } = await supabase.functions.invoke('verify-field-deposit', {
    body: { action: 'verify', batch_id: batchId, proof_entered: proofEntered },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function rejectBatchAsFinOps(batchId: string, reason: string) {
  const { data, error } = await supabase.functions.invoke('verify-field-deposit', {
    body: { action: 'reject', batch_id: batchId, reason },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Re-open a previously-rejected batch so Financial Ops can re-review and
 * potentially approve it. The batch flips back to `pending_finops_verification`
 * and re-appears in the standard verification queue. Verified batches cannot
 * be reopened — their ledger entries are immutable.
 */
export async function reopenBatchAsFinOps(batchId: string, note?: string) {
  const { data, error } = await supabase.functions.invoke('verify-field-deposit', {
    body: { action: 'reopen', batch_id: batchId, reason: note ?? '' },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

/**
 * Fallback commission rate used ONLY when stored config cannot be loaded.
 * The authoritative rate lives in `field_deposit_commission_config` and is
 * fetched via `getFieldDepositCommissionConfig()`. The UI must display a
 * warning whenever this fallback is in effect.
 */
export const FIELD_DEPOSIT_COMMISSION_RATE_FALLBACK = 0.10;

/** @deprecated Prefer `getFieldDepositCommissionConfig()`. Kept for backwards compatibility. */
export const FIELD_DEPOSIT_COMMISSION_RATE = FIELD_DEPOSIT_COMMISSION_RATE_FALLBACK;

export interface FieldDepositCommissionConfig {
  rate: number;
  min_rate: number;
  max_rate: number;
  notes: string | null;
  updated_at: string;
}

/**
 * Returns the active stored commission configuration, or `null` when no
 * config row exists. Callers should warn the user when `null` is returned —
 * the verification RPC will hard-fail in that case.
 */
export async function getFieldDepositCommissionConfig(): Promise<FieldDepositCommissionConfig | null> {
  const { data, error } = await (supabase as any).rpc('get_field_deposit_commission_config');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    rate: Number(row.rate),
    min_rate: Number(row.min_rate),
    max_rate: Number(row.max_rate),
    notes: row.notes ?? null,
    updated_at: row.updated_at,
  };
}

/** Loads tagged items (with tenant name/phone) for a single batch. */
export async function listBatchItems(batchId: string): Promise<BatchItemDetail[]> {
  const { data, error } = await supabase
    .from('field_deposit_batch_items')
    .select('id, amount, field_collection_id, field_collections(tenant_name, tenant_phone)')
    .eq('batch_id', batchId)
    .order('amount', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((it: any) => ({
    id: it.id,
    amount: Number(it.amount ?? 0),
    field_collection_id: it.field_collection_id,
    tenant_name: it.field_collections?.tenant_name ?? null,
    tenant_phone: it.field_collections?.tenant_phone ?? null,
  }));
}

/* --------------------------------------------------------------------- */
/* Audit trail                                                           */
/* --------------------------------------------------------------------- */

export type BatchAuditEvent =
  | 'created'
  | 'proof_submitted'
  | 'finops_verified'
  | 'allocation_completed'
  | 'rejected'
  | 'cancelled';

export interface BatchAuditEntry {
  id: string;
  batch_id: string;
  event: BatchAuditEvent;
  actor_id: string | null;
  actor_role: string | null;
  actor_name: string | null;
  details: Record<string, any>;
  created_at: string;
}

const AUDIT_EVENT_LABEL: Record<BatchAuditEvent, string> = {
  created: 'Batch created',
  proof_submitted: 'Proof submitted',
  finops_verified: 'Finance verified',
  allocation_completed: 'Allocation completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};
export const auditEventLabel = (e: BatchAuditEvent) => AUDIT_EVENT_LABEL[e] ?? e;

export async function listBatchAuditTrail(batchId: string): Promise<BatchAuditEntry[]> {
  const { data, error } = await (supabase as any)
    .from('field_deposit_batch_audit')
    .select('id, batch_id, event, actor_id, actor_role, details, created_at')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as BatchAuditEntry[];
  if (rows.length === 0) return [];

  const actorIds = Array.from(
    new Set(rows.map((r) => r.actor_id).filter((x): x is string => !!x)),
  );
  if (actorIds.length === 0) return rows;

  const { data: profs } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', actorIds);
  const nameMap = new Map((profs ?? []).map((p: any) => [p.id, p.full_name]));
  return rows.map((r) => ({
    ...r,
    actor_name: r.actor_id ? (nameMap.get(r.actor_id) as string) ?? null : null,
  }));
}

export interface AllocationTenantBreakdown {
  item_id: string;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  repayment: number;
  commission: number;
  generated_at: string;
}

/** Returns the per-tenant audit detail captured at verify time, if present. */
export async function getBatchAllocationDetail(
  batchId: string,
): Promise<{ generated_at: string; tenants: AllocationTenantBreakdown[] } | null> {
  const { data, error } = await (supabase as any)
    .from('field_deposit_batch_audit')
    .select('details, created_at')
    .eq('batch_id', batchId)
    .eq('event', 'allocation_completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const tenants: AllocationTenantBreakdown[] = Array.isArray(data.details?.tenants)
    ? data.details.tenants.map((t: any) => ({
        item_id: t.item_id,
        tenant_id: t.tenant_id ?? null,
        tenant_name: t.tenant_name ?? null,
        tenant_phone: t.tenant_phone ?? null,
        repayment: Number(t.repayment ?? 0),
        commission: Number(t.commission ?? 0),
        generated_at: t.generated_at ?? data.created_at,
      }))
    : [];
  return { generated_at: data.created_at, tenants };
}

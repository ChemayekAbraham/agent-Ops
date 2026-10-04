import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every supabase call so we can assert the wire payloads that drive
// operational_float vs withdrawable routing.
type Call = { table: string; op: string; payload?: any; filters?: any };
const calls: Call[] = [];
let lastInsertedBatch: any = null;

function makeQueryBuilder(table: string) {
  const state: any = { table, filters: {} as Record<string, any> };
  const builder: any = {
    insert(payload: any) {
      state.op = 'insert';
      state.payload = payload;
      calls.push({ table, op: 'insert', payload });
      if (table === 'field_deposit_batches') {
        lastInsertedBatch = {
          id: 'batch-test-1',
          agent_id: payload.agent_id,
          channel: payload.channel,
          declared_total: payload.declared_total,
          tagged_total: 0,
          surplus_total: 0,
          proof_reference: null,
          proof_image_url: null,
          proof_submitted_at: null,
          status: 'awaiting_proof',
          finops_verified_by: null,
          finops_verified_at: null,
          rejection_reason: null,
          notes: payload.notes ?? null,
          target_bucket: payload.target_bucket ?? 'operational_float',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      return builder;
    },
    update(payload: any) {
      state.op = 'update';
      state.payload = payload;
      calls.push({ table, op: 'update', payload, filters: state.filters });
      if (table === 'field_deposit_batches' && lastInsertedBatch) {
        lastInsertedBatch = { ...lastInsertedBatch, ...payload };
      }
      return builder;
    },
    delete() {
      calls.push({ table, op: 'delete', filters: state.filters });
      return builder;
    },
    select() {
      return builder;
    },
    eq(col: string, val: any) {
      state.filters[col] = val;
      return builder;
    },
    single() {
      if (table === 'field_deposit_batches') {
        return Promise.resolve({ data: lastInsertedBatch, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then(resolve: any) {
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

const invokeMock = vi.fn(async (_fn: string, _args: any) => ({
  data: { ok: true },
  error: null,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => makeQueryBuilder(table),
    functions: { invoke: (fn: string, args: any) => invokeMock(fn, args) },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
}));

import { createBatchWithItems, verifyBatchAsFinOps } from '../fieldDepositBatches';

beforeEach(() => {
  calls.length = 0;
  lastInsertedBatch = null;
  invokeMock.mockClear();
});

describe('createBatchWithItems - bucket routing', () => {
  it('defaults to operational_float and attaches tenant items', async () => {
    const batch = await createBatchWithItems({
      agentId: 'agent-1',
      channel: 'mtn',
      declaredTotal: 500_000,
      collectionIds: ['c1', 'c2'],
      itemAmounts: { c1: 200_000, c2: 300_000 },
    });

    const batchInsert = calls.find(
      (c) => c.table === 'field_deposit_batches' && c.op === 'insert',
    );
    expect(batchInsert?.payload.target_bucket).toBe('operational_float');
    expect(batchInsert?.payload.declared_total).toBe(500_000);

    const itemsInsert = calls.find(
      (c) => c.table === 'field_deposit_batch_items' && c.op === 'insert',
    );
    expect(itemsInsert).toBeDefined();
    expect(itemsInsert?.payload).toHaveLength(2);
    expect(batch.target_bucket).toBe('operational_float');
  });

  it('routes withdrawable batches without inserting tenant items', async () => {
    const batch = await createBatchWithItems({
      agentId: 'agent-1',
      channel: 'bank',
      declaredTotal: 1_000_000,
      collectionIds: [],
      itemAmounts: {},
      targetBucket: 'withdrawable',
    });

    const batchInsert = calls.find(
      (c) => c.table === 'field_deposit_batches' && c.op === 'insert',
    );
    expect(batchInsert?.payload.target_bucket).toBe('withdrawable');
    expect(batchInsert?.payload.declared_total).toBe(1_000_000);

    const itemsInsert = calls.find(
      (c) => c.table === 'field_deposit_batch_items' && c.op === 'insert',
    );
    expect(itemsInsert).toBeUndefined();
    expect(batch.target_bucket).toBe('withdrawable');
  });

  it('forwards proof reference and flips status to pending_finops_verification', async () => {
    const batch = await createBatchWithItems({
      agentId: 'agent-1',
      channel: 'mtn',
      declaredTotal: 250_000,
      collectionIds: [],
      itemAmounts: {},
      targetBucket: 'withdrawable',
      proofReference: 'MTN-REF-123',
    });

    const proofUpdate = calls.find(
      (c) => c.table === 'field_deposit_batches' && c.op === 'update',
    );
    expect(proofUpdate?.payload.proof_reference).toBe('MTN-REF-123');
    expect(proofUpdate?.payload.status).toBe('pending_finops_verification');
    expect(batch.status).toBe('pending_finops_verification');
    expect(batch.target_bucket).toBe('withdrawable');
  });
});

describe('verifyBatchAsFinOps - approval handoff', () => {
  it('invokes verify-field-deposit with batch id and proof; bucket routing is server-side', async () => {
    await verifyBatchAsFinOps('batch-test-1', 'MTN-REF-123');
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [fn, args] = invokeMock.mock.calls[0];
    expect(fn).toBe('verify-field-deposit');
    expect(args.body).toEqual({
      action: 'verify',
      batch_id: 'batch-test-1',
      proof_entered: 'MTN-REF-123',
    });
    // Approval payload intentionally omits target_bucket - the server-side RPC
    // reads it from the stored batch row to route the declared_total.
    expect((args.body as any).target_bucket).toBeUndefined();
  });
});

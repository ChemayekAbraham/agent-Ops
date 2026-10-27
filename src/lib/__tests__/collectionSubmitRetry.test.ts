import { describe, it, expect, beforeEach } from 'vitest';
import {
  callWithRetry, classifyAllocateError, clientRefFor, clearClientRef,
  queueCollection, listPendingCollections, removeQueuedCollection,
} from '../collectionSubmitRetry';

const noSleep = { sleep: async () => {} };

describe('collection submit retry', () => {
  beforeEach(() => localStorage.clear());

  it('retries 57014 up to 3 attempts then gives up', async () => {
    let n = 0;
    const r = await callWithRetry(async () => { n++; return { data: null, error: { code: '57014' } }; }, noSleep);
    expect(n).toBe(3);
    expect(r.lastKind).toBe('transient_db');
  });

  it('recovers after a lock timeout', async () => {
    let n = 0;
    const r = await callWithRetry(async () => (++n === 1 ? { data: null, error: { code: '55P03' } } : { data: { success: true }, error: null }), noSleep);
    expect(n).toBe(2);
    expect(r.recovered).toBe(true);
  });

  it('never retries business rejections or permission errors', async () => {
    let n = 0;
    await callWithRetry(async () => { n++; return { data: { success: false, error_code: 'INSUFFICIENT_FLOAT' }, error: null }; }, noSleep);
    await callWithRetry(async () => { n++; return { data: null, error: { code: '42501' } }; }, noSleep);
    expect(n).toBe(2);
  });

  it('classifies network and schema-cache errors as retryable', () => {
    expect(classifyAllocateError(new TypeError('Failed to fetch'))).toBe('network');
    expect(classifyAllocateError({ code: 'PGRST002' })).toBe('transient_db');
    expect(classifyAllocateError({ status: 503 })).toBe('transient_db');
  });

  it('keeps one client_ref per collection until success, new one for a different amount', () => {
    const a = clientRefFor('t1', 'p1', 5000);
    expect(clientRefFor('t1', 'p1', 5000)).toBe(a);
    expect(clientRefFor('t1', 'p1', 6000)).not.toBe(a);
    clearClientRef('t1', 'p1', 5000);
    expect(clientRefFor('t1', 'p1', 5000)).not.toBe(a);
  });

  it('queues exact args by client_ref and removes them', () => {
    const args = { p_agent_id: 'a', p_tenant_id: 't', p_rent_request_id: 'p', p_amount: 7000, p_notes: null, p_partial_confirmed: true, p_partial_reason: null, p_client_ref: 'ref-1' };
    queueCollection(args);
    queueCollection(args);
    expect(listPendingCollections()).toHaveLength(1);
    expect(listPendingCollections()[0].args).toEqual(args);
    removeQueuedCollection('ref-1');
    expect(listPendingCollections()).toHaveLength(0);
  });
});

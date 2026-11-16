import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), upload: vi.fn(), download: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: (bucket: string) => ({ upload: (p: string, f: File, o: unknown) => mocks.upload(bucket, p, f, o), download: (p: string) => mocks.download(bucket, p) }) },
  },
}));
vi.mock('@/lib/imageOptimizer', () => ({ optimizeImage: vi.fn(async (file: File) => ({ file })) }));

import {
  MAX_DRAFT_BYTES, closeDraft, downloadDraftPhoto, draftsAvailable, fetchMyDrafts, fitDraftPayload, payloadBytes,
  resetDraftsAvailability, saveDraft, uploadDraftPhoto, type PostingDraftPayload,
} from '@/lib/postingDrafts';

const PGRST202 = { code: 'PGRST202', message: 'Could not find the function public.posting_draft_save in the schema cache' };

const payload = (over: Partial<PostingDraftPayload['fields']> = {}): PostingDraftPayload => ({
  v: 1,
  fields: {
    planType: 'daily', rentText: '300000', tenantPhone: '0783 123 456', tenantNameParts: { firstName: 'John', otherNames: '', lastName: 'Mukasa' },
    familySize: '4', work: 'Tailor', address: 'Plot 14, Kireka', category: 'single_room', gps: { lat: 0.33, lng: 32.6, accuracy: 8 },
    landlord: { id: 'll-1', name: 'Peter Okello', phone: '0772000111', property_address: null }, ...over,
  },
  photos: {
    house: [0, 1, 2, 3].map((i) => ({ bucket: 'house-images', path: `agent-1/draft-x/house_${i}_1.jpg` })),
    tenantPhoto: { bucket: 'house-images', path: 'agent-1/draft-x/tenant_photo_0_1.jpg' },
    idFront: { bucket: 'tenant-ids', path: 'agent-1/draft-x/id_front_0_1.jpg' },
    idBack: { bucket: 'tenant-ids', path: 'agent-1/draft-x/id_back_0_1.jpg' },
    lcLetter: { bucket: 'lc-letters', path: 'agent-1/draft-x/lc1_letter_0_1.jpg' },
  },
});

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.upload.mockReset().mockResolvedValue({ error: null });
  mocks.download.mockReset();
  resetDraftsAvailability();
});

describe('E109 drafts: payload', () => {
  it('a full draft with photo paths is far under 200 KB; no base64 anywhere', () => {
    const p = payload();
    expect(payloadBytes(p)).toBeLessThan(MAX_DRAFT_BYTES);
    expect(JSON.stringify(p)).not.toMatch(/data:image|base64/);
  });

  it('a payload over the limit is trimmed under it, photos kept', () => {
    const big = payload({ house: { id: 'h1', image_urls: Array.from({ length: 4000 }, (_, i) => `https://cdn.example/house/${i}/a-very-long-image-name.jpg`) } });
    expect(payloadBytes(big)).toBeGreaterThan(MAX_DRAFT_BYTES);
    const fitted = fitDraftPayload(big);
    expect(payloadBytes(fitted)).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
    expect(fitted.photos).toEqual(big.photos);
  });

  it('photos are stored under the agent and come back as files', async () => {
    const stored = await uploadDraftPhoto('agent-1', 'draft-x', 'id_front', new File(['f'], 'f.jpg', { type: 'image/jpeg' }));
    expect(stored.bucket).toBe('tenant-ids');
    expect(stored.path).toMatch(/^agent-1\/draft-x\/id_front_0_\d+\.jpg$/);
    mocks.download.mockResolvedValueOnce({ data: new Blob(['x'], { type: 'image/jpeg' }), error: null });
    const file = await downloadDraftPhoto(stored, 'id_front.jpg');
    expect(file).toBeInstanceOf(File);
    expect(mocks.download).toHaveBeenCalledWith('tenant-ids', stored.path);
  });
});

describe('E109 drafts: RPCs', () => {
  it('saves with every argument and keeps the returned id', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { id: 'd1' }, error: null });
    const res = await saveDraft({ payload: payload(), missing: ['family_size', 'family_size', 'id_back'], tenantName: 'John Mukasa', tenantPhone: '0783 123 456', draftId: null, session: 's1' });
    expect(res).toEqual({ ok: true, id: 'd1' });
    expect(mocks.rpc).toHaveBeenCalledWith('posting_draft_save', expect.objectContaining({
      p_missing: ['family_size', 'id_back'], p_tenant_name: 'John Mukasa', p_tenant_phone: '0783 123 456', p_draft_id: null, p_session: 's1',
    }));
    expect(draftsAvailable()).toBe(true);
  });

  it('a missing RPC (PGRST202) hides drafts silently', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: PGRST202 });
    await expect(saveDraft({ payload: payload(), missing: ['rent'], tenantName: null, tenantPhone: null, draftId: null, session: null }))
      .resolves.toEqual({ ok: false, missingRpc: true, message: '' });
    expect(draftsAvailable()).toBe(false);
    resetDraftsAvailability();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function public.posting_drafts_mine() does not exist' } });
    await expect(fetchMyDrafts()).resolves.toBeNull();
    expect(draftsAvailable()).toBe(false);
  });

  it('lists the agent\'s drafts, and closes them as discarded or posted', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ id: 'd1', tenant_name: 'John', missing: 'Family size', expires_at: '2026-11-23T00:00:00Z', payload: payload() }], error: null });
    await expect(fetchMyDrafts()).resolves.toHaveLength(1);
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(closeDraft('d1', 'discarded')).resolves.toBeNull();
    expect(mocks.rpc).toHaveBeenLastCalledWith('posting_draft_close', { p_draft_id: 'd1', p_status: 'discarded' });
    await closeDraft('d1', 'posted', 'req-1');
    expect(mocks.rpc).toHaveBeenLastCalledWith('posting_draft_close', { p_draft_id: 'd1', p_status: 'posted', p_rent_request_id: 'req-1' });
  });
});

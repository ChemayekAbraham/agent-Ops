import { beforeEach, describe, expect, it, vi } from 'vitest';

const photos = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/lib/formPhotoDraft', async (orig) => ({
  ...(await orig<typeof import('@/lib/formPhotoDraft')>()),
  saveFormPhotos: async (k: string, v: unknown) => { photos.set(k, v); },
  loadFormPhotos: async (k: string) => photos.get(k) ?? null,
  clearFormPhotos: async (k: string) => { photos.delete(k); },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), auth: {
  getSession: async () => ({ data: { session: { user: { id: 'agent-1' }, access_token: 't' } }, error: null }),
} } }));

import {
  RELOAD_RETRY_MS, STARTUP_MAX_LAG_MS, UPDATE_MARKER_KEY, buildLabel, findNewerBuild, readUpdateMarker, reloadToBuild,
  settleAppUpdate, startupUpdate,
} from '@/lib/appUpdate';
import { logFormEvent } from '@/lib/formFunnel';
import { T4_RESUME_KEY, readT4Resume, resumeRequestFor, saveT4Resume } from '@/lib/t4Resume';

const HOUR = 60 * 60 * 1000;
const RUNNING = { source: 'old-src', builtAt: '2026-11-16T08:00:00.000Z' };
const at = (hoursAfter: number) => ({ source: 'new-src', builtAt: new Date(Date.parse(RUNNING.builtAt) + hoursAfter * HOUR).toISOString() });
const NOW = Date.parse('2026-11-17T10:22:00.000Z');

beforeEach(() => {
  localStorage.clear();
  photos.clear();
});

describe('the start-up reload: a build more than 1 hour behind reloads at once', () => {
  it('2 hours behind: reloads, noting from and to for the log', async () => {
    const reload = vi.fn();
    const live = at(2);
    const did = await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => live, reload, now: () => NOW });
    expect(did).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(readUpdateMarker()).toMatchObject({
      reason: 'startup', from: buildLabel(RUNNING), to: buildLabel(live), fromSource: 'old-src', toSource: 'new-src', at: NOW,
    });
    expect(STARTUP_MAX_LAG_MS).toBe(1 * HOUR);
  });

  it('30 minutes behind, exactly 1 hour, the same build, or no answer: no reload', async () => {
    const reload = vi.fn();
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => at(0.5), reload })).toBe(false);
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => at(1), reload })).toBe(false);
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => RUNNING, reload })).toBe(false);
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => null, reload })).toBe(false);
    // A check that never answers gives up.
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: () => new Promise(() => {}), timeoutMs: 20, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a reload that brought back the old build is not tried again for 10 minutes (no loop)', async () => {
    const reload = vi.fn();
    const live = at(20);
    await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => live, reload, now: () => NOW });
    // The page came back on the old build (a cached page).
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => live, reload, now: () => NOW + 60_000 })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await startupUpdate({ anyMode: true, running: RUNNING, fetchLive: async () => live, reload, now: () => NOW + RELOAD_RETRY_MS + 1 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('outside a production build nothing is checked', async () => {
    const fetchLive = vi.fn(async () => at(30));
    expect(await findNewerBuild({ running: RUNNING, fetchLive })).toBeNull();
    expect(fetchLive).not.toHaveBeenCalled();
  });
});

describe("'app_updated' { from_build, to_build } once the new build runs", () => {
  it('logs it in the session of the chat that updated, and clears the note', () => {
    const live = at(3);
    reloadToBuild(live, { reason: 'send', form: 'renewal', session: 'sess-1' }, { running: RUNNING, now: () => NOW, reload: vi.fn() });
    const log = vi.fn();
    const out = settleAppUpdate({ running: live, now: () => NOW + 5000, log });
    expect(out).toEqual({ from_build: buildLabel(RUNNING), to_build: buildLabel(live), reason: 'send' });
    expect(log).toHaveBeenCalledWith('renewal', 'app_updated', { from_build: 'old-src@2026-11-16T08:00:00.000Z', to_build: buildLabel(live), reason: 'send' }, 'sess-1');
    expect(localStorage.getItem(UPDATE_MARKER_KEY)).toBeNull();
  });

  it('still on the old build: nothing logged, the note kept as the loop guard', () => {
    reloadToBuild(at(3), { reason: 'startup' }, { running: RUNNING, now: () => NOW, reload: vi.fn() });
    const log = vi.fn();
    expect(settleAppUpdate({ running: RUNNING, now: () => NOW + 1000, log })).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(readUpdateMarker()).not.toBeNull();
  });

  it('the row sent to request_form_log', async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    logFormEvent('agent_post', 'app_updated', { from_build: 'a@1', to_build: 'b@2' }, 'sess-9', rpc);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith('request_form_log', expect.objectContaining({
      p_event: 'app_updated', p_form: 'agent_post', p_session: 'sess-9',
      p_meta: expect.objectContaining({ from_build: 'a@1', to_build: 'b@2' }),
    }));
  });
});

describe('the chat kept across the update', () => {
  it('keeps answers, new photo files and server photo URLs; reopens for the same agent only, with resume', async () => {
    const file = new File(['x'], 'id.jpg', { type: 'image/jpeg' });
    const ok = await saveT4Resume({
      userId: 'agent-1',
      request: { mode: 'renewal', renewal: { prevId: 'prev-1', tenantId: 't-1', tenantName: 'John', currentRent: 300000, currentDays: 30 }, onDone: () => {} },
      form: 'renewal', session: 'sess-1',
      state: { current: 'renewPlan', renewChoice: { newRent: 8_000_000, newDays: 30 } },
      photos: {
        house: [{ file: null, preview: 'https://cdn/1.jpg' }, null, null, null],
        tenantPhoto: null, idFront: { file, preview: 'blob:x' }, idBack: null, lcLetter: null,
      },
      now: NOW,
    });
    expect(ok).toBe(true);
    const rec = readT4Resume('agent-1', NOW + 1000)!;
    expect(rec.request).toEqual({ mode: 'renewal', renewal: expect.objectContaining({ prevId: 'prev-1' }), entry: 'app_update' });
    expect(rec.photoUrls.house[0]).toBe('https://cdn/1.jpg');
    expect(rec.photoUrls.idFront).toBeNull(); // the file is in IndexedDB, not the blob URL
    expect(resumeRequestFor('agent-1', NOW + 1000)).toMatchObject({ mode: 'renewal', resume: true });
    expect(resumeRequestFor('agent-2', NOW + 1000)).toBeNull();
    expect(resumeRequestFor('agent-1', NOW + 31 * 60 * 1000)).toBeNull();
    expect(localStorage.getItem(T4_RESUME_KEY)).not.toBeNull();
  });
});

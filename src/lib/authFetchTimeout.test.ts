import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withAuthFetchTimeout } from './authFetchTimeout';

describe('auth lock request deadlines', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  for (const path of ['/auth/v1/token?grant_type=refresh_token', '/auth/v1/user']) {
    it(`aborts a hung ${path} at 15 seconds, not earlier`, async () => {
      let signal: AbortSignal | null = null;
      const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      });
      const pending = withAuthFetchTimeout(fetcher)(`https://example.supabase.co${path}`);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(signal?.aborted).toBe(true);
    });
  }

  it('leaves database and storage fetches unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const init = { method: 'GET' };
    await withAuthFetchTimeout(fetcher)('https://example.supabase.co/rest/v1/profiles', init);
    expect(fetcher).toHaveBeenCalledWith('https://example.supabase.co/rest/v1/profiles', init);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours caller cancellation and removes the deadline after completion', async () => {
    const caller = new AbortController();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = withAuthFetchTimeout(fetcher)('https://example.supabase.co/auth/v1/user', { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
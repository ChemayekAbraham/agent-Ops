import { afterEach, describe, expect, it, vi } from 'vitest';
import { timestampSafeFetch, timestampSafeUrl, timestampToIso } from '../timestampSafeFetch';

afterEach(() => vi.unstubAllGlobals());
describe('URL-safe timestamp filters', () => {
  for (const table of ['assistant_escalations', 'neexa_messages', 'assistant_messages']) {
    it(`normalizes the reported raw +00 poll cursor for ${table}`, () => {
      const result = timestampSafeUrl(`https://example.test/rest/v1/${table}?created_at=gt.2026-11-11T18:20:44.645953+00&select=*`);
      expect(new URL(result).searchParams.get('created_at')).toBe('gt.2026-11-11T18:20:44.645Z');
      expect(new URL(result).searchParams.get('select')).toBe('*');
    });
  }
  it('normalizes encoded +00:00 and retains non-UTC instants', () => {
    expect(timestampToIso('2026-11-11T18:20:44.645953+00')).toBe('2026-11-11T18:20:44.645Z');
    expect(timestampToIso('2026-11-11T18:20:44.645953+00:00')).toBe('2026-11-11T18:20:44.645Z');
    const url = timestampSafeUrl('https://example.test/rest/v1/agent_collections?created_at=gte.2026-11-11T00:00:00%2B03:00');
    expect(new URL(url).searchParams.get('created_at')).toBe('gte.2026-11-10T21:00:00.000Z');
  });
  it('leaves auth, invalid timestamps and unrelated fields untouched', () => {
    for (const url of ['https://example.test/auth/v1/user?created_at=gt.2026-11-11T00:00:00+00', 'https://example.test/rest/v1/x?created_at=gt.bad', 'https://example.test/rest/v1/x?name=eq.A+B']) {
      expect(timestampSafeUrl(url)).toBe(url);
    }
  });
  it('preserves a request body and caller headers while fixing its URL', async () => {
    const send = vi.fn().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', send);
    const request = new Request('https://example.test/rest/v1/assistant_messages?created_at=gt.2026-11-11T18:20:44+00', {
      method: 'POST', headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' }, body: '{"test":true}',
    });
    await timestampSafeFetch(request);
    const sent = send.mock.calls[0][0] as Request;
    expect(new URL(sent.url).searchParams.get('created_at')).toBe('gt.2026-11-11T18:20:44.000Z');
    expect(sent.headers.get('Authorization')).toBe('Bearer test-user');
    expect(await sent.text()).toBe('{"test":true}');
  });
});
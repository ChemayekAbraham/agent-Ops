import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), from: vi.fn(), insert: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { auth: { getSession: mocks.getSession }, from: mocks.from } }));
vi.mock('@/lib/getPublicOrigin', () => ({ CANONICAL_ORIGIN: window.location.origin }));
import { reportClientError, setReportingTags } from '@/lib/errorReporting';

describe('client error reporting session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockReturnValue({ insert: mocks.insert });
    mocks.insert.mockResolvedValue({ error: null });
    setReportingTags({ userId: 'old-account', role: 'tenant' });
  });

  it('silently skips anonymous reports even with stale account tags', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    expect(await reportClientError({ source: 'manual', message: 'Anonymous failure' })).toBe(true);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('uses the current session account for a single signed-in insert', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'current-account' } } }, error: null });
    expect(await reportClientError({ source: 'manual', message: 'Signed-in failure' })).toBe(true);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'current-account' }));
  });

  it('treats a permission denial as handled without warnings or retries', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'current-account' } } }, error: null });
    mocks.insert.mockResolvedValue({ error: { code: '42501', message: 'permission denied for table client_error_reports' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await reportClientError({ source: 'manual', message: 'Expired session failure' })).toBe(true);
      expect(mocks.insert).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });
});
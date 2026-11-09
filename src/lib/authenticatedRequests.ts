import { supabase } from '@/integrations/supabase/client';

/** Check the client's current session immediately before authenticated work. */
export async function withUserSession<T extends PromiseLike<unknown>>(load: () => T): Promise<Awaited<T>> {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user?.id || !data.session.access_token ||
    (data.session.expires_at != null && data.session.expires_at * 1000 <= Date.now())) {
    return {
      data: null,
      error: { message: 'Sign in again to continue.', code: 'AUTH_REQUIRED' },
      count: null, status: 401, statusText: 'Unauthorized',
    } as Awaited<T>;
  }
  return await load();
}

/** Preserve server-validated identity, but never send an anon token to /auth/user. */
export async function getSessionCheckedUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.user?.id || !data.session.access_token ||
    (data.session.expires_at != null && data.session.expires_at * 1000 <= Date.now())) {
    return { data: { user: null }, error: error ?? null };
  }
  return supabase.auth.getUser(data.session.access_token);
}
/**
 * HR transport layer — the single swap point.
 *
 * Live: every HR read/write goes through the project Supabase client.
 * Errors are returned to the caller, never swallowed.
 */
import { supabase } from '@/integrations/supabase/client';

export { supabase };

/** Throws the Supabase error verbatim so callers can surface it. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data as T;
}

/** The auth user id of the caller. Required for every HR write. */
export async function requireUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  if (!data.user) throw new Error('Not signed in');
  return data.user.id;
}

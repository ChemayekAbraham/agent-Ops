/**
 * Server-side mirror of the user's home-screen routing preferences.
 *
 * Persisted under `profiles.routing_preferences` so the user's chosen
 * default dashboard and "skip agent auto-default" opt-out survive
 * across devices and localStorage wipes.
 *
 * Schema:
 *   {
 *     defaultRole?: DefaultRolePreference,
 *     disableAgentAutoDefault?: boolean
 *   }
 */
import { supabase } from '@/integrations/supabase/client';
import type { DefaultRolePreference } from '@/hooks/useAppPreferences';

export interface ServerRoutingPrefs {
  defaultRole?: DefaultRolePreference;
  disableAgentAutoDefault?: boolean;
}

export async function fetchServerRoutingPrefs(
  userId: string,
  timeoutMs = 1200,
): Promise<ServerRoutingPrefs | null> {
  try {
    const fetchPromise = supabase
      .from('profiles')
      .select('routing_preferences')
      .eq('id', userId)
      .maybeSingle();

    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), timeoutMs),
    );

    const { data, error } = (await Promise.race([fetchPromise, timeoutPromise])) as any;
    if (error || !data) return null;
    const raw = (data as any).routing_preferences;
    if (!raw || typeof raw !== 'object') return null;
    return raw as ServerRoutingPrefs;
  } catch {
    return null;
  }
}

export async function saveServerRoutingPrefs(
  userId: string,
  patch: ServerRoutingPrefs,
): Promise<void> {
  try {
    // Merge with whatever is already on the server so we never blow away
    // keys this client doesn't know about.
    const existing = (await fetchServerRoutingPrefs(userId)) ?? {};
    const merged = { ...existing, ...patch };
    await supabase.from('profiles').update({ routing_preferences: merged }).eq('id', userId);
  } catch (e) {
    // Non-fatal — localStorage is still the primary cache.
    console.warn('[routingPrefs] failed to save to server:', e);
  }
}

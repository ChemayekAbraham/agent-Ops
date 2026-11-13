import { createClient } from '@supabase/supabase-js';
import { readBoardFeed, readBoardList, type BoardMetric, type BoardPeriod } from './boardDisplay';

// Never restore the operator's account: board links use only the public key and token-checked RPC.
const boardClient = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
export async function loadBoardDisplay(token: string, signal: AbortSignal) {
  if (!token) throw new Error('This display link is missing its token.');
  const { data, error } = await boardClient.rpc('board_display_feed', { p_token: token }).abortSignal(signal);
  if (error) {
    // Keep the server's SQLSTATE: 28000 means the link itself is refused (isBoardLinkError).
    throw Object.assign(new Error(error.message), { code: error.code });
  }
  return readBoardFeed(data);
}
/**
 * The Google Maps browser key for the ops map: the connector key built into the
 * page, else the backend's maps-browser-key function called with the anon key
 * only (never the operator's session). Referrer-restricted, so publishable.
 */
export async function boardMapsKey(): Promise<string> {
  const connectorKey = import.meta.env['VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY'] as string | undefined;
  if (connectorKey) return connectorKey;
  const { data, error } = await boardClient.functions.invoke('maps-browser-key');
  if (!error && data && typeof (data as { key?: string }).key === 'string') return (data as { key: string }).key;
  throw new Error('The map is not connected.');
}
/** The requests behind one tile: token-checked, anon key, no names or phone numbers. */
export async function loadBoardList(token: string, period: BoardPeriod, kind: BoardMetric, signal: AbortSignal) {
  if (!token) throw new Error('This display link is missing its token.');
  const { data, error } = await boardClient.rpc('board_display_list', { p_token: token, p_period: period, p_kind: kind }).abortSignal(signal);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return readBoardList(data, period, kind);
}

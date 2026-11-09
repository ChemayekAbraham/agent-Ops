import { createClient } from '@supabase/supabase-js';
import { readBoardFeed } from './boardDisplay';

// Never restore the operator's account: board links use only the public key and token-checked RPC.
const boardClient = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
export async function loadBoardDisplay(token: string, signal: AbortSignal) {
  if (!token) throw new Error('This display link is missing its token.');
  const { data, error } = await boardClient.rpc('board_display_feed', { p_token: token }).abortSignal(signal);
  if (error) throw new Error(error.message);
  return readBoardFeed(data);
}
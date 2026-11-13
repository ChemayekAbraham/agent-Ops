import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { floatHoldBreakdown, floatShortHoldHint } from '@/lib/funderSavedTabs';

/** Read fresh, caller-owned operational float after holds; never a wallet total. */
export async function readFunderOperationalFloat(userId: string): Promise<number> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData.session;
  if (!session?.access_token || session.user.id !== userId) {
    throw new Error('Sign in again to continue.');
  }
  const { data, error } = await supabase.rpc('funder_support_capacity', { p_user_id: userId });
  if (error) throw error;
  const amount = data === null || data === undefined ? NaN : Number(data);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Operational float is unavailable.');
  return amount;
}

export async function requireFunderOperationalFloat(userId: string | undefined, total: number): Promise<void> {
  if (!userId) throw new Error('Sign in again to continue.');
  if (!Number.isFinite(total) || total <= 0) throw new Error('Support amount is unavailable.');
  const available = await readFunderOperationalFloat(userId);
  if (total > available) {
    const hint = await coSupportHoldHint(userId, available);
    throw new Error(`Your operational float is ${formatUGX(total - available)} short. Withdrawable balance cannot be used for this support.${hint}`);
  }
}

/** " UGX X is held for your open co-support. ..." when a co-support hold explains the gap; '' otherwise or on any read error. */
async function coSupportHoldHint(userId: string, available: number): Promise<string> {
  try {
    const [bal, invites] = await Promise.all([
      supabase.rpc('get_user_float_available_balance', { p_user_id: userId }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase.rpc as any)('co_support_my_invites'),
    ]);
    if (bal.error || invites.error) return '';
    return floatShortHoldHint(floatHoldBreakdown({ floatBalance: Number(bal.data ?? 0), available, invites: invites.data }));
  } catch {
    return '';
  }
}
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

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
    throw new Error(`Your operational float is ${formatUGX(total - available)} short. Withdrawable balance cannot be used for this support.`);
  }
}
import { supabase } from '@/integrations/supabase/client';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

/**
 * Create or retrieve a short link for the given path + params.
 * Returns the full short URL like https://domain.com/r/X7kM2p
 */
export async function createShortLink(
  userId: string,
  targetPath: string,
  targetParams: Record<string, string>,
): Promise<string> {
  const findExisting = async () => {
    const { data } = await supabase
      .from('short_links')
      .select('code, target_params')
      .eq('user_id', userId)
      .eq('target_path', targetPath)
      .contains('target_params', targetParams as any);
    if (!data) return null;
    const exact = data.find((row: any) => {
      const stored = (row.target_params ?? {}) as Record<string, string>;
      const keys = new Set([...Object.keys(stored), ...Object.keys(targetParams)]);
      for (const k of keys) {
        if (String(stored[k] ?? '') !== String(targetParams[k] ?? '')) return false;
      }
      return true;
    });
    return exact?.code ?? null;
  };

  const existingCode = await findExisting();
  if (existingCode) return `${getPublicOrigin()}/r/${existingCode}`;

  const { data: created, error } = await supabase
    .from('short_links')
    .insert({
      user_id: userId,
      target_path: targetPath,
      target_params: targetParams as any,
    })
    .select('code')
    .single();

  if (!error && created) {
    return `${getPublicOrigin()}/r/${created.code}`;
  }

  const retryCode = await findExisting();
  if (retryCode) return `${getPublicOrigin()}/r/${retryCode}`;

  throw error ?? new Error('Failed to create short link');
}

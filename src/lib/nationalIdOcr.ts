import { supabase } from '@/integrations/supabase/client';

export type NationalIdSide = 'front' | 'back';

export interface NationalIdReading {
  side?: NationalIdSide;
  printed_text?: string;
  full_name: string;
  surname: string;
  given_names: string;
  id_number: string;
  date_of_birth: string;
  is_national_id: boolean;
  readable: boolean;
  account_name: string;
  account_national_id: string | null;
  name_match_score: number | null;
  failure_reason?: string | null;
  error?: string;
}

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Reads the names and ID number printed on a National ID photo.
 * Never throws: a failure returns `{ error }` so the person can still type
 * their details by hand.
 */
export async function readNationalIdPhoto(
  file: File,
  side: NationalIdSide = 'front',
): Promise<NationalIdReading | { error: string }> {
  try {
    const imageBase64 = await fileToBase64(file);
    const { data, error } = await supabase.functions.invoke('read-national-id', {
      body: { imageBase64, side },
    });
    if (error) return { error: 'Could not read that photo automatically.' };
    return data as NationalIdReading;
  } catch {
    return { error: 'Could not read that photo automatically.' };
  }
}

/** Plain-language verdict on how well the ID name matches the account name. */
export function idNameVerdict(score: number | null): 'match' | 'partial' | 'mismatch' | 'unknown' {
  if (score == null) return 'unknown';
  if (score >= 0.8) return 'match';
  if (score >= 0.5) return 'partial';
  return 'mismatch';
}

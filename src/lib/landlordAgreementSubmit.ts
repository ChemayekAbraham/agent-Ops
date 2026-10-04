import { supabase } from '@/integrations/supabase/client';

/**
 * Single shared path for storing a signed landlord agreement.
 *
 * Uploads the signed file into the existing `landlord-agreements` bucket under
 * the landlord's folder, fingerprints it, and registers the version through the
 * existing `submit_landlord_agreement` RPC. Every caller (registration form,
 * landlord edit dialog, agreement history) goes through here so there is only
 * one upload/versioning implementation.
 */
export type LandlordAgreementDetails = Record<string, string | number | null | undefined>;

export const LANDLORD_AGREEMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png';
export const LANDLORD_AGREEMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Default 12-month term end date: one year from start, minus a day. */
export function twelveMonthEndDate(startDate: string): string {
  const date = new Date(`${startDate}T00:00:00`);
  date.setFullYear(date.getFullYear() + 1);
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function submitLandlordAgreementFile({
  landlordId,
  file,
  details,
  kind = 'original',
}: {
  landlordId: string;
  file: File;
  details: LandlordAgreementDetails;
  kind?: 'original' | 'addendum' | 'renewal';
}): Promise<void> {
  if (file.size > LANDLORD_AGREEMENT_MAX_BYTES) {
    throw new Error('The agreement must be 20 MB or smaller.');
  }

  const path = `${landlordId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const upload = await supabase.storage.from('landlord-agreements').upload(path, file, {
    upsert: false,
    contentType: file.type,
  });
  if (upload.error) throw upload.error;

  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');

  const { error } = await supabase.rpc('submit_landlord_agreement', {
    p_landlord_id: landlordId,
    p_kind: kind,
    p_file_path: path,
    p_file_name: file.name,
    p_file_sha256: sha256,
    p_file_mime_type: file.type,
    p_details: details as never,
  });
  if (error) throw error;
}

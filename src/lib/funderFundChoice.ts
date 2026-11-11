import { supabase } from '@/integrations/supabase/client';
import { isMissingDossierError } from '@/lib/funderVerifiedPlan';

export interface LandlordPayoutContact {
  landlordName: string;
  landlordPhone: string | null;
  payoutMomoNumber: string | null;
  payoutMomoName: string | null;
  location: string | null;
}

export type PayoutContactResult =
  | { state: 'ready'; contact: LandlordPayoutContact }
  | { state: 'hidden' }
  | { state: 'unavailable' }
  | { state: 'error' };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function supportWhatsAppUrl(input: { rentRequestId: string; title: string }): string {
  const text = [
    'I want to fund this Rent Plan through Welile.',
    `Plan: ${input.rentRequestId}`,
    `House: ${input.title}`,
  ].join('\n');
  return `https://wa.me/256777607640?text=${encodeURIComponent(text)}`;
}

export const SUPPORT_CALL_URL = 'tel:+256777607640';

export async function fetchLandlordPayoutContact(rentRequestId: string): Promise<PayoutContactResult> {
  const { data, error } = await supabase.rpc(
    'funder_verified_plan_payout_contact' as never,
    { p_rent_request_id: rentRequestId } as never,
  );
  if (error) {
    if (isMissingDossierError(error)) return { state: 'unavailable' };
    return { state: 'error' };
  }
  const row = (data ?? {}) as Record<string, unknown>;
  if (row.ok !== true) return { state: 'hidden' };
  const number = str(row.payout_momo_number);
  const phone = str(row.landlord_phone);
  if (!number && !phone) return { state: 'hidden' };
  return {
    state: 'ready',
    contact: {
      landlordName: str(row.landlord_name) || 'Landlord',
      landlordPhone: phone,
      payoutMomoNumber: number,
      payoutMomoName: str(row.payout_momo_name),
      location: str(row.location),
    },
  };
}

export interface OffplatformPaymentInput {
  rentRequestId: string;
  method: 'mobile_money' | 'cash';
  amount: number;
  provider?: 'mtn' | 'airtel' | null;
  reference?: string | null;
  paidAt?: string | null;
  receiptPhotoPath?: string | null;
}

export async function recordOffplatformRentPayment(input: OffplatformPaymentInput): Promise<{ ok: true } | { ok: false; missing: boolean }> {
  const { data, error } = await supabase.rpc(
    'funder_record_offplatform_rent_payment' as never,
    {
      p_rent_request_id: input.rentRequestId,
      p_method: input.method,
      p_amount: input.amount,
      p_provider: input.provider ?? null,
      p_reference: input.reference ?? null,
      p_paid_at: input.paidAt ?? null,
      p_receipt_photo_path: input.receiptPhotoPath ?? null,
    } as never,
  );
  if (error) return { ok: false, missing: isMissingDossierError(error) };
  const row = (data ?? {}) as { ok?: boolean };
  if (row.ok !== true) return { ok: false, missing: false };
  return { ok: true };
}

export async function uploadCashReceiptPhoto(rentRequestId: string, file: File): Promise<string | null> {
  // Only the current session's id is needed: read it locally (no /auth/v1/user call).
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess.session?.user?.id;
  if (!uid) return null;
  const path = `${uid}/${rentRequestId}-${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('funder-offplatform-receipts').upload(path, file, {
    contentType: file.type || 'image/jpeg',
    upsert: false,
  });
  if (error) return null;
  return path;
}

/**
 * Tenant self-request ("Request rent here" -> /tenants-onboarding): what the
 * form still needs before Submit unlocks, and the intake call made once the
 * request exists.
 *
 * The request is created by the tenant-self-onboarding edge function
 * (tenant_self_applied = true, status pending, so it routes to Agent Ops).
 * Then tenant_save_intake_details stores the intake that Agent Ops checks:
 * family size, work/business, the LC1 contact and the LC1 letter.
 */
import { supabase } from '@/integrations/supabase/client';
import { validateUgandaPhone } from '@/lib/ugandaPhone';

export const MIN_HOUSE_PHOTOS = 3;
export const MAX_HOUSE_PHOTOS = 4;
export const FAMILY_SIZE_MIN = 1;
export const FAMILY_SIZE_MAX = 30;
export const WORK_MIN_CHARS = 3;
export const NIN_MIN = 10;
export const NIN_MAX = 14;

export const cleanNin = (v: string) => v.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
const last9 = (v: string) => v.replace(/\D/g, '').slice(-9);
const validPhone = (v: string) => !!v.trim() && validateUgandaPhone(v).valid;

/** Same phone, whatever the format (+256…, 0…, spaces). */
export function samePhone(a: string, b: string): boolean {
  const x = last9(a);
  return x.length === 9 && x === last9(b);
}

export type TenantItemKey =
  | 'rent' | 'fullName' | 'phone' | 'nationalId' | 'passportPhoto' | 'familySize' | 'work'
  | 'address' | 'village' | 'gps' | 'housePhotos'
  | 'landlord' | 'landlordPhone' | 'lc1' | 'declared';

/** Which step of the form fixes each item. */
export const TENANT_ITEM_STEP: Record<TenantItemKey, number> = {
  rent: 2,
  fullName: 3, phone: 3, nationalId: 3, passportPhoto: 3, familySize: 3, work: 3,
  address: 4, village: 4, gps: 4, housePhotos: 4,
  landlord: 5, landlordPhone: 5, lc1: 5,
  declared: 6,
};

export const TENANT_ITEM_LABELS: Record<TenantItemKey, string> = {
  rent: 'Rent amount and how long you will take to pay it back',
  fullName: 'Your full name (first and last name)',
  phone: 'Your phone number',
  nationalId: 'Your National ID number, or a photo of your ID',
  passportPhoto: 'Your passport photo',
  familySize: 'How many people live in your household',
  work: 'Your work or business',
  address: 'Your house address',
  village: 'Your official village',
  gps: 'GPS pin taken at the house',
  housePhotos: 'At least 3 photos of the house',
  landlord: 'Your landlord’s name and phone',
  landlordPhone: 'Your landlord’s phone must be different from yours',
  lc1: 'The LC1 letter photo, or the LC1 chairperson’s name and phone',
  declared: 'Tick the box to confirm your details',
};

export interface TenantRequestInput {
  rentAmount: number;
  minRent: number;
  maxRent: number;
  /** The repayment period is one the edge function accepts. */
  durationOk: boolean;
  firstName: string;
  lastName: string;
  phone: string;
  nin: string;
  hasIdPhoto: boolean;
  hasPassportPhoto: boolean;
  familySize: string;
  work: string;
  address: string;
  hasVillage: boolean;
  hasGps: boolean;
  housePhotoCount: number;
  landlordName: string;
  landlordPhone: string;
  hasLcLetter: boolean;
  lc1Name: string;
  lc1Phone: string;
  declared: boolean;
}

export const ninValid = (nin: string) => {
  const c = cleanNin(nin);
  return c.length >= NIN_MIN && c.length <= NIN_MAX;
};

export function parseFamilySize(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= FAMILY_SIZE_MIN && n <= FAMILY_SIZE_MAX ? n : null;
}

/** Each item that is not in yet, in the order the form asks for them. */
export function tenantRequestMissing(i: TenantRequestInput): { key: TenantItemKey; label: string; step: number }[] {
  const ok: Record<TenantItemKey, boolean> = {
    rent: i.rentAmount >= i.minRent && i.rentAmount <= i.maxRent && i.durationOk,
    // Two names, each at least two letters (the edge function also needs two names).
    fullName: i.firstName.trim().length >= 2 && i.lastName.trim().length >= 2,
    phone: validPhone(i.phone),
    // A NIN that is typed must be a valid one; otherwise a photo of the ID will do.
    nationalId: cleanNin(i.nin) ? ninValid(i.nin) : i.hasIdPhoto,
    passportPhoto: i.hasPassportPhoto,
    familySize: parseFamilySize(i.familySize) !== null,
    work: i.work.trim().length >= WORK_MIN_CHARS,
    address: !!i.address.trim(),
    village: i.hasVillage,
    gps: i.hasGps,
    housePhotos: i.housePhotoCount >= MIN_HOUSE_PHOTOS,
    landlord: !!i.landlordName.trim() && validPhone(i.landlordPhone),
    landlordPhone: !validPhone(i.landlordPhone) || !validPhone(i.phone) || !samePhone(i.landlordPhone, i.phone),
    lc1: i.hasLcLetter || (!!i.lc1Name.trim() && validPhone(i.lc1Phone)),
    declared: i.declared,
  };
  return (Object.keys(TENANT_ITEM_STEP) as TenantItemKey[])
    .filter((k) => !ok[k])
    .map((k) => ({ key: k, label: TENANT_ITEM_LABELS[k], step: TENANT_ITEM_STEP[k] }));
}

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export interface TenantIntake {
  familySize: number | null;
  workBusiness: string;
  workLocation: string;
  /** "Name, phone" of the LC1 chairperson, when the tenant gave one. */
  lc1Contact: string | null;
  lcLetterBucket: string | null;
  lcLetterPath: string | null;
}

/** Stores the intake on the new request. Returns the server's error message as-is. */
export async function saveTenantIntake(requestId: string, d: TenantIntake): Promise<{ ok: boolean; message: string | null }> {
  try {
    const { error } = await rpc('tenant_save_intake_details', {
      p_request_id: requestId,
      p_family_size: d.familySize,
      p_work_business: d.workBusiness.trim() || null,
      p_work_location: d.workLocation.trim() || null,
      p_lc1_contact: d.lc1Contact?.trim() || null,
      p_lc_letter_bucket: d.lcLetterBucket,
      p_lc_letter_path: d.lcLetterPath,
    });
    if (error) return { ok: false, message: error.message || 'Your details were not saved.' };
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

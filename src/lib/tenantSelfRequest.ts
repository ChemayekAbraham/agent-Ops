/**
 * Tenant self-request ("Request rent here" -> /tenants-onboarding): what the
 * form still needs before Submit unlocks, and the intake call made once the
 * request exists.
 *
 * The request is created by the tenant-self-onboarding edge function
 * (tenant_self_applied = true, status pending, so it routes to Agent Ops).
 * Then tenant_save_intake_details stores the intake that Agent Ops checks:
 * family size, work/business, the LC1 contact and the LC1 letter.
 *
 * DOCS-1: photos of the National ID front and back and of the LC1 letter are
 * required. A typed NIN and the LC1 chairperson's contact are optional extras.
 *
 * The form follows the 8-step rent-request intake (intakeSteps.ts): each item
 * carries the step (1-8) that fixes it, and tenantIntakeState() turns the items
 * into the header's per-step "What's needed" lists.
 */
import { supabase } from '@/integrations/supabase/client';
import { validateUgandaPhone } from '@/lib/ugandaPhone';
import { INTAKE_STEPS, type IntakeItem, type IntakeState } from '@/lib/intakeSteps';

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
  | 'phone' | 'phoneTaken' | 'fullName'
  | 'rent'
  | 'landlord' | 'landlordPhone'
  | 'address' | 'village' | 'gps' | 'housePhotos'
  | 'familySize' | 'work'
  | 'passportPhoto'
  | 'nationalId' | 'ninTaken' | 'idFront' | 'idBack'
  | 'lcLetter' | 'declared';

/**
 * Which of the 8 intake steps fixes each item (1 Tenant, 2 Rent plan, 3 Landlord, 4 House,
 * 5 Household, 6 Tenant's photo, 7 ID, 8 LC1 letter + Post), in the order the form asks.
 */
export const TENANT_ITEM_STEP: Record<TenantItemKey, number> = {
  phone: 1, phoneTaken: 1, fullName: 1,
  rent: 2,
  landlord: 3, landlordPhone: 3,
  address: 4, village: 4, gps: 4, housePhotos: 4,
  familySize: 5, work: 5,
  passportPhoto: 6,
  nationalId: 7, ninTaken: 7, idFront: 7, idBack: 7,
  lcLetter: 8, declared: 8,
};

/** Rules rather than things to bring: listed only while they fail, never as a ticked line. */
const CONDITIONAL_ITEMS: ReadonlySet<TenantItemKey> = new Set<TenantItemKey>(['phoneTaken', 'landlordPhone', 'nationalId', 'ninTaken']);

export const TENANT_ITEM_LABELS: Record<TenantItemKey, string> = {
  phone: 'Your phone number',
  phoneTaken: 'This phone number already has a Welile account. Sign in with it',
  fullName: 'Your full name as on your National ID (first and last name)',
  rent: 'Rent amount and how long you will take to pay it back',
  landlord: 'Your landlord’s name and phone',
  landlordPhone: 'Your landlord’s phone must be different from yours',
  address: 'Your house address',
  village: 'Your official village',
  gps: 'GPS pin taken at the house',
  housePhotos: 'At least 3 photos of the house',
  familySize: 'How many people live in your household',
  work: 'Your work or business',
  passportPhoto: 'A clear photo of you',
  nationalId: 'Your National ID number must be 10 to 14 letters and numbers (or leave it empty)',
  ninTaken: 'This National ID is already registered to another account',
  idFront: 'A photo of the front of your National ID',
  idBack: 'A photo of the back of your National ID',
  lcLetter: 'A photo of the LC1 letter',
  declared: 'Tick the box to confirm your details',
};

export interface TenantRequestInput {
  rentAmount: number;
  /** E134: a minimum only; there is no rent ceiling. */
  minRent: number;
  /** The repayment period is one the edge function accepts. */
  durationOk: boolean;
  firstName: string;
  lastName: string;
  phone: string;
  /** Optional; checked only when typed. */
  nin: string;
  hasIdFront: boolean;
  hasIdBack: boolean;
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
  declared: boolean;
  /** The phone is already on another Welile account (identity check). */
  phoneTaken?: boolean;
  /** The typed NIN is already on another account (identity check). */
  ninTaken?: boolean;
}

export interface TenantItem { key: TenantItemKey; label: string; step: number }

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

function itemsOk(i: TenantRequestInput): Record<TenantItemKey, boolean> {
  return {
    rent: i.rentAmount >= i.minRent && i.durationOk,
    // Two names, each at least two letters (the edge function also needs two names).
    fullName: i.firstName.trim().length >= 2 && i.lastName.trim().length >= 2,
    phone: validPhone(i.phone),
    // The NIN is optional; a typed one must be valid.
    nationalId: !cleanNin(i.nin) || ninValid(i.nin),
    idFront: i.hasIdFront,
    idBack: i.hasIdBack,
    passportPhoto: i.hasPassportPhoto,
    familySize: parseFamilySize(i.familySize) !== null,
    work: i.work.trim().length >= WORK_MIN_CHARS,
    address: !!i.address.trim(),
    village: i.hasVillage,
    gps: i.hasGps,
    housePhotos: i.housePhotoCount >= MIN_HOUSE_PHOTOS,
    landlord: !!i.landlordName.trim() && validPhone(i.landlordPhone),
    landlordPhone: !validPhone(i.landlordPhone) || !validPhone(i.phone) || !samePhone(i.landlordPhone, i.phone),
    // DOCS-1: only the letter counts; the chairperson's contact is optional.
    lcLetter: i.hasLcLetter,
    declared: i.declared,
    phoneTaken: !i.phoneTaken,
    ninTaken: !(i.ninTaken && cleanNin(i.nin)),
  };
}

/** Each item that is not in yet, in the order the form asks for them. */
export function tenantRequestMissing(i: TenantRequestInput): TenantItem[] {
  const ok = itemsOk(i);
  return (Object.keys(TENANT_ITEM_STEP) as TenantItemKey[])
    .filter((k) => !ok[k])
    .map((k) => ({ key: k, label: TENANT_ITEM_LABELS[k], step: TENANT_ITEM_STEP[k] }));
}

/**
 * The intake header's state: each step's "What's needed" lines, ticked as they are done. A
 * rule (landlord's phone not yours, a typed NIN valid, phone or NIN not on another account)
 * shows only while it fails, so every step is done exactly when tenantRequestMissing() is empty.
 */
export function tenantIntakeState(i: TenantRequestInput): IntakeState {
  const ok = itemsOk(i);
  const state = Object.fromEntries(INTAKE_STEPS.map((s) => [s.key, [] as IntakeItem[]])) as IntakeState;
  for (const k of Object.keys(TENANT_ITEM_STEP) as TenantItemKey[]) {
    if (CONDITIONAL_ITEMS.has(k) && ok[k]) continue;
    state[INTAKE_STEPS[TENANT_ITEM_STEP[k] - 1].key].push({ label: TENANT_ITEM_LABELS[k], done: ok[k] });
  }
  return state;
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

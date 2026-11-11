/**
 * The T4 rent request form (RentRequestAssistant) is the only way an agent
 * posts, resubmits or renews a rent request.
 *
 * Every entry point (the agent menu, dashboard buttons, tenant shortcuts,
 * Edit/Resubmit on a rejected request, renewals, the intake queue, swap tenant)
 * calls openT4RentRequest(). One T4RentRequestHost, mounted once in App, shows
 * the form. The legacy `open-rent-request` window event still works.
 *
 * Submit stays off until t4Missing() is empty. Its 'gate' items are exactly the
 * live Agent Ops gate (_ao_gate_missing = _sc1_missing + _ao_items_missing +
 * photo review), in every mode: house photos (at least 3), landlord details,
 * rent amount, GPS, family size and work/business (not for renewals; work also
 * counts when profiles.occupation is set), the tenant's full name (2+ names),
 * no other open request for the tenant, and (DOCS-1, E75) photos of the
 * National ID front and back and of the LC1 letter. A typed NIN is optional and
 * an LC1 phone confirmation no longer counts. Its 'form' items are what this form itself needs to
 * send (consent, the resubmit note, the chat's other answers).
 * The database routes every new or resubmitted request to the Service Centre
 * (E58).
 */
import { useSyncExternalStore } from 'react';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

export type T4Mode = 'new' | 'resubmit' | 'renewal';

/** A listed house the form opens with (the listing "Swap tenant" flow). */
export interface T4PrefillHouse {
  id: string;
  title: string;
  address: string | null;
  region: string | null;
  district: string | null;
  house_category: string | null;
  monthly_rent: number | null;
  latitude: number | null;
  longitude: number | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  short_code?: string | null;
  image_urls?: string[] | null;
}

export interface T4Prefill {
  /** An existing tenant (the intake queue): checked for another open request. */
  tenantId?: string | null;
  tenantName?: string | null;
  tenantPhone?: string | null;
  rentAmount?: number | null;
  house?: T4PrefillHouse | null;
}

/** The completed Rent Plan being renewed (same tenant, same house). */
export interface T4Renewal {
  prevId: string;
  tenantId: string | null;
  tenantName: string;
  tenantPhone?: string | null;
  currentRent: number;
  currentDays: number;
  landlordName?: string | null;
  houseLabel?: string | null;
}

interface T4Base {
  /** Which entry point opened the form, for tests and logs. */
  entry?: string;
  /** Called with the request id once the Service Centre has it. */
  onDone?: (requestId: string) => void;
}

export type T4Request =
  | (T4Base & { mode: 'new'; prefill?: T4Prefill })
  | (T4Base & { mode: 'resubmit'; rejected: AgentRejectedRequest })
  | (T4Base & { mode: 'renewal'; renewal: T4Renewal });

export type T4OpenRequest = T4Request & { key: number };

// ----- open / close store -----
let current: T4OpenRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens the T4 form. With no argument it opens a new, empty request. */
export function openT4RentRequest(req: T4Request = { mode: 'new' }): void {
  seq += 1;
  current = { ...req, key: seq } as T4OpenRequest;
  emit();
}

export function closeT4RentRequest(): void {
  if (!current) return;
  current = null;
  emit();
}

export function getT4Request(): T4OpenRequest | null {
  return current;
}

export function subscribeT4Request(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The open T4 request, or null; re-renders when it opens or closes. */
export function useT4Request(): T4OpenRequest | null {
  return useSyncExternalStore(subscribeT4Request, getT4Request, getT4Request);
}

// ----- what is still missing -----
/** Statuses from service_center_review to coo_approved: a request still on its way. */
export const OPEN_REQUEST_STATUSES = [
  'service_center_review', 'pending', 'agent_ops_approved', 'agent_verified',
  'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved',
] as const;

/** Agent Ops approves 3 house photos and picks a main one, so fewer can never pass. */
export const MIN_HOUSE_PHOTOS = 3;

/** The tenant ID the gate accepts: any one of these on the profile. */
export interface TenantIdFields {
  national_id?: string | null;
  linked_national_id?: string | null;
  national_id_photo_path?: string | null;
  national_id_card_number?: string | null;
}
export function hasTenantId(p: TenantIdFields | null | undefined): boolean {
  if (!p) return false;
  return [p.national_id, p.linked_national_id, p.national_id_photo_path, p.national_id_card_number]
    .some((v) => !!String(v ?? '').trim());
}

/** The Agent Ops gate, in its own order. */
export const GATE_ITEMS = [
  'photos', 'landlord', 'rent', 'gps', 'familySize', 'work', 'lcLetter', 'tenantName', 'idFront', 'idBack', 'openRequest',
] as const;
/** What the form itself needs before it can send. */
export const FORM_ITEMS = [
  'plan', 'tenantPhone', 'house', 'tenantPhoto', 'lc1', 'payoutDay', 'consent', 'note', 'resubmitsLeft',
] as const;

export type T4GateItem = typeof GATE_ITEMS[number];
export type T4FormItem = typeof FORM_ITEMS[number];
export type T4ItemKey = T4GateItem | T4FormItem;

export const T4_ITEM_LABELS: Record<T4ItemKey, string> = {
  photos: 'At least 3 house photos',
  landlord: 'Landlord details',
  rent: 'Rent amount',
  gps: 'House GPS',
  familySize: 'Family size',
  work: 'Work / business',
  lcLetter: 'LC1 letter photo',
  tenantName: 'Tenant’s full name (2 or more names)',
  idFront: 'National ID photo — front',
  idBack: 'National ID photo — back',
  openRequest: 'No other open request for this tenant',
  plan: 'Rent Plan (how it is paid back)',
  tenantPhone: 'Tenant’s phone number',
  house: 'House type and address',
  tenantPhoto: 'Tenant’s passport photo',
  lc1: 'LC1 chairperson',
  payoutDay: 'Landlord payout day',
  consent: 'Guarantor consent',
  note: 'What you changed (at least 10 characters)',
  resubmitsLeft: 'Resubmits left (a manager must reopen it)',
};

const FORM_BY_MODE: Record<T4Mode, T4FormItem[]> = {
  new: ['plan', 'tenantPhone', 'house', 'tenantPhoto', 'lc1', 'payoutDay', 'consent'],
  resubmit: ['note', 'resubmitsLeft'],
  renewal: [],
};

/** SC-2 does not ask a renewal for family size or work / business again. */
const RENEWAL_SKIPS: T4ItemKey[] = ['familySize', 'work'];

export type T4Facts = Partial<Record<T4ItemKey, boolean>>;
export interface T4MissingItem { key: T4ItemKey; label: string; group: 'gate' | 'form' }

/**
 * What is still missing. An item is missing unless `facts[item]` is true.
 * 'gate' items are the Agent Ops gate (the same in every mode, minus family
 * size and work for a renewal); 'form' items are what this form needs to send.
 * `openRequestStatus` names the tenant's other open request, when there is one.
 */
export function t4Missing(
  mode: T4Mode,
  facts: T4Facts,
  registrationType?: string | null,
  openRequestStatus?: string | null,
): T4MissingItem[] {
  const renewal = mode === 'renewal' || registrationType === 'renewal';
  const gate = GATE_ITEMS
    .filter((k) => !(renewal && RENEWAL_SKIPS.includes(k)))
    .filter((k) => facts[k] !== true)
    .map((k): T4MissingItem => ({
      key: k,
      group: 'gate',
      label: k === 'openRequest' && openRequestStatus
        ? `This tenant already has an open request (status ${openRequestStatus})`
        : T4_ITEM_LABELS[k],
    }));
  const form = FORM_BY_MODE[mode]
    .filter((k) => facts[k] !== true)
    .map((k): T4MissingItem => ({ key: k, group: 'form', label: T4_ITEM_LABELS[k] }));
  return [...gate, ...form];
}

// ----- resubmit -----
export const RESUBMIT_NOTE_MIN_CHARS = 10;
export const RESUBMIT_DAYS_MIN = 7;
export const RESUBMIT_DAYS_MAX = 120;

export interface ResubmitValues {
  rentAmount: number;
  durationDays: number;
  preferredLanguage: string | null;
  noSmartphone: boolean | null;
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  houseCategory: string | null;
  tenantName: string;
  tenantPhone: string;
  nationalId: string;
}

const same = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim();
const digits = (s: string) => s.replace(/\D/g, '');

/**
 * The agent_resubmit_rent_request patch: only the fields the agent changed.
 * The server keeps every field left out and recalculates the fees.
 */
export function resubmitPatch(before: ResubmitValues, after: ResubmitValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.rentAmount !== before.rentAmount) patch.rent_amount = after.rentAmount;
  if (after.durationDays !== before.durationDays) patch.duration_days = after.durationDays;
  if (!same(after.preferredLanguage, before.preferredLanguage)) patch.preferred_language = after.preferredLanguage || null;
  if (after.noSmartphone !== before.noSmartphone && after.noSmartphone !== null) patch.tenant_no_smartphone = after.noSmartphone;
  if (after.landlordId !== before.landlordId) {
    patch.landlord_id = after.landlordId;
    patch.landlord_name = after.landlordName;
    patch.landlord_phone = after.landlordPhone;
  }
  if (!same(after.houseCategory, before.houseCategory)) patch.house_category = after.houseCategory || null;
  if (after.tenantName.trim() && !same(after.tenantName, before.tenantName)) patch.tenant_name = after.tenantName.trim();
  if (after.tenantPhone.trim() && digits(after.tenantPhone) !== digits(before.tenantPhone)) patch.tenant_phone = after.tenantPhone.trim();
  if (after.nationalId.trim() && !same(after.nationalId.toUpperCase(), before.nationalId.toUpperCase())) {
    patch.tenant_national_id = after.nationalId.trim().toUpperCase();
  }
  return patch;
}

/** The Rent Plan a rejected request already has, for the T4 form's review. */
export function rejectedToValues(
  r: AgentRejectedRequest,
  tenant: { name: string; phone: string; nationalId: string },
): ResubmitValues {
  return {
    rentAmount: Number(r.rent_amount) || 0,
    durationDays: Number(r.duration_days) || 0,
    preferredLanguage: r.preferred_language ?? null,
    noSmartphone: r.tenant_no_smartphone ?? null,
    landlordId: r.landlord_id,
    landlordName: r.landlord_name ?? '',
    landlordPhone: '',
    houseCategory: r.house_category ?? null,
    tenantName: tenant.name,
    tenantPhone: tenant.phone,
    nationalId: tenant.nationalId,
  };
}

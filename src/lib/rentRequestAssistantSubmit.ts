/**
 * Submit pipeline for the Rent Request Assistant (chat preview).
 *
 * This mirrors AgentRentRequestDialog.handleSubmit for the standard (daily /
 * weekly / monthly) flow, step for step and in the same order, so the
 * assistant posts exactly what the form posts. It deliberately does not touch
 * the form: while the assistant is a gated preview the two paths run side by
 * side. If a rule changes in the form's submit, change it here too.
 *
 * No ledger or wallet writes happen here — the rent_requests insert is the
 * same direct insert the form makes; money only moves later through RPCs.
 */
import { supabase } from '@/integrations/supabase/client';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { optimizeImage } from '@/lib/imageOptimizer';
import { archiveToDrive } from '@/lib/archiveToDrive';
import { publishAvatarUpdate } from '@/lib/avatarSync';
import { safeUUID } from '@/lib/safeUUID';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';
import { normalizeDistrict } from '@/lib/ugandaDistricts';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { attachLc1Letter, noteLc1Missing, saveIntakeDetails } from '@/lib/agentIntakeDetails';

export type AssistantIncomeType = 'daily' | 'weekly-monthly';
export type AssistantEarnerCycle = 'weekly' | 'monthly';

export interface AssistantFees {
  rentAmount: number;
  durationDays: number;
  accessFee: number;
  requestFee: number;
  totalRepayment: number;
  dailyRepayment: number;
}

/** Same pricing as the form's calculateFees() for the non-outstanding flows. */
export function computeAssistantFees(
  incomeType: AssistantIncomeType,
  amount: number,
  duration: '30' | '60' | '90',
  repaymentPeriod: string,
): AssistantFees | null {
  if (!amount) return null;
  if (incomeType === 'daily') {
    return calculateRentRepayment(amount, parseInt(duration, 10) as 30 | 60 | 90);
  }
  const DAILY_ACCESS_FEE_RATE = 0.011;
  const PLATFORM_FEE = 10000;
  const days = parseInt(repaymentPeriod, 10);
  const accessFee = Math.round(amount * DAILY_ACCESS_FEE_RATE * days);
  const totalRepayment = amount + accessFee + PLATFORM_FEE;
  return {
    rentAmount: amount,
    durationDays: days,
    accessFee,
    requestFee: PLATFORM_FEE,
    totalRepayment,
    dailyRepayment: Math.round(totalRepayment / days),
  };
}

/** Weekly earners repay (1 month rent + 33%) / 4 each week — the form's display rule. */
export function weeklyRepaymentFor(amount: number): number {
  return amount > 0 ? Math.ceil((amount * 1.33) / 4) : 0;
}

export interface AssistantHouse {
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
  image_urls: string[];
}

export interface AssistantSubmitInput {
  agentId: string;
  incomeType: AssistantIncomeType;
  earnerCycle: AssistantEarnerCycle;
  fees: AssistantFees;
  tenantName: string;
  tenantPhone: string;
  tenantNationalId: string;
  preferredLanguage: string;
  noSmartphone: boolean;
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  house: AssistantHouse | null;
  houseCategory: string;
  propertyCity: string;
  propertyDistrict: string;
  location: UgLocationSelection | null;
  gps: { lat: number; lng: number; accuracy: number } | null;
  housePhotos: File[];
  tenantPhoto: File;
  faceCheckSha256?: string | null;
  lc1Name: string;
  lc1Phone: string;
  lc1Village: string;
  lcLetter: File | null;
  landlordPayoutDay: string;
  /** Intake details, saved through agent_save_intake_details after the insert. */
  familySize: number;
  workBusiness: string;
  workLocation: string;
  /** "No LC1 letter yet" reason; sent through agent_note_lc1_missing when there is no letter. */
  noLc1Reason: string | null;
  /**
   * DOCS-1 (E75/E75b): the ID front, ID back and LC1 letter photos, already uploaded. They go in the
   * insert itself: with the docs rule on, the database refuses a rent request without them.
   */
  docs?: {
    idFront: { bucket: string; path: string };
    idBack: { bucket: string; path: string };
    lcLetter: { bucket: string; path: string };
  } | null;
}

export type AssistantSubmitResult =
  | {
      ok: true;
      rentRequestId: string;
      tenantExisting: boolean;
      activationLink: string | null;
      lcLetterFailed: boolean;
      /** Server error from agent_save_intake_details; the request itself was created. */
      intakeError: string | null;
      /** Server error from agent_attach_lc1_letter after the letter uploaded. */
      lc1AttachError: string | null;
      /** Server error from agent_note_lc1_missing. */
      lc1NoteError: string | null;
    }
  | {
      ok: false;
      /** Which conversation step the agent should go back to, if any. */
      backTo?: 'house' | 'landlord' | 'lc1Phone';
      reason: 'house_taken' | 'landlord_missing' | 'lc1' | 'tenant' | 'photo' | 'duplicate' | 'network' | 'session' | 'other';
      message: string;
      duplicateRequestId?: string | null;
      /** The raw error, for promptIfNotVetted / capacity humanising in the UI. */
      raw?: unknown;
    };

const clean = (s: string) => s.replace(/\s/g, '');

type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
/** For the RPCs missing from the generated types (same calls the form makes). */
const rpcUntyped: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);
/** Untyped insert/update payloads: columns the generated types don't list, as in the form. */
type Loose = never;

async function uploadTenantPhoto(agentId: string, file: File, tenantUserId: string): Promise<string | null> {
  try {
    const optimized = await optimizeImage(file, { maxWidth: 1200, quality: 0.85 });
    const ext = optimized.file.name.split('.').pop() || 'webp';
    const path = `${agentId}/${safeUUID()}/tenant_passport.${ext}`;
    const { error } = await supabase.storage
      .from('house-images')
      .upload(path, optimized.file, { cacheControl: '86400', upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from('house-images').getPublicUrl(path);
    archiveToDrive('house-images', path, 'tenant_id');
    try {
      const { data: updated } = await supabase
        .from('profiles')
        .update({ avatar_url: data.publicUrl })
        .eq('id', tenantUserId)
        .is('avatar_url', null)
        .select('id');
      if (updated?.length) publishAvatarUpdate(tenantUserId, data.publicUrl);
    } catch { /* non-fatal */ }
    return data.publicUrl;
  } catch (err) {
    console.warn('[rentRequestAssistant] tenant photo upload failed', err);
    return null;
  }
}

async function uploadHousePhotos(agentId: string, requestId: string, files: File[]): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < files.length; i++) {
    try {
      const optimized = await optimizeImage(files[i], { maxWidth: 1200, quality: 0.8 });
      const ext = optimized.file.name.split('.').pop() || 'webp';
      const path = `${agentId}/${requestId}/photo_${i}.${ext}`;
      const { error } = await supabase.storage
        .from('house-images')
        .upload(path, optimized.file, { cacheControl: '86400', upsert: false });
      if (error) throw error;
      urls.push(supabase.storage.from('house-images').getPublicUrl(path).data.publicUrl);
    } catch (err) {
      console.warn(`[rentRequestAssistant] house photo ${i} upload failed`, err);
    }
  }
  return urls;
}

/** Uploads the LC1 letter photo to `lc-letters/<agent>/<request>/lc_letter.<ext>`. */
export async function uploadLcLetter(agentId: string, requestId: string, file: File): Promise<{ path: string; bucket: string } | null> {
  let letterFile = file;
  try {
    letterFile = (await optimizeImage(file, { maxWidth: 2000, maxHeight: 2000, quality: 0.85, format: 'image/jpeg' })).file;
  } catch { /* keep the original */ }
  const ext = (letterFile.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${agentId}/${requestId}/lc_letter.${ext}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error } = await supabase.storage
        .from('lc-letters')
        .upload(path, letterFile, { cacheControl: '86400', upsert: true, contentType: letterFile.type });
      if (error) throw error;
      return { path, bucket: 'lc-letters' };
    } catch (err) {
      if (attempt === 1) console.warn('[rentRequestAssistant] LC letter upload failed', err);
    }
  }
  return null;
}

function landlordPayoutFields(dayText: string) {
  const day = Math.min(28, Math.max(1, parseInt(dayText, 10) || 1));
  const d = new Date();
  d.setUTCDate(1);
  if (new Date().getUTCDate() >= day) d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(day);
  d.setUTCHours(7, 0, 0, 0);
  return { landlord_payout_day: day, landlord_payout_next_run_at: d.toISOString(), landlord_payout_enabled: true };
}

export async function submitAssistantRentRequest(input: AssistantSubmitInput): Promise<AssistantSubmitResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, reason: 'network', message: 'No internet right now. Your answers are kept on this screen. Post again once you have a signal.' };
  }

  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) {
    const { error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) return { ok: false, reason: 'session', message: 'Your session expired. Please sign in again to post.' };
  }

  try {
    // Fresh availability read: two agents must never link the same house.
    if (input.house?.id) {
      const { data: freshHouse } = await supabase
        .from('house_listings')
        .select('id, status, tenant_id, reserved_at, is_hidden')
        .eq('id', input.house.id)
        .maybeSingle();
      const h = freshHouse as { status?: string; tenant_id?: string | null; reserved_at?: string | null; is_hidden?: boolean } | null;
      if (!h || h.tenant_id !== null || h.reserved_at !== null || h.is_hidden === true || h.status !== 'available') {
        return { ok: false, reason: 'house_taken', backTo: 'house', message: 'Another agent just reserved this house. Pick a different house and post again.' };
      }
    }

    const landlordId = input.house?.landlord_id || input.landlordId;
    if (!landlordId) {
      return { ok: false, reason: 'landlord_missing', backTo: 'landlord', message: 'Pick a registered landlord before posting.' };
    }

    // Landlord must exist (an unverified landlord is allowed: the request waits for Landlord Ops).
    try {
      const { data: verRows, error } = await rpcUntyped('get_landlord_verification_status', { p_id: landlordId });
      if (error) throw error;
      const row = (Array.isArray(verRows) ? verRows[0] : verRows) as { exists_flag?: boolean } | null | undefined;
      if (!row || row.exists_flag === false) {
        return { ok: false, reason: 'landlord_missing', backTo: 'landlord', message: 'This landlord is not registered in the system. Pick a registered landlord or register them first.' };
      }
    } catch {
      return { ok: false, reason: 'network', message: "Couldn't confirm the landlord is registered. Check your connection and try again." };
    }

    // LC1: reuse an existing record by normalised phone, else register an unverified one.
    const cleanLc1Phone = clean(input.lc1Phone);
    let lc1Id: string | null = null;
    let existingLc1: { id: string } | null = null;
    try {
      const { data, error } = await supabase.rpc('find_lc1_by_phone', { p_phone: cleanLc1Phone });
      if (error) throw error;
      existingLc1 = ((data ?? [])[0] as { id: string } | undefined) ?? null;
    } catch {
      return { ok: false, reason: 'network', message: "Couldn't look up the LC1 chairperson. Check your connection and try again." };
    }
    if (existingLc1) {
      lc1Id = existingLc1.id;
    } else {
      const unit = input.location;
      const sameVillage = unit && unit.village.trim().toLowerCase() === input.lc1Village.trim().toLowerCase();
      const { data: createdLc1, error: lc1InsertError } = await supabase
        .from('lc1_chairpersons')
        .insert({
          name: input.lc1Name.trim(),
          phone: cleanLc1Phone,
          village: input.lc1Village.trim(),
          registered_by: input.agentId,
          ...(sameVillage && unit
            ? {
                ug_village_id: unit.villageId,
                parish: unit.parish,
                sub_county: unit.subcounty,
                county: unit.county,
                district: normalizeDistrict(unit.district) || unit.district,
                region: unit.region,
                country: 'Uganda',
              }
            : {}),
        })
        .select('id')
        .maybeSingle();
      if (lc1InsertError) {
        if ((lc1InsertError as { code?: string }).code === '23505') {
          const { data: reLookup } = await supabase.rpc('find_lc1_by_phone', { p_phone: cleanLc1Phone });
          lc1Id = ((reLookup ?? [])[0] as { id: string } | undefined)?.id ?? null;
        }
        if (!lc1Id) {
          const raw = String((lc1InsertError as { message?: string }).message || '').replace(/^LC1_DUPLICATE:\s*/, '');
          return {
            ok: false,
            reason: 'lc1',
            backTo: 'lc1Phone',
            message: raw ? `Couldn't register the LC1 chairperson: ${raw}` : "Couldn't register the LC1 chairperson. Check the details and try again.",
          };
        }
      } else {
        lc1Id = createdLc1?.id ?? null;
      }
    }

    // Tenant account (new or existing) via the same edge function the form uses.
    const cleanTenantPhone = clean(input.tenantPhone);
    const { data: tenantResult, error: tenantRegError } = await supabase.functions.invoke('register-tenant', {
      body: {
        full_name: input.tenantName.trim(),
        phone: cleanTenantPhone,
        national_id: input.tenantNationalId.trim().toUpperCase() || null,
        telemetry: await collectAgentSignupTelemetry('/agent/rent-request#assistant', 'tenant'),
      },
    });
    if (tenantRegError || !tenantResult?.user_id) {
      let message = tenantResult?.error || 'Failed to register the tenant';
      try {
        const body = (tenantRegError as { context?: { body?: BodyInit } } | null)?.context?.body;
        if (body) message = JSON.parse(await new Response(body).text()).error || message;
      } catch { /* keep the default */ }
      return { ok: false, reason: 'tenant', message };
    }
    const tenantId: string = tenantResult.user_id;

    // Best-effort location on the tenant profile (Tenant Ops roll-ups).
    const profileLocation: Record<string, string> = {};
    if (input.propertyCity.trim()) profileLocation.city = input.propertyCity.trim();
    if (input.propertyDistrict.trim()) profileLocation.district = normalizeDistrict(input.propertyDistrict);
    if (input.lc1Village.trim()) profileLocation.village = input.lc1Village.trim();
    if (Object.keys(profileLocation).length > 0) {
      profileLocation.country = 'Uganda';
      try {
        await supabase.from('profiles').update(profileLocation).eq('id', tenantId);
      } catch (e) {
        console.warn('[rentRequestAssistant] tenant profile location update failed', e);
      }
    }

    // Last authoritative landlord gate right before the insert.
    try {
      const { data: isRegistered, error } = await supabase.rpc('verify_landlord_registered', { p_landlord_id: landlordId });
      if (error) throw error;
      if (!isRegistered) {
        return { ok: false, reason: 'landlord_missing', backTo: 'landlord', message: 'This landlord is not registered in the system. Pick a registered landlord or register them first.' };
      }
    } catch {
      return { ok: false, reason: 'network', message: "Couldn't confirm the landlord is registered. Check your connection and try again." };
    }

    // The tenant photo must be stored before the insert (enforce_rent_request_tenant_photo).
    const tenantPhotoUrl = await uploadTenantPhoto(input.agentId, input.tenantPhoto, tenantId);
    if (!tenantPhotoUrl) {
      return { ok: false, reason: 'photo', message: "Couldn't upload the tenant's passport photo. Check your connection and try again." };
    }

    const isWeeklyEarner = input.incomeType === 'weekly-monthly' && input.earnerCycle === 'weekly';
    const { fees } = input;
    const { data: rentReq, error: requestError } = await supabase
      .from('rent_requests')
      .insert({
        tenant_id: tenantId,
        agent_id: input.agentId,
        landlord_id: landlordId,
        lc1_id: lc1Id,
        rent_amount: fees.rentAmount,
        duration_days: fees.durationDays,
        access_fee: fees.accessFee,
        request_fee: fees.requestFee,
        total_repayment: fees.totalRepayment,
        daily_repayment: fees.dailyRepayment,
        repayment_frequency: isWeeklyEarner ? 'weekly' : 'daily',
        ...(isWeeklyEarner ? { repayment_starts_on: new Date().toISOString().slice(0, 10) } : {}),
        status: 'pending',
        house_category: input.houseCategory,
        preferred_language: input.preferredLanguage || null,
        tenant_no_smartphone: input.noSmartphone,
        request_latitude: input.gps?.lat ?? null,
        request_longitude: input.gps?.lng ?? null,
        agent_guarantor_consent: true,
        agent_guarantor_consent_at: new Date().toISOString(),
        agent_guarantor_consent_version: 'v1',
        tenant_photo_url: tenantPhotoUrl,
        ...(input.docs
          ? {
              nin_photo_path: input.docs.idFront.path, nin_photo_bucket: input.docs.idFront.bucket,
              nin_photo_back_path: input.docs.idBack.path, nin_photo_back_bucket: input.docs.idBack.bucket,
              lc_letter_path: input.docs.lcLetter.path, lc_letter_bucket: input.docs.lcLetter.bucket,
            }
          : {}),
        ...landlordPayoutFields(input.landlordPayoutDay),
      } as Loose)
      .select('id')
      .single();
    if (requestError) throw requestError;
    const requestId: string = rentReq.id;

    if (input.house?.id) {
      try {
        await supabase
          .from('house_listings')
          .update({ tenant_id: tenantId, status: 'occupied' } as Loose)
          .eq('id', input.house.id)
          .is('tenant_id', null);
        await supabase.from('rent_requests').update({ house_listing_id: input.house.id } as Loose).eq('id', requestId);
      } catch (e) {
        console.warn('[rentRequestAssistant] linking the house failed', e);
      }
    }

    const photoUrls = await uploadHousePhotos(input.agentId, requestId, input.housePhotos);
    if (photoUrls.length > 0) {
      await supabase.from('rent_requests').update({ house_image_urls: photoUrls }).eq('id', requestId);
    }

    let lcLetterFailed = false;
    let lc1AttachError: string | null = null;
    if (input.lcLetter) {
      const letter = await uploadLcLetter(input.agentId, requestId, input.lcLetter);
      if (letter) {
        await supabase
          .from('rent_requests')
          .update({ lc_letter_path: letter.path, lc_letter_bucket: letter.bucket } as Loose)
          .eq('id', requestId);
        const attached = await attachLc1Letter(requestId, letter.path);
        if (!attached.ok) lc1AttachError = attached.message;
      } else {
        lcLetterFailed = true;
      }
    }
    let lc1NoteError: string | null = null;
    if (!input.lcLetter && input.noLc1Reason?.trim()) {
      const noted = await noteLc1Missing(requestId, input.noLc1Reason);
      if (!noted.ok) lc1NoteError = noted.message;
    }

    // The request exists now: a failure here keeps it and is finished from the home card.
    const intake = await saveIntakeDetails(requestId, {
      familySize: input.familySize,
      workBusiness: input.workBusiness,
      workLocation: input.workLocation,
    });
    const intakeError = intake.ok ? null : intake.message;

    if (input.faceCheckSha256) {
      try {
        await (supabase.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<unknown>)(
          'link_identity_photo_fingerprint',
          { p_sha256: input.faceCheckSha256, p_rent_request_id: requestId, p_photo_url: tenantPhotoUrl },
        );
      } catch (e) {
        console.warn('[rentRequestAssistant] face fingerprint link failed', e);
      }
    }

    const activationLink = !tenantResult.existing && tenantResult.activation_token
      ? `${getPublicOrigin()}/join?t=${tenantResult.activation_token}`
      : null;

    // Sign-up invites (tenant if new, landlord if not yet a user). Fire-and-forget.
    try {
      const recipients: Array<{ role: 'tenant' | 'landlord'; full_name: string; phone: string; activation_token?: string }> = [];
      if (!tenantResult.existing && tenantResult.activation_token && cleanTenantPhone) {
        recipients.push({ role: 'tenant', full_name: input.tenantName.trim(), phone: cleanTenantPhone, activation_token: tenantResult.activation_token });
      }
      const llPhone = clean(input.landlordPhone || '');
      if (input.landlordName.trim() && llPhone) {
        recipients.push({ role: 'landlord', full_name: input.landlordName.trim(), phone: llPhone });
      }
      if (recipients.length > 0) {
        void supabase.functions
          .invoke('send-signup-invite-sms', { body: { origin: getPublicOrigin(), recipients } })
          .catch((e) => console.warn('[rentRequestAssistant] invite SMS failed (non-critical)', e));
      }
    } catch (e) {
      console.warn('[rentRequestAssistant] could not queue invite SMS', e);
    }

    return {
      ok: true,
      rentRequestId: requestId,
      tenantExisting: !!tenantResult.existing,
      activationLink,
      lcLetterFailed,
      intakeError,
      lc1AttachError,
      lc1NoteError,
    };
  } catch (caught) {
    const error = (caught ?? {}) as { message?: string; hint?: string; details?: string };
    const msg: string = error.message || 'Failed to post the rent request';
    const all = `${msg} ${error.hint ?? ''} ${error.details ?? ''}`;
    // DOCS-1: the database names the missing document photos; shown exactly as it says.
    if (/DOCS_MISSING/i.test(all)) return { ok: false, reason: 'other', message: msg, raw: error };
    if (/DUPLICATE_AFTER_REJECTION/i.test(all)) {
      const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      return {
        ok: false,
        reason: 'duplicate',
        message: 'This tenant already has a rejected rent request. Fix the flagged detail on that request and resubmit it from My rent requests.',
        duplicateRequestId: uuidRe.exec(error?.hint || '')?.[0] ?? uuidRe.exec(msg)?.[0] ?? null,
        raw: error,
      };
    }
    if (!navigator.onLine || /failed to fetch|network ?error|networkrequestfailed|load failed|err_internet|err_network|fetch failed/i.test(msg)) {
      return { ok: false, reason: 'network', message: "The connection dropped before we could send it. Your answers are kept here. Reconnect and tap Post again.", raw: error };
    }
    if (/registered landlord|landlord is not registered|not registered in the system|requires a registered landlord/i.test(msg)) {
      return { ok: false, reason: 'landlord_missing', backTo: 'landlord', message: 'This landlord is not registered in the system. Pick a registered landlord or register them first.', raw: error };
    }
    const lower = msg.toLowerCase();
    if (lower.includes('weekly_eligibility_blocked')) {
      return {
        ok: false,
        reason: 'other',
        message: msg.replace(/^.*WEEKLY_ELIGIBILITY_BLOCKED:\s*/i, '').trim()
          || 'Your collections last week were below the target. You cannot post a new rent request this week.',
        raw: error,
      };
    }
    if (lower.includes('100,000,000') || lower.includes('exposure cap')) {
      return { ok: false, reason: 'other', message: 'You have reached your UGX 100,000,000 active rent exposure cap. Collect on existing rent requests to free up headroom.', raw: error };
    }
    if (/row-level security|RLS/.test(msg)) {
      return { ok: false, reason: 'session', message: 'Permission denied: your session may have expired. Please sign out and sign in again.', raw: error };
    }
    return { ok: false, reason: 'other', message: msg, raw: error };
  }
}

/**
 * Resubmit and renewal for the T4 rent request form. A new request posts through
 * submitAssistantRentRequest (rentRequestAssistantSubmit.ts).
 *
 * - Resubmit: the same server call the old Edit/Resubmit dialog made
 *   (agent_resubmit_rent_request with a patch of what changed), then the T4
 *   intake (agent_save_intake_details, agent_note_lc1_missing).
 * - Renewal: the same audited renew_rent_request the tenant screens call (after
 *   the agent's rent/days choice and the tenant's code), then the LC1 letter or
 *   reason on the new request.
 *
 * The database sends every new or resubmitted request to the Service Centre
 * (E58). No ledger or wallet writes happen here.
 */
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';
import { captureGps, isGpsRequiredError } from '@/lib/captureGps';
import { renewRpcArgs, type RenewalChoice } from '@/lib/renewalAdvice';
import { attachLc1Letter, noteLc1Missing, saveIntakeDetails } from '@/lib/agentIntakeDetails';
import { uploadLcLetter } from '@/lib/rentRequestAssistantSubmit';
import { safeUUID } from '@/lib/safeUUID';
import { OPEN_REQUEST_STATUSES, type TenantIdFields } from '@/lib/t4RentRequest';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const untypedFrom = (table: string): any => (supabase.from as unknown as (t: string) => unknown).call(supabase, table);

const errorText = (e: unknown): string => {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message ?? '');
  return String(e ?? '');
};

/** A house photo slot: a new photo to upload, a URL already on file, or empty. */
export type PhotoSlot = File | string | null;

/**
 * Uploads replaced house photos and a new LC letter. Returns the patch
 * fragment (house_image_urls, lc_letter_path, lc_letter_bucket). Unique paths,
 * as the old dialog used: overwriting an object is a storage UPDATE, which a
 * missing policy would refuse silently.
 */
export async function uploadResubmitEvidence(
  agentId: string,
  requestId: string,
  photos: PhotoSlot[],
  extraUrls: string[],
  lcLetter: File | null,
): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (photos.some((p) => p instanceof File)) {
    const urls: string[] = [];
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (typeof p === 'string') { urls.push(p); continue; }
      if (!p) continue;
      let file = p;
      try { file = (await optimizeImage(p, { maxWidth: 1200, quality: 0.8 })).file; } catch { /* keep the original */ }
      const ext = file.name.split('.').pop() || 'webp';
      const path = `${agentId}/${requestId}/photo_${i}_${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('house-images').upload(path, file, { cacheControl: '86400', upsert: false });
      if (error) throw new Error(`House photo ${i + 1} did not upload: ${error.message}`);
      urls.push(supabase.storage.from('house-images').getPublicUrl(path).data.publicUrl);
    }
    // A full new set drops the old extras so reviewers never see a mix.
    const allNew = photos.every((p) => p instanceof File);
    patch.house_image_urls = [...urls, ...(allNew ? [] : extraUrls)];
  }
  if (lcLetter) {
    let file = lcLetter;
    try { file = (await optimizeImage(lcLetter, { maxWidth: 2000, maxHeight: 2000, quality: 0.85, format: 'image/jpeg' })).file; } catch { /* keep the original */ }
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `${agentId}/${requestId}/lc_letter_${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from('lc-letters').upload(path, file, { cacheControl: '86400', upsert: false, contentType: file.type });
    if (error) throw new Error(`The LC letter did not upload: ${error.message}`);
    patch.lc_letter_path = path;
    patch.lc_letter_bucket = 'lc-letters';
  }
  return patch;
}

export interface T4IntakeOutcome {
  /** Server error from agent_save_intake_details, as-is. */
  intakeError: string | null;
  /** Server error from agent_note_lc1_missing, as-is. */
  lc1NoteError: string | null;
  /** Server error from agent_attach_lc1_letter, as-is. */
  lc1AttachError: string | null;
  /** The LC letter photo did not reach storage. */
  lcLetterFailed: boolean;
}

export interface ResubmitInput {
  agentId: string;
  requestId: string;
  /** Only the fields that changed (resubmitPatch). */
  patch: Record<string, unknown>;
  note: string;
  photos: PhotoSlot[];
  extraPhotoUrls: string[];
  lcLetter: File | null;
  /** "No LC1 letter yet" reason, when there is no letter on file or new. */
  noLc1Reason: string | null;
  /** Family size and work: saved unless the request is a renewal (SC-2 skips them). */
  details: { familySize: number | null; workBusiness: string | null; workLocation: string | null } | null;
}

export type ResubmitResult = ({ ok: true; requestId: string } & T4IntakeOutcome) | { ok: false; message: string };

/** Resubmits a rejected request from the T4 form. Server errors are returned as-is. */
export async function resubmitT4Request(input: ResubmitInput): Promise<ResubmitResult> {
  let evidence: Record<string, unknown>;
  try {
    evidence = await uploadResubmitEvidence(input.agentId, input.requestId, input.photos, input.extraPhotoUrls, input.lcLetter);
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
  try {
    const { error } = await rpc('agent_resubmit_rent_request', {
      p_request_id: input.requestId,
      p_patch: { ...input.patch, ...evidence },
      p_agent_note: input.note.trim(),
    });
    if (error) return { ok: false, message: errorText(error) || 'The request was not resubmitted.' };
  } catch (e) {
    return { ok: false, message: errorText(e) || 'The request was not resubmitted.' };
  }
  const out: T4IntakeOutcome = { intakeError: null, lc1NoteError: null, lc1AttachError: null, lcLetterFailed: false };
  if (!input.lcLetter && input.noLc1Reason?.trim()) {
    const noted = await noteLc1Missing(input.requestId, input.noLc1Reason);
    if (!noted.ok) out.lc1NoteError = noted.message;
  }
  if (input.details) {
    const saved = await saveIntakeDetails(input.requestId, input.details);
    if (!saved.ok) out.intakeError = saved.message;
  }
  return { ok: true, requestId: input.requestId, ...out };
}

const RENEWAL_TIMEOUT_MS = 25000;

/**
 * Posts a renewal with renew_rent_request, as the tenant screens do: 25 s
 * timeout, and one retry with GPS captured at the house when the server asks for it.
 * Resolves with the new request id.
 */
export async function postRenewal(
  prevId: string,
  choice: RenewalChoice,
  onCapturingGps?: () => void,
  /** GPS the agent captured in the form, when the plan had none on file. */
  gpsNow?: { latitude: number; longitude: number } | null,
): Promise<string> {
  const call = (gps?: { latitude: number; longitude: number }) => Promise.race([
    rpc('renew_rent_request', renewRpcArgs(prevId, choice, gps)),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error('The renewal timed out. Check your connection and try again; the plan may still have been posted.')),
      RENEWAL_TIMEOUT_MS,
    )),
  ]);
  let { data, error } = await call(gpsNow ?? undefined);
  if (error && isGpsRequiredError(error.message)) {
    onCapturingGps?.();
    const gps = await captureGps();
    ({ data, error } = await call(gps));
  }
  if (error) throw new Error(errorText(error));
  if (typeof data !== 'string' || !data) throw new Error('The renewal was not posted. Please try again.');
  return data;
}

/**
 * Saves the tenant's full name and/or NIN on their profile: the same direct
 * update EditTenantDialog makes, for these fields only. RLS may withhold the
 * returned row on a successful update, so it re-reads the row before reporting a failure.
 */
export async function saveTenantProfile(
  tenantId: string,
  fields: { fullName?: string | null; nationalId?: string | null },
): Promise<{ ok: boolean; message: string | null }> {
  const payload: Record<string, string> = {};
  if (fields.fullName?.trim()) payload.full_name = fields.fullName.trim().replace(/\s+/g, ' ');
  if (fields.nationalId?.trim()) payload.national_id = fields.nationalId.trim().toUpperCase();
  if (!Object.keys(payload).length) return { ok: true, message: null };
  try {
    const { data, error } = await supabase.from('profiles').update(payload).eq('id', tenantId).select('id');
    if (error) return { ok: false, message: errorText(error) };
    if (data && data.length > 0) return { ok: true, message: null };
    const { data: row } = await supabase.from('profiles').select('full_name, national_id').eq('id', tenantId).maybeSingle();
    const landed = Object.entries(payload).every(([k, v]) => (row as Record<string, unknown> | null)?.[k] === v);
    if (landed) return { ok: true, message: null };
    return { ok: false, message: 'Your account cannot change this tenant’s record. Ask a manager to fix it in Tenants.' };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
}

/** New house photos for a renewal go on the new request, kept beside the ones already on file. */
export async function attachRenewalPhotos(agentId: string, requestId: string, photos: PhotoSlot[]): Promise<string | null> {
  if (!photos.some((p) => p instanceof File)) return null;
  try {
    const patch = await uploadResubmitEvidence(agentId, requestId, photos, [], null);
    const { error } = await supabase.from('rent_requests').update({ house_image_urls: patch.house_image_urls as string[] }).eq('id', requestId);
    return error ? errorText(error) : null;
  } catch (e) {
    return errorText(e);
  }
}

// ----- what is already on file -----
export interface TenantRecord extends TenantIdFields {
  full_name: string | null;
  phone: string | null;
  occupation: string | null;
}

/** The tenant's profile fields the gate reads (name, the four ID fields, occupation). */
export async function loadTenantRecord(tenantId: string): Promise<TenantRecord | null> {
  try {
    const { data } = await supabase
      .from('profiles')
      .select('full_name, phone, occupation, national_id, linked_national_id, national_id_photo_path, national_id_card_number')
      .eq('id', tenantId)
      .maybeSingle();
    return (data as TenantRecord | null) ?? null;
  } catch {
    return null;
  }
}

export interface RequestOnFile {
  tenantId: string | null;
  landlordId: string | null;
  rentAmount: number;
  photos: string[];
  gps: { lat: number; lng: number } | null;
  lcLetter: boolean;
  lc1PhoneConfirmed: boolean;
  /** DOCS-1 documents already stored on the request. */
  docs: Partial<Record<DocKind, StoredDoc>>;
  familySize: number | null;
  workBusiness: string | null;
  workLocation: string | null;
}

/** A request's evidence and intake: what a resubmit or a renewal already has. */
export async function loadRequestOnFile(requestId: string): Promise<RequestOnFile | null> {
  try {
    const [req, intake] = await Promise.all([
      // Untyped: nin_photo_back_* (E75) is not in the generated types yet.
      untypedFrom('rent_requests')
        .select('tenant_id, landlord_id, rent_amount, house_image_urls, request_latitude, request_longitude, lc_letter_path, lc_letter_bucket, nin_photo_path, nin_photo_bucket, nin_photo_back_path, nin_photo_back_bucket')
        .eq('id', requestId).maybeSingle(),
      supabase.from('pipeline_intake_details')
        .select('family_size, work_business, work_location, lc1_phone_confirmation')
        .eq('rent_request_id', requestId).maybeSingle(),
    ]);
    const r = req.data as {
      tenant_id?: string | null; landlord_id?: string | null; rent_amount?: number | null; house_image_urls?: unknown;
      request_latitude?: number | null; request_longitude?: number | null; lc_letter_path?: string | null;
      lc_letter_bucket?: string | null; nin_photo_path?: string | null; nin_photo_bucket?: string | null;
      nin_photo_back_path?: string | null; nin_photo_back_bucket?: string | null;
    } | null;
    if (!r) return null;
    const i = intake.data as { family_size?: number | null; work_business?: string | null; work_location?: string | null; lc1_phone_confirmation?: string | null } | null;
    return {
      tenantId: r.tenant_id ?? null,
      landlordId: r.landlord_id ?? null,
      rentAmount: Number(r.rent_amount) || 0,
      photos: Array.isArray(r.house_image_urls) ? (r.house_image_urls as unknown[]).filter((u): u is string => typeof u === 'string' && !!u) : [],
      gps: r.request_latitude != null && r.request_longitude != null ? { lat: Number(r.request_latitude), lng: Number(r.request_longitude) } : null,
      lcLetter: !!r.lc_letter_path?.trim(),
      lc1PhoneConfirmed: !!i?.lc1_phone_confirmation?.trim(),
      docs: {
        ...(r.nin_photo_path?.trim() ? { id_front: { bucket: r.nin_photo_bucket || 'tenant-ids', path: r.nin_photo_path } } : {}),
        ...(r.nin_photo_back_path?.trim() ? { id_back: { bucket: r.nin_photo_back_bucket || 'tenant-ids', path: r.nin_photo_back_path } } : {}),
        ...(r.lc_letter_path?.trim() ? { lc1_letter: { bucket: r.lc_letter_bucket || 'lc-letters', path: r.lc_letter_path } } : {}),
      },
      familySize: i?.family_size ?? null,
      workBusiness: i?.work_business ?? null,
      workLocation: i?.work_location ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The tenant's other open request (service_center_review to coo_approved), as
 * far as this agent can see it. Returns its status, or null when there is none.
 */
export async function findOpenRequest(tenantId: string, exceptRequestId?: string | null): Promise<string | null> {
  let q = supabase.from('rent_requests').select('id, status').eq('tenant_id', tenantId).in('status', [...OPEN_REQUEST_STATUSES]);
  if (exceptRequestId) q = q.neq('id', exceptRequestId);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(errorText(error));
  const row = (data as { status?: string | null }[] | null)?.[0];
  return row?.status ?? null;
}

/** After a renewal: the LC1 letter (uploaded and attached) or the "no letter yet" reason. */
export async function finishRenewalIntake(
  agentId: string,
  requestId: string,
  lcLetter: File | null,
  noLc1Reason: string | null,
): Promise<T4IntakeOutcome> {
  const out: T4IntakeOutcome = { intakeError: null, lc1NoteError: null, lc1AttachError: null, lcLetterFailed: false };
  if (lcLetter) {
    const up = await uploadLcLetter(agentId, requestId, lcLetter);
    if (!up) out.lcLetterFailed = true;
    else {
      const attached = await attachLc1Letter(requestId, up.path);
      if (!attached.ok) out.lc1AttachError = attached.message;
    }
  } else if (noLc1Reason?.trim()) {
    const noted = await noteLc1Missing(requestId, noLc1Reason);
    if (!noted.ok) out.lc1NoteError = noted.message;
  }
  return out;
}

// ----- DOCS-1 (E75): ID front, ID back and LC1 letter on every request -----
export type DocKind = 'id_front' | 'id_back' | 'lc1_letter';
export interface StoredDoc { bucket: string; path: string }
/** A document to attach: a new photo to upload, or one already stored. */
export type DocSource = File | StoredDoc | null | undefined;

export const DOC_KINDS: DocKind[] = ['id_front', 'id_back', 'lc1_letter'];
const DOC_BUCKET: Record<DocKind, string> = { id_front: 'tenant-ids', id_back: 'tenant-ids', lc1_letter: 'lc-letters' };
const DOC_FILE: Record<DocKind, string> = { id_front: 'national_id', id_back: 'national_id_back', lc1_letter: 'lc_letter' };
export const DOC_LABEL: Record<DocKind, string> = {
  id_front: 'National ID front photo',
  id_back: 'National ID back photo',
  lc1_letter: 'LC1 letter photo',
};

/** Stores a new document photo under the agent and request. Throws the storage error. */
export async function uploadDocument(agentId: string, requestId: string, kind: DocKind, file: File): Promise<StoredDoc> {
  let upload = file;
  try {
    upload = (await optimizeImage(file, { maxWidth: 2000, maxHeight: 2000, quality: 0.85, format: 'image/jpeg' })).file;
  } catch { /* keep the original */ }
  const ext = (upload.name.split('.').pop() || 'jpg').toLowerCase();
  const bucket = DOC_BUCKET[kind];
  const path = `${agentId}/${requestId}/${DOC_FILE[kind]}_${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, upload, { cacheControl: '86400', upsert: false, contentType: upload.type });
  if (error) throw new Error(error.message);
  return { bucket, path };
}

/** Links a stored document to the request (request_attach_document). Returns the server's error, or null. */
export async function attachDocument(requestId: string, kind: DocKind, doc: StoredDoc): Promise<string | null> {
  try {
    const { error } = await rpc('request_attach_document', {
      p_request_id: requestId, p_kind: kind, p_bucket: doc.bucket, p_path: doc.path,
    });
    return error ? errorText(error) || 'The document was not attached.' : null;
  } catch (e) {
    return errorText(e);
  }
}

/**
 * Uploads any new photos and attaches each document to the request. Returns the
 * problems, each with the server's own message.
 */
export async function attachT4Documents(
  agentId: string,
  requestId: string,
  docs: Partial<Record<DocKind, DocSource>>,
): Promise<string[]> {
  const problems: string[] = [];
  for (const kind of DOC_KINDS) {
    const src = docs[kind];
    if (!src) continue;
    try {
      const stored = src instanceof File ? await uploadDocument(agentId, requestId, kind, src) : src;
      const e = await attachDocument(requestId, kind, stored);
      if (e) problems.push(`${DOC_LABEL[kind]}: ${e}`);
    } catch (e) {
      problems.push(`${DOC_LABEL[kind]}: ${errorText(e)}`);
    }
  }
  return problems;
}

/**
 * A NEW request (new, swap tenant): uploads the three photos BEFORE the insert, under a fresh folder
 * (the request id does not exist yet). With the DOCS-1 rule on, the database refuses the insert
 * without them. Throws the storage error, naming the photo.
 */
export async function uploadNewRequestDocs(
  agentId: string,
  files: { idFront: File; idBack: File; lcLetter: File },
): Promise<{ idFront: StoredDoc; idBack: StoredDoc; lcLetter: StoredDoc }> {
  const folder = `new-${safeUUID()}`;
  const one = async (kind: DocKind, file: File) => {
    try {
      return await uploadDocument(agentId, folder, kind, file);
    } catch (e) {
      throw new Error(`${DOC_LABEL[kind]}: ${errorText(e)}`);
    }
  };
  return {
    idFront: await one('id_front', files.idFront),
    idBack: await one('id_back', files.idBack),
    lcLetter: await one('lc1_letter', files.lcLetter),
  };
}

/** The tenant profile's ID back photo (E75b column, not in the generated types yet). Null when none or unknown. */
export async function loadProfileIdBack(tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await untypedFrom('profiles').select('national_id_photo_back_path').eq('id', tenantId).maybeSingle();
    if (error) return null;
    const path = (data as { national_id_photo_back_path?: string | null } | null)?.national_id_photo_back_path;
    return path?.trim() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Renewal: a new ID back photo goes on the tenant's profile (profiles.national_id_photo_back_path)
 * BEFORE renew_rent_request, which takes the ID photos from the profile or earlier requests.
 * Returns the server's error, or null.
 */
export async function saveProfileIdBack(agentId: string, tenantId: string, file: File): Promise<string | null> {
  let stored: StoredDoc;
  try {
    stored = await uploadDocument(agentId, `profile-${tenantId}`, 'id_back', file);
  } catch (e) {
    return `${DOC_LABEL.id_back}: ${errorText(e)}`;
  }
  try {
    const { data, error } = await untypedFrom('profiles')
      .update({ national_id_photo_back_path: stored.path })
      .eq('id', tenantId)
      .select('id');
    if (error) return `${DOC_LABEL.id_back}: ${errorText(error)}`;
    if (!data || (data as unknown[]).length === 0) {
      return `${DOC_LABEL.id_back}: your account cannot update this tenant's profile. Ask a manager.`;
    }
    return null;
  } catch (e) {
    return `${DOC_LABEL.id_back}: ${errorText(e)}`;
  }
}

/** Profile ID photos taken in the identity flow live in this bucket. */
const IDENTITY_BUCKET = 'identity-verification';

const asRows = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? (data as Record<string, unknown>[]) : data ? [data as Record<string, unknown>] : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The tenant's DOCS-1 documents already on file, which the database carries over to a renewal or keeps
 * on a resubmit: the newest of each from their earlier requests, then the profile's ID photos
 * (national_id_photo_path / national_id_back_photo_path, and national_id_photo_back_path from E75b).
 * Anything that cannot be read counts as not on file.
 */
export async function loadTenantDocsOnFile(tenantId: string): Promise<Partial<Record<DocKind, StoredDoc>>> {
  const out: Partial<Record<DocKind, StoredDoc>> = {};
  try {
    const { data } = await untypedFrom('rent_requests')
      .select('nin_photo_path, nin_photo_bucket, nin_photo_back_path, nin_photo_back_bucket, lc_letter_path, lc_letter_bucket, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(20);
    for (const r of asRows(data)) {
      const front = str(r.nin_photo_path);
      const back = str(r.nin_photo_back_path);
      const letter = str(r.lc_letter_path);
      if (!out.id_front && front) out.id_front = { bucket: str(r.nin_photo_bucket) ?? 'tenant-ids', path: front };
      if (!out.id_back && back) out.id_back = { bucket: str(r.nin_photo_back_bucket) ?? 'tenant-ids', path: back };
      if (!out.lc1_letter && letter) out.lc1_letter = { bucket: str(r.lc_letter_bucket) ?? 'lc-letters', path: letter };
    }
  } catch { /* not readable: not on file */ }
  try {
    const { data } = await untypedFrom('profiles')
      .select('national_id_photo_path, national_id_back_photo_path').eq('id', tenantId).maybeSingle();
    const p = (data ?? {}) as Record<string, unknown>;
    const front = str(p.national_id_photo_path);
    const back = str(p.national_id_back_photo_path);
    if (!out.id_front && front) out.id_front = { bucket: IDENTITY_BUCKET, path: front };
    if (!out.id_back && back) out.id_back = { bucket: IDENTITY_BUCKET, path: back };
  } catch { /* not readable */ }
  if (!out.id_back) {
    const back = await loadProfileIdBack(tenantId);
    if (back) out.id_back = { bucket: 'tenant-ids', path: back };
  }
  return out;
}

/** A short-lived link for a small preview of a stored document, or null when it cannot be shown. */
export async function docPreviewUrl(doc: StoredDoc): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(doc.bucket).createSignedUrl(doc.path, 600);
    return error ? null : data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

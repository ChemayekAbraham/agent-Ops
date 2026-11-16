/**
 * Save and finish later (E109) for the agent "Post a rent request" chat.
 *
 * posting_draft_save keeps what the agent entered (photos as storage PATHS, never base64,
 * the whole payload under 200 KB) with the item codes still missing; posting_drafts_mine
 * lists them; posting_draft_close discards one, or marks it posted after the real post.
 *
 * Until those RPCs exist on the database (PGRST202 / function not found), the button and
 * the Saved list are hidden without a word.
 */
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';
import { safeUUID } from '@/lib/safeUUID';
import type { FunnelItem } from '@/lib/formFunnel';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
const rpc: UntypedRpc = (fn, args) => (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export const MAX_DRAFT_BYTES = 200 * 1024;
export const DRAFT_SAVED_MESSAGE = "Saved. We'll remind you tomorrow at 8am.";

export interface DraftPhoto { bucket: string; path: string }
export type DraftPhotoKind = 'house' | 'tenant_photo' | 'id_front' | 'id_back' | 'lc1_letter';

/** What the chat entered so far. Photos are storage paths. */
export interface PostingDraftPayload {
  v: 1;
  fields: Record<string, unknown>;
  photos: {
    house: (DraftPhoto | null)[];
    tenantPhoto: DraftPhoto | null;
    idFront: DraftPhoto | null;
    idBack: DraftPhoto | null;
    lcLetter: DraftPhoto | null;
  };
}

export interface PostingDraftRow {
  id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  /** What is missing, in words, as the server wrote it. */
  missing: string | null;
  expires_at: string | null;
  payload: PostingDraftPayload | null;
}

/** The draft RPCs are not on this database yet. */
export function isRpcMissing(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === 'PGRST202'
    || /could not find the function|function .* does not exist|schema cache/i.test(error.message || '');
}

/** null until known; false once a draft RPC answered "not found". Shared by the chat and the list. */
let available: boolean | null = null;
const listeners = new Set<() => void>();
export const draftsAvailable = () => available;
export function markDraftsAvailable(v: boolean) {
  if (available === v) return;
  available = v;
  listeners.forEach((l) => l());
}
export function onDraftsAvailability(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
/** Tests only. */
export function resetDraftsAvailability() { available = null; }

export const payloadBytes = (p: unknown): number => new Blob([JSON.stringify(p ?? null)]).size;

/**
 * Keeps the payload under MAX_DRAFT_BYTES: drops the picked house's photo list, then any
 * long text, before giving up. Photos are already paths, so this is a safety net.
 */
export function fitDraftPayload(p: PostingDraftPayload): PostingDraftPayload {
  if (payloadBytes(p) <= MAX_DRAFT_BYTES) return p;
  const fields = { ...p.fields };
  const house = fields.house as Record<string, unknown> | null | undefined;
  if (house && typeof house === 'object') fields.house = { ...house, image_urls: [] };
  let out: PostingDraftPayload = { ...p, fields };
  if (payloadBytes(out) <= MAX_DRAFT_BYTES) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.length > 500) fields[k] = v.slice(0, 500);
  }
  out = { ...p, fields };
  if (payloadBytes(out) <= MAX_DRAFT_BYTES) return out;
  // Last resort: keep the photos and the tenant's name and phone only.
  return { ...p, fields: { tenantNameParts: fields.tenantNameParts, tenantPhone: fields.tenantPhone, rentText: fields.rentText } };
}

const BUCKET: Record<DraftPhotoKind, string> = {
  house: 'house-images', tenant_photo: 'house-images', id_front: 'tenant-ids', id_back: 'tenant-ids', lc1_letter: 'lc-letters',
};

/** Stores one photo for a draft under the agent's own folder and returns its path. Throws the storage error. */
export async function uploadDraftPhoto(agentId: string, folder: string, kind: DraftPhotoKind, file: File, index = 0): Promise<DraftPhoto> {
  let upload = file;
  try {
    upload = (await optimizeImage(file, { maxWidth: kind === 'house' || kind === 'tenant_photo' ? 1200 : 2000, quality: 0.85, format: 'image/jpeg' })).file;
  } catch { /* keep the original */ }
  const bucket = BUCKET[kind];
  const path = `${agentId}/${folder}/${kind}_${index}_${Date.now()}.jpg`;
  const { error } = await supabase.storage.from(bucket).upload(path, upload, { cacheControl: '86400', upsert: false, contentType: upload.type || 'image/jpeg' });
  if (error) throw new Error(error.message);
  return { bucket, path };
}

/** A saved photo back as a File, for the post. null when it can't be read. */
export async function downloadDraftPhoto(p: DraftPhoto | null | undefined, name: string): Promise<File | null> {
  if (!p?.bucket || !p?.path) return null;
  try {
    const { data, error } = await supabase.storage.from(p.bucket).download(p.path);
    if (error || !data) return null;
    return new File([data], name, { type: data.type || 'image/jpeg' });
  } catch {
    return null;
  }
}

export const newDraftFolder = () => `draft-${safeUUID()}`;

export type DraftSaveResult = { ok: true; id: string } | { ok: false; missingRpc: boolean; message: string };

export async function saveDraft(input: {
  payload: PostingDraftPayload;
  missing: FunnelItem[];
  tenantName: string | null;
  tenantPhone: string | null;
  draftId: string | null;
  session: string | null;
}): Promise<DraftSaveResult> {
  const payload = fitDraftPayload(input.payload);
  try {
    const { data, error } = await rpc('posting_draft_save', {
      p_payload: payload,
      p_missing: Array.from(new Set(input.missing)),
      p_tenant_name: input.tenantName?.trim() || null,
      p_tenant_phone: input.tenantPhone?.trim() || null,
      p_draft_id: input.draftId,
      p_session: input.session,
    });
    if (error) {
      if (isRpcMissing(error)) { markDraftsAvailable(false); return { ok: false, missingRpc: true, message: '' }; }
      return { ok: false, missingRpc: false, message: error.message || 'Could not save. Try again.' };
    }
    markDraftsAvailable(true);
    const r = (data && typeof data === 'object' ? data : {}) as { id?: string; draft_id?: string };
    const id = typeof data === 'string' ? data : (r.id ?? r.draft_id ?? input.draftId ?? '');
    return { ok: true, id };
  } catch (e) {
    return { ok: false, missingRpc: false, message: e instanceof Error ? e.message : 'Could not save. Try again.' };
  }
}

/** The agent's saved drafts, or null when the RPC is not there (hide the list). Throws other errors. */
export async function fetchMyDrafts(): Promise<PostingDraftRow[] | null> {
  const { data, error } = await rpc('posting_drafts_mine', {});
  if (error) {
    if (isRpcMissing(error)) { markDraftsAvailable(false); return null; }
    throw new Error(error.message || 'Could not load saved requests.');
  }
  markDraftsAvailable(true);
  const list = Array.isArray(data) ? data : (data && typeof data === 'object' && Array.isArray((data as { drafts?: unknown[] }).drafts) ? (data as { drafts: unknown[] }).drafts : []);
  return (list as PostingDraftRow[]).filter((d) => d && typeof d.id === 'string');
}

/** Discards a draft, or marks it posted. Returns the server's error, or null. Never throws. */
export async function closeDraft(draftId: string, status: 'discarded' | 'posted', rentRequestId?: string | null): Promise<string | null> {
  try {
    const { error } = await rpc('posting_draft_close', {
      p_draft_id: draftId, p_status: status, ...(status === 'posted' ? { p_rent_request_id: rentRequestId ?? null } : {}),
    });
    if (error) {
      if (isRpcMissing(error)) markDraftsAvailable(false);
      return error.message || 'Could not update the saved request.';
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not update the saved request.';
  }
}

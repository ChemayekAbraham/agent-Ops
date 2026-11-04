/**
 * Welile Homes Register Tenant drafts and ID-required enrolment.
 * Drafts live in `wh_tenant_drafts` (owner-only); they are never enrolled tenants,
 * never in totals, float requests or landlord verification.
 * Enrolment goes only through `wh_enroll_tenant_with_identity`, which refuses
 * without a valid unused NIN and a passport photo.
 */
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';
import { WH_TENANT_ID_BUCKET, isValidNin, normalizeNin } from '@/lib/welileHomesTenantId';

export interface WhDraftForm {
  phone?: string;
  newName?: string;
  nin?: string;
  rent?: string;
  payoutDay?: string;
  hasPhone?: boolean;
  landlordUsesWallet?: boolean;
  existingTenantId?: string | null;
  existingTenantName?: string | null;
}

export interface WhTenantDraft {
  id: string;
  agent_id: string;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  landlord_snapshot: Record<string, unknown>;
  form: WhDraftForm;
  photo_path: string | null;
  updated_at: string;
}

/** Pure: what still blocks enrolment (empty list = ready). */
export function enrollmentIdBlockers(input: {
  phone: string; fullName: string; existingTenant: boolean;
  nin: string; hasPhoto: boolean; ninInUse: boolean; ninLimited?: boolean; idAlreadyComplete?: boolean;
}): string[] {
  const out: string[] = [];
  if (!input.phone.trim()) out.push('Tenant phone');
  if (!input.existingTenant && input.fullName.trim().length < 2) out.push('Tenant full name');
  if (input.idAlreadyComplete) return out;
  if (!isValidNin(input.nin)) out.push('Valid NIN (14 characters, starts with CM or CF)');
  else if (input.ninLimited) out.push(NIN_RATE_LIMIT_MESSAGE);
  else if (input.ninInUse) out.push('NIN not used by another tenant');
  if (!input.hasPhoto) out.push('Passport photo');
  return out;
}

export async function fetchMyTenantDrafts(agentId: string): Promise<WhTenantDraft[]> {
  const { data, error } = await (supabase.from as any)('wh_tenant_drafts')
    .select('*').eq('agent_id', agentId).order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as WhTenantDraft[];
}

export async function saveTenantDraft(d: {
  id?: string | null; agentId: string; landlordId?: string | null; landlordName: string;
  landlordPhone: string; landlordSnapshot: Record<string, unknown>; form: WhDraftForm; photoPath: string | null;
}): Promise<string> {
  const row = {
    agent_id: d.agentId, landlord_id: d.landlordId ?? null, landlord_name: d.landlordName || null,
    landlord_phone: d.landlordPhone || null, landlord_snapshot: d.landlordSnapshot, form: d.form,
    photo_path: d.photoPath,
  };
  if (d.id) {
    const { error } = await (supabase.from as any)('wh_tenant_drafts').update(row).eq('id', d.id);
    if (error) throw error;
    return d.id;
  }
  const { data, error } = await (supabase.from as any)('wh_tenant_drafts').insert(row).select('id').single();
  if (error) throw error;
  return data.id as string;
}

export async function deleteTenantDraft(id: string) {
  const { error } = await (supabase.from as any)('wh_tenant_drafts').delete().eq('id', id);
  if (error) throw error;
}

/** Compress (max 800px WebP) and upload privately under {agentId}/drafts/{key}/. */
export async function uploadDraftTenantPhoto(agentId: string, key: string, file: File): Promise<string> {
  let blob: Blob = file;
  let ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  try {
    const out = await optimizeImage(file, { maxWidth: 800, maxHeight: 800, quality: 0.7 });
    blob = out.file;
    ext = (out.file.type.split('/')[1] || ext).toLowerCase();
  } catch { /* keep original */ }
  const path = `${agentId}/drafts/${key}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(WH_TENANT_ID_BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg', upsert: false,
  });
  if (error) throw error;
  return path;
}

export const NIN_RATE_LIMIT_MESSAGE = 'Too many ID checks – try again later';

/** Yes/no "already on file" check, limited on the server to 30 per agent per hour. */
export async function checkNin(nin: string, tenantId?: string | null): Promise<{ inUse: boolean; limited: boolean }> {
  const { data, error } = await (supabase.rpc as any)('wh_nin_check', { p_nin: normalizeNin(nin), p_tenant_id: tenantId ?? null });
  if (error) return { inUse: false, limited: false }; // server still enforces at enrolment
  return { inUse: data?.in_use === true, limited: data?.limited === true };
}

export async function enrollTenantWithIdentity(p: {
  tenantId: string; agentId: string; monthlyRent: number; payoutDay: number; hasSmartphone: boolean;
  landlordUsesWallet: boolean; landlordId: string | null; landlordName: string | null; landlordPhone: string | null;
  notes: string; nin: string | null; photoPath: string | null; draftId: string | null;
}) {
  return (supabase.rpc as any)('wh_enroll_tenant_with_identity', {
    p_tenant_id: p.tenantId, p_agent_id: p.agentId, p_monthly_rent: p.monthlyRent, p_payout_day: p.payoutDay,
    p_has_smartphone: p.hasSmartphone, p_landlord_uses_wallet: p.landlordUsesWallet, p_landlord_id: p.landlordId,
    p_landlord_name: p.landlordName, p_landlord_phone: p.landlordPhone, p_notes: p.notes,
    p_nin: p.nin ? normalizeNin(p.nin) : null, p_photo_path: p.photoPath, p_draft_id: p.draftId,
  });
}

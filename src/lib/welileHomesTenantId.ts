/**
 * Welile Homes tenant ID: NIN + passport photo (tenants never get an OTP).
 * The server (`wh_set_tenant_identity`, `wh_request_float`) is the only authority;
 * these helpers only pre-check and transport.
 */
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';

export const WH_TENANT_ID_BUCKET = 'wh-tenant-id-photos';

export function normalizeNin(raw: string): string {
  return (raw || '').replace(/\s+/g, '').toUpperCase();
}

/** Ugandan NIN: 14 characters, starts with CM or CF. */
export function isValidNin(raw: string): boolean {
  return /^C[MF][A-Z0-9]{12}$/.test(normalizeNin(raw));
}

export interface WhTenantIdentity {
  tenant_id: string;
  nin: string;
  photo_path: string;
}

export function isIdComplete(id?: Pick<WhTenantIdentity, 'nin' | 'photo_path'> | null): boolean {
  return !!id && isValidNin(id.nin) && !!id.photo_path;
}

export async function fetchTenantIdentities(tenantIds: string[]): Promise<Map<string, WhTenantIdentity>> {
  const map = new Map<string, WhTenantIdentity>();
  const ids = Array.from(new Set(tenantIds.filter(Boolean)));
  if (ids.length === 0) return map;
  const { data, error } = await (supabase.from as any)('wh_tenant_identity')
    .select('tenant_id, nin, photo_path')
    .in('tenant_id', ids);
  if (error) throw error;
  for (const r of (data ?? []) as WhTenantIdentity[]) map.set(r.tenant_id, r);
  return map;
}

/** Compress (max 800px WebP) and upload privately under {agentId}/{tenantId}/. */
export async function uploadTenantPhoto(agentId: string, tenantId: string, file: File): Promise<string> {
  let blob: Blob = file;
  let ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  try {
    const out = await optimizeImage(file, { maxWidth: 800, maxHeight: 800, quality: 0.7 });
    blob = out.file;
    ext = (out.file.type.split('/')[1] || ext).toLowerCase();
  } catch { /* fall back to the original file */ }
  const path = `${agentId}/${tenantId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(WH_TENANT_ID_BUCKET).upload(path, blob, {
    contentType: blob.type || 'image/jpeg', upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function saveTenantIdentity(tenantId: string, nin: string, photoPath: string) {
  const { data, error } = await (supabase.rpc as any)('wh_set_tenant_identity', {
    p_tenant_id: tenantId, p_nin: normalizeNin(nin), p_photo_path: photoPath,
  });
  if (error) throw error;
  return data;
}

export async function tenantPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(WH_TENANT_ID_BUCKET).createSignedUrl(path, 600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export interface FloatRequestTenantId {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string | null;
  nin: string | null;
  photo_path: string | null;
}

export async function fetchFloatRequestTenantIds(requestId: string): Promise<FloatRequestTenantId[]> {
  const { data, error } = await (supabase.rpc as any)('wh_float_request_tenant_ids', { p_request_id: requestId });
  if (error) throw error;
  return (data ?? []) as FloatRequestTenantId[];
}

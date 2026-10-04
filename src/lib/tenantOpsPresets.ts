import { supabase } from '@/integrations/supabase/client';
import type { TenantOpsFilters } from './tenantOpsFilters';

export type PresetVisibility = 'private' | 'shared';

export interface TenantOpsPresetRemote {
  id: string;
  name: string;
  filters: TenantOpsFilters;
  visibility: PresetVisibility;
  share_slug: string | null;
  owner_id: string;
  is_mine: boolean;
  created_at: string;
}

function makeSlug(): string {
  // 16 char url-safe slug
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function listPresets(): Promise<TenantOpsPresetRemote[]> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id ?? null;
  const { data, error } = await supabase
    .from('tenant_ops_filter_presets' as any)
    .select('id,name,filters,visibility,share_slug,owner_id,created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    filters: r.filters as TenantOpsFilters,
    visibility: r.visibility as PresetVisibility,
    share_slug: r.share_slug,
    owner_id: r.owner_id,
    is_mine: !!uid && r.owner_id === uid,
    created_at: r.created_at,
  }));
}

export async function createPreset(input: {
  name: string;
  filters: TenantOpsFilters;
  visibility: PresetVisibility;
}): Promise<TenantOpsPresetRemote> {
  const slug = input.visibility === 'shared' ? makeSlug() : null;
  const { data, error } = await supabase
    .from('tenant_ops_filter_presets' as any)
    .insert({
      name: input.name.trim().slice(0, 60),
      filters: input.filters as any,
      visibility: input.visibility,
      share_slug: slug,
    } as any)
    .select('id,name,filters,visibility,share_slug,owner_id,created_at')
    .single();
  if (error) throw error;
  const { data: auth } = await supabase.auth.getUser();
  const row = data as any;
  return {
    id: row.id, name: row.name,
    filters: row.filters as TenantOpsFilters,
    visibility: row.visibility as PresetVisibility,
    share_slug: row.share_slug,
    owner_id: row.owner_id,
    is_mine: row.owner_id === auth.user?.id,
    created_at: row.created_at,
  };
}

export async function deletePresetRemote(id: string): Promise<void> {
  const { error } = await supabase
    .from('tenant_ops_filter_presets' as any).delete().eq('id', id);
  if (error) throw error;
}

export async function setPresetVisibility(
  id: string, visibility: PresetVisibility,
): Promise<TenantOpsPresetRemote> {
  const patch: any = { visibility };
  if (visibility === 'shared') patch.share_slug = makeSlug();
  else patch.share_slug = null;
  const { data, error } = await supabase
    .from('tenant_ops_filter_presets' as any)
    .update(patch).eq('id', id)
    .select('id,name,filters,visibility,share_slug,owner_id,created_at')
    .single();
  if (error) throw error;
  const { data: auth } = await supabase.auth.getUser();
  const row = data as any;
  return {
    id: row.id, name: row.name,
    filters: row.filters as TenantOpsFilters,
    visibility: row.visibility as PresetVisibility,
    share_slug: row.share_slug,
    owner_id: row.owner_id,
    is_mine: row.owner_id === auth.user?.id,
    created_at: row.created_at,
  };
}

export async function resolvePresetBySlug(slug: string): Promise<TenantOpsPresetRemote | null> {
  const { data, error } = await supabase.rpc('get_tenant_ops_preset_by_slug' as any, { p_slug: slug });
  if (error) throw error;
  const row = (data as any[])?.[0];
  if (!row) return null;
  const { data: auth } = await supabase.auth.getUser();
  return {
    id: row.id, name: row.name,
    filters: row.filters as TenantOpsFilters,
    visibility: row.visibility as PresetVisibility,
    share_slug: row.share_slug,
    owner_id: row.owner_id,
    is_mine: row.owner_id === auth.user?.id,
    created_at: row.created_at,
  };
}

export function buildShareUrl(slug: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('preset', slug);
  // ensure we land on the tenant ops tab
  if (!url.searchParams.get('tab')) url.searchParams.set('tab', 'tenant-ops');
  return url.toString();
}
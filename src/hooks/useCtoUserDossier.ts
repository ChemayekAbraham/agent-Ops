import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// Read-only CTO dossier. Every section is a role-gated server function
// (cto / super_admin); the browser never decides access.
const rpc = async (fn: string, args: Record<string, unknown>) => {
  const { data, error } = await (supabase.rpc as any)(fn, args);
  if (error) throw new Error(error.message);
  return data as any;
};

export const useDossierSearch = (q: string) =>
  useQuery({ queryKey: ['cto-dossier-search', q], queryFn: () => rpc('cto_user_dossier_search', { p_q: q }), enabled: q.trim().length >= 2, staleTime: 60_000 });

export const useDossierProfile = (id?: string) =>
  useQuery({ queryKey: ['cto-dossier-profile', id], queryFn: () => rpc('cto_user_dossier_profile', { p_user: id }), enabled: !!id, staleTime: 120_000 });

export interface MoneyFilters { category?: string; direction?: string; from?: string; to?: string; search?: string; offset: number }
export const useDossierMoney = (id: string | undefined, f: MoneyFilters, enabled: boolean) =>
  useQuery({
    queryKey: ['cto-dossier-money', id, f],
    queryFn: () => rpc('cto_user_dossier_money', {
      p_user: id, p_category: f.category || null, p_direction: f.direction || null,
      p_from: f.from || null, p_to: f.to || null, p_search: f.search || null, p_offset: f.offset,
    }),
    enabled: !!id && enabled, staleTime: 120_000,
  });

export const useDossierPartner = (id: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['cto-dossier-partner', id], queryFn: () => rpc('cto_user_dossier_partner', { p_user: id }), enabled: !!id && enabled, staleTime: 120_000 });

export const useDossierActivity = (id: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: ['cto-dossier-activity', id], queryFn: () => rpc('cto_user_dossier_activity', { p_user: id }), enabled: !!id && enabled, staleTime: 120_000 });

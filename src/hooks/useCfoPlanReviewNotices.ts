import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * E126: the COO's plan set-up pushes reach the CFO as notifications of type
 * 'cfo_plan_review' (link /cfo). The CFO dashboard's bell reads them here:
 * the latest 20, not dismissed, with the unread count for its badge.
 */

export const CFO_PLAN_REVIEW = 'cfo_plan_review';

export type CfoPlanReviewNotice = {
  id: string;
  title: string;
  message: string;
  is_read: boolean | null;
  created_at: string;
  link_path: string | null;
};

export function useCfoPlanReviewNotices() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = ['cfo-plan-review-notices', user?.id ?? null];
  const q = useQuery({
    queryKey: key,
    enabled: !!user?.id,
    queryFn: async (): Promise<CfoPlanReviewNotice[]> => {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, title, message, is_read, created_at, link_path')
        .eq('user_id', user?.id as string)
        .eq('type', CFO_PLAN_REVIEW)
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as CfoPlanReviewNotice[];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
  const items = q.data ?? [];
  const markRead = async (id: string) => {
    await supabase.from('notifications').update({ is_read: true, read_at: new Date().toISOString() }).eq('id', id);
    void qc.invalidateQueries({ queryKey: key });
  };
  return { items, unread: items.filter((n) => !n.is_read).length, markRead };
}

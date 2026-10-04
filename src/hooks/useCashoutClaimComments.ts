import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface CashoutClaimComment {
  id: string;
  withdrawal_id: string;
  author_id: string;
  author_name: string | null;
  author_role: string | null;
  comment: string;
  status: string | null;
  created_at: string;
}

/**
 * Permanent, append-only comment timeline for a single cash-out claim
 * (withdrawal request). Finance/ops staff and the assigned cash-out agent can
 * read the timeline and add comments. Comments can never be edited or deleted.
 */
export function useCashoutClaimComments(withdrawalId: string | null | undefined) {
  const { user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['cashout-claim-comments', withdrawalId],
    enabled: !!withdrawalId,
    staleTime: 15_000,
    queryFn: async (): Promise<CashoutClaimComment[]> => {
      const { data, error } = await supabase
        .from('cashout_claim_comments' as any)
        .select('*')
        .eq('withdrawal_id', withdrawalId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as CashoutClaimComment[];
    },
  });

  const addComment = useMutation({
    mutationFn: async ({ comment, status }: { comment: string; status?: string | null }) => {
      if (!user) throw new Error('Not signed in');
      if (!withdrawalId) throw new Error('No claim selected');
      const text = comment.trim();
      if (text.length < 2) throw new Error('Add a short comment');

      // Resolve a display name + primary role for a readable timeline.
      const [{ data: profile }, { data: roles }] = await Promise.all([
        supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
        supabase.from('user_roles').select('role').eq('user_id', user.id),
      ]);
      const roleOrder = ['cfo', 'coo', 'manager', 'operations', 'super_admin', 'agent'];
      const authorRole =
        (roles ?? [])
          .map((r: any) => r.role as string)
          .sort((a, b) => roleOrder.indexOf(a) - roleOrder.indexOf(b))[0] ?? null;

      const { error } = await supabase.from('cashout_claim_comments' as any).insert({
        withdrawal_id: withdrawalId,
        author_id: user.id,
        author_name: (profile as any)?.full_name ?? null,
        author_role: authorRole,
        comment: text,
        status: status?.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cashout-claim-comments', withdrawalId] });
      qc.invalidateQueries({ queryKey: ['cashout-claim-latest-comments'] });
    },
  });

  const comments = query.data ?? [];
  const latest = comments.length ? comments[comments.length - 1] : null;

  return {
    comments,
    latest,
    isLoading: query.isLoading,
    addComment,
  };
}

/**
 * Batch-fetch the LATEST comment per withdrawal id — used to show an inline
 * "latest comment" on the CFO Cash-Out Merchant list without opening each claim.
 */
export function useLatestClaimComments(withdrawalIds: string[]) {
  const ids = Array.from(new Set(withdrawalIds.filter(Boolean)));
  return useQuery({
    queryKey: ['cashout-claim-latest-comments', ids.slice(0, 500).join(',')],
    enabled: ids.length > 0,
    staleTime: 15_000,
    queryFn: async (): Promise<Record<string, CashoutClaimComment>> => {
      const map: Record<string, CashoutClaimComment> = {};
      for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const { data, error } = await supabase
          .from('cashout_claim_comments' as any)
          .select('*')
          .in('withdrawal_id', chunk)
          .order('created_at', { ascending: true });
        if (error) throw error;
        for (const c of (data ?? []) as unknown as CashoutClaimComment[]) {
          map[c.withdrawal_id] = c; // ascending → last write wins = latest
        }
      }
      return map;
    },
  });
}

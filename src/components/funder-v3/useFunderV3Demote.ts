import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { demoteItems, fetchCanDemote } from '@/lib/fundersBoard';
import type { FunderV3DemoteApi } from './FunderV3HousesScreen';

/**
 * E59: demote is offered only when funders_board_can_demote() is true for the
 * caller (the server decides; any error means no controls). After a demote the
 * board reads ('funder-new' lists, the headline summary, map pins) refresh.
 */
export function useFunderV3Demote(userId: string | null | undefined): FunderV3DemoteApi | null {
  const queryClient = useQueryClient();
  const { data: canDemote = false } = useQuery({
    queryKey: ['funders-board-can-demote', userId],
    queryFn: fetchCanDemote,
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return useMemo<FunderV3DemoteApi | null>(() => {
    if (!canDemote) return null;
    return {
      submit: async (items, reason, note) => {
        const result = await demoteItems(items, reason, note);
        await Promise.all([
          // Lists, recommendations and the headline (useFunderNewMarketSummary) all live under 'funder-new'.
          queryClient.invalidateQueries({ queryKey: ['funder-new'] }),
          queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells'] }),
          queryClient.invalidateQueries({ queryKey: ['empty-house-map-cells-near'] }),
        ]);
        return result;
      },
    };
  }, [canDemote, queryClient]);
}

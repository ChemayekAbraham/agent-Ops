import { useQuery } from '@tanstack/react-query';
import { fetchCanDemote } from '@/lib/fundersBoard';

/**
 * True only when funders_board_can_demote() says so for the caller (COO/CEO).
 * The server decides; while loading, signed out, or on any error it is false.
 * Gates the demote controls and the funders board header totals.
 */
export function useFundersBoardCanDemote(userId: string | null | undefined): boolean {
  const { data = false } = useQuery({
    queryKey: ['funders-board-can-demote', userId],
    queryFn: fetchCanDemote,
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data === true;
}

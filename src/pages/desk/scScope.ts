import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import type { Desk } from './deskConfig';

/**
 * Service Centre people who hold no desk role (agents who run a service
 * centre) still get one desk: Service Centre, showing only their own
 * requests — `pipeline_desk_board` already scopes the rows to them.
 *
 * `desk_my_sc_scope()` says whether the caller is such a person. It is only
 * asked when the account has none of the desk roles.
 */

export type ScScope = { is_sc_person: boolean; open_new: number | null; open_batch: number | null; staff_ref: string | null };

export function useMyScScope(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'my-sc-scope'],
    enabled,
    queryFn: async (): Promise<ScScope | null> => {
      const { data, error } = await rpc('desk_my_sc_scope', {});
      if (error) return null;
      return (data ?? null) as ScScope | null;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Which desks an account opens.
 *
 * Desk roles decide first. With none, a Service Centre person gets the
 * Service Centre desk alone (`scOnly`); anyone else gets nothing, and the page
 * says "No desk for your account yet". An agent role never opens any other desk.
 */
export function desksFor(
  desks: Desk[],
  roles: string[],
  scope: Pick<ScScope, 'is_sc_person'> | null | undefined,
): { desks: Desk[]; scOnly: boolean } {
  const byRole = desks.filter((d) => d.roles.some((r) => roles.includes(r)));
  if (byRole.length > 0) return { desks: byRole, scOnly: false };
  if (scope?.is_sc_person === true) {
    const sc = desks.find((d) => d.id === 'service-centre');
    return sc ? { desks: [sc], scOnly: true } : { desks: [], scOnly: false };
  }
  return { desks: [], scOnly: false };
}

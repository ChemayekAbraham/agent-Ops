import { useAuth } from '@/hooks/useAuth';
import { DESKS } from './deskConfig';
import { deskRouteId, useMyDeskAccess, type MyAccess } from './deskAccess';
import { useMyScScope } from './scScope';

/**
 * The "<Desk> desk" entry each role's dashboard carries, like the COO
 * dashboard's "COO desk" (executiveSidebarConfig). Shown only to someone the
 * desk page would let in: a role that opens the desk (DESK_ROLES), and — once
 * HR desk access is switched on — the desk among the ones HR gave them.
 */

export type DeskLinkId = 'service-centre' | 'agent-ops' | 'tenant-ops' | 'landlord-ops' | 'partner-ops' | 'cfo';

/** Label and route for each dashboard's desk entry. Routes are the desk router's own ids. */
export const DESK_LINKS: Record<DeskLinkId, { label: string; route: string }> = {
  'service-centre': { label: 'Service Centre desk', route: '/desk/service-centre' },
  'agent-ops': { label: 'Agent Ops desk', route: '/desk/agent-ops' },
  'tenant-ops': { label: 'Tenant Ops desk', route: '/desk/tenant-ops' },
  'landlord-ops': { label: 'Landlord Ops desk', route: '/desk/landlord-ops' },
  'partner-ops': { label: 'Partner Ops desk', route: '/desk/partner-ops' },
  cfo: { label: 'Funders Dashboard', route: '/desk/funders' },
};

/**
 * Whether these roles (and HR's desk access, when known) open the desk.
 * `access` undefined means "not answered yet": nothing shows until it is.
 * `scPersonFlag`: `desk_my_sc_scope().is_sc_person`, which lets a Service
 * Centre person with no desk role into the Service Centre desk (scScope.ts).
 */
export function canOpenDesk(
  deskId: string,
  roles: readonly string[],
  access: MyAccess | null | undefined,
  scPersonFlag = false,
): boolean {
  if (access === undefined) return false;
  const desk = DESKS.find((d) => d.id === deskId);
  if (!desk) return false;
  const byRole = desk.roles.some((r) => roles.includes(r));
  const scPerson = deskId === 'service-centre' && (access?.sc_person === true || scPersonFlag);
  if (!byRole && !scPerson) return false;
  // HR desk access switched on: only the desks HR gave this person (all desks for COO / CEO).
  if (access && access.enforced && !access.all) {
    const given = new Set(access.desks.map(deskRouteId));
    return given.has(deskId) || scPerson;
  }
  return true;
}

/** The signed-in person's answer for one desk; false until roles and desk access are known. */
export function useCanOpenDesk(deskId: DeskLinkId): boolean {
  const { roles } = useAuth();
  const mine = (roles ?? []) as unknown as string[];
  const access = useMyDeskAccess(roles !== undefined);
  // Asked only for the Service Centre entry, and only when no desk role already decides it.
  const needScope = deskId === 'service-centre' && roles !== undefined && !DESKS.some((d) => d.id === deskId && d.roles.some((r) => mine.includes(r)));
  const scope = useMyScScope(needScope);
  const answered = access.isFetched || access.isError ? (access.data ?? null) : undefined;
  if (needScope && !scope.isFetched) return false;
  return canOpenDesk(deskId, mine, answered, scope.data?.is_sc_person === true);
}

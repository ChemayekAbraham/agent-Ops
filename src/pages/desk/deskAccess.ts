import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { DESK_ALIASES, type Desk } from './deskConfig';

/**
 * Who may open which desk, managed by HR (People → Desks).
 *
 * `desk_my_access()` says what the signed-in person may open. While `enforced`
 * is false (the COO has not switched it on) nothing changes: desks still open
 * by role. Once it is on, a person sees only the desks HR gave them — plus the
 * Service Centre for a Service Centre person — and `all` (COO, CEO) sees every
 * desk. Access is re-read every 2 minutes and when the window regains focus,
 * so a removal takes effect without signing in again.
 */

export type MyAccess = {
  enforced: boolean;
  employee: boolean;
  all: boolean;
  desks: string[];
  /** The desk to land on, when HR set one. */
  desk: string | null;
  sc_person: boolean;
  can_manage: boolean;
};

export const ACCESS_RECHECK_MS = 2 * 60_000;

export function useMyDeskAccess(enabled = true) {
  return useQuery({
    queryKey: ['desk-access', 'mine'],
    enabled,
    queryFn: async (): Promise<MyAccess | null> => {
      const { data, error } = await rpc('desk_my_access', {});
      // Not applied yet, or refused: behave as before (desks by role).
      if (error) return null;
      const d = (data ?? {}) as Partial<MyAccess>;
      return {
        enforced: d.enforced === true,
        employee: d.employee === true,
        all: d.all === true,
        desks: Array.isArray(d.desks) ? d.desks : [],
        desk: d.desk ?? null,
        sc_person: d.sc_person === true,
        can_manage: d.can_manage === true,
      };
    },
    refetchInterval: ACCESS_RECHECK_MS,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });
}

/** The server may name a desk `agent_ops` or `agent-ops`, or by an alias (`funders`); the page uses route ids. */
export function deskRouteId(id: string): string {
  const dashed = id.trim().toLowerCase().replace(/_/g, '-');
  return DESK_ALIASES[dashed] ?? dashed;
}

/**
 * The desks this person sees, in the page's own tab order (never reordered).
 *
 * Not enforced, no answer, or `all`: the role-based list is kept as it is.
 * Enforced: exactly the desks in `desks[]`, plus the Service Centre for a
 * Service Centre person.
 */
export function desksByAccess(byRole: Desk[], every: Desk[], access: MyAccess | null | undefined): Desk[] {
  if (!access || !access.enforced || access.all) return byRole;
  const ids = new Set(access.desks.map(deskRouteId));
  if (access.sc_person) ids.add('service-centre');
  return every.filter((d) => ids.has(d.id));
}

/** Where a desk route that is not allowed goes: HR's landing desk if allowed, else the first allowed desk. */
export function accessLanding(allowed: Desk[], access: MyAccess | null | undefined): Desk | null {
  if (allowed.length === 0) return null;
  const preferred = access?.desk ? deskRouteId(access.desk) : null;
  return allowed.find((d) => d.id === preferred) ?? allowed[0];
}

/** The board's refusal when HR has not given this person the desk. */
export const NOT_ASSIGNED = 'This desk is not assigned to you';

export function isNotAssigned(error: unknown): boolean {
  const e = error as { message?: string } | null;
  return /not assigned to you/i.test(String(e?.message ?? ''));
}

/* ───────────────────────── HR: People → Desks ───────────────────────── */

export type DeskMember = {
  user_id: string;
  name: string | null;
  staff_ref: string | null;
  active_employee: boolean | null;
  added_at: string | null;
  added_by: string | null;
};

export type DeskAccessEntry = { desk: string; label: string | null; members: DeskMember[] };

export type DeskAccessList = { enforced: boolean; desks: DeskAccessEntry[] };

export type DeskCandidate = { user_id: string; name: string | null; staff_ref: string | null; phone: string | null; desks: string[] };

/** The "All desks (COO, CEO)" card follows roles, not HR's list: it is shown, never edited. */
export function isAllDesksEntry(e: Pick<DeskAccessEntry, 'desk' | 'label'>): boolean {
  return e.desk === 'all' || e.desk === '*' || /^all desks/i.test(e.label ?? '');
}

export function useDeskAccessList(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-access', 'list'],
    enabled,
    queryFn: async (): Promise<DeskAccessList> => {
      const { data, error } = await rpc('desk_access_list', {});
      if (error) throw error;
      const d = (data ?? {}) as Partial<DeskAccessList>;
      return { enforced: d.enforced === true, desks: Array.isArray(d.desks) ? d.desks : [] };
    },
    staleTime: 15_000,
    retry: false,
  });
}

export function useDeskAccessCandidates(search: string, enabled: boolean) {
  const term = search.trim();
  return useQuery({
    queryKey: ['desk-access', 'candidates', term],
    enabled,
    queryFn: async (): Promise<DeskCandidate[]> => {
      const { data, error } = await rpc('desk_access_candidates', { p_search: term || null });
      if (error) throw error;
      return Array.isArray(data) ? (data as DeskCandidate[]) : [];
    },
    staleTime: 15_000,
    retry: false,
  });
}

/** Adds each person in turn; returns the server's message for every one that failed. */
export async function addToDesk(desk: string, userIds: string[]): Promise<{ added: number; errors: string[] }> {
  let added = 0;
  const errors: string[] = [];
  for (const id of userIds) {
    const { error } = await rpc('desk_access_add', { p_desk: desk, p_user: id });
    if (error) errors.push(error.message);
    else added += 1;
  }
  return { added, errors };
}

export async function removeFromDesk(desk: string, userId: string): Promise<string | null> {
  const { error } = await rpc('desk_access_remove', { p_desk: desk, p_user: userId });
  return error ? error.message : null;
}

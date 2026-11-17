import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { DESK_ROLES } from './deskRoles';
import type { MyAccess } from './deskAccess';

/**
 * E133: the data behind the field agents' Service Centre view, kept free of
 * desk UI so the agent app's menu can ask whether to show its entry.
 *
 *   rpc('sc_field_board') → { allowed, reason?, message?, team_agents,
 *     rows: [{ rent_request_id, ref, tenant { name, phone }, agent { id, name, phone, is_me },
 *              rent, where, to_fix, days_waiting, missing: string[], desk_note }] }
 */

type Person = { id?: string | null; name: string | null; phone: string | null; is_me?: boolean | null } | null;
export type ScFieldRow = {
  rent_request_id: string;
  ref: string | null;
  tenant: Person;
  agent: Person;
  rent: number | null;
  where: string | null;
  to_fix: boolean | null;
  days_waiting: number | null;
  missing: string[] | null;
  desk_note: string | null;
};
export type ScFieldBoard = { allowed: boolean; reason: string | null; message: string | null; team_agents: number; rows: ScFieldRow[] };

export const SC_FIELD_KEY = ['sc-field-board'] as const;
export const SC_FIELD_MENU_LABEL = 'Service Centre — my agents';
export const SC_FIELD_PATH = '/agent/service-centre';
export const AT_SC = 'Service Centre';

export function readScFieldBoard(v: unknown): ScFieldBoard {
  const b = (v && typeof v === 'object' ? v : {}) as Partial<ScFieldBoard>;
  return {
    allowed: b.allowed !== false,
    reason: b.reason ?? null,
    message: b.message ?? null,
    team_agents: Number(b.team_agents) || 0,
    rows: Array.isArray(b.rows) ? b.rows : [],
  };
}

// Called on the client itself: `rpc` needs its `this` (a detached `supabase.rpc` fails with "reading 'rest'").
const callRpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase as unknown as { rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> }).rpc(fn, args);

export function useScFieldBoard(enabled = true) {
  return useQuery({
    queryKey: SC_FIELD_KEY,
    enabled,
    queryFn: async (): Promise<ScFieldBoard> => {
      const { data, error } = await callRpc('sc_field_board', {});
      if (error) throw error;
      return readScFieldBoard(data);
    },
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
    retry: 1,
  });
}

/**
 * The menu entry, for every agent: shown once the server has answered,
 * hidden when it says `allowed: false` (AGENTS_ONLY, or HEADS_ONLY once that
 * switch is on). A failed read still shows it; the screen says what went wrong.
 */
export function useScFieldMenuVisible(enabled = true): boolean {
  const q = useScFieldBoard(enabled);
  if (!enabled || q.isLoading) return false;
  return q.data?.allowed !== false;
}

const isScDesk = (d: string) => d.trim().toLowerCase().replace(/_/g, '-') === 'service-centre';

/**
 * Service Centre staff: HR gave them the Service Centre desk or every desk;
 * before HR's list is enforced, a Service Centre desk role counts too. An
 * agent who runs a service centre (`sc_person` alone) is not staff.
 */
export function isScStaff(roles: string[], access: MyAccess | null | undefined): boolean {
  if (access?.all) return true;
  if ((access?.desks ?? []).some(isScDesk)) return true;
  if (access?.enforced) return false;
  return (DESK_ROLES['service-centre'] ?? []).some((r) => roles.includes(r));
}

/** Any signed-in agent who is not Service Centre staff gets the simple view. */
export const isFieldAgent = (roles: string[], access: MyAccess | null | undefined): boolean => roles.includes('agent') && !isScStaff(roles, access);

export type ScFieldGroup = 'fix' | 'sc' | 'further';
export const groupOf = (r: ScFieldRow): ScFieldGroup => (r.to_fix ? 'fix' : r.where === AT_SC ? 'sc' : 'further');

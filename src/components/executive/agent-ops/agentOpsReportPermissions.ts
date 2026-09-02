import { useAuth } from '@/hooks/useAuth';
import type { Database } from '@/integrations/supabase/types';

export type AppRoleName = Database['public']['Enums']['app_role'];

/**
 * Editing the Agent Operations report — narrative, actions, outcomes, submit,
 * stage events — is limited to the Agent Operations Officer role plus COO, CEO,
 * MD (manager) and admin. Viewing is NOT gated here: anyone who can reach the
 * Agent Operations dashboard sees the identical window, read-only.
 */
export const AGENT_OPS_REPORT_EDIT_ROLES: AppRoleName[] = [
  'agent_ops',
  'coo',
  'ceo',
  'manager',
  'admin',
  'super_admin',
];

/**
 * Setting target_net_agents and editing agent_ops_recruiter_exclusions is
 * COO / MD / admin only, and lives in a separate settings panel — never in the
 * report window itself.
 */
export const AGENT_OPS_SETTINGS_ROLES: AppRoleName[] = ['coo', 'manager', 'admin', 'super_admin'];

export function canEditAgentOpsReport(roles: readonly string[]): boolean {
  return roles.some((role) => (AGENT_OPS_REPORT_EDIT_ROLES as string[]).includes(role));
}

export function canManageAgentOpsSettings(roles: readonly string[]): boolean {
  return roles.some((role) => (AGENT_OPS_SETTINGS_ROLES as string[]).includes(role));
}

export interface AgentOpsReportPermissions {
  /** Narrative, actions, outcomes, submit, stage events. */
  canEdit: boolean;
  /** Targets, recruiter exclusions, and the Compute now control. */
  canManageSettings: boolean;
}

export function useAgentOpsReportPermissions(): AgentOpsReportPermissions {
  const { roles, role } = useAuth();
  const effective = [...(roles ?? []), ...(role ? [role] : [])];
  return {
    canEdit: canEditAgentOpsReport(effective),
    canManageSettings: canManageAgentOpsSettings(effective),
  };
}

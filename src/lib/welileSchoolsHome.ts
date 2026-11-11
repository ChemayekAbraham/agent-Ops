/**
 * Welile Schools home: one screen for school agents and parents, with a role
 * switcher. These helpers hold the rules so the page stays presentation only.
 */
import type { PartnershipStatus } from '@/lib/welileSchoolsPartnership';

export type SchoolsRole = 'agent' | 'parent';

/** Mirrors the database's welile_schools_agent_ok(): agents and Welile Schools ops. */
export const SCHOOL_AGENT_ROLES = [
  'agent', 'sub_agent', 'senior_agent',
  'agent_ops', 'manager', 'super_admin', 'coo', 'ceo', 'cto', 'operations',
] as const;

export const SCHOOLS_ROLE_KEY = 'welile:schools-home:role';

/** Everyone can open the parent view; the agent view needs a Welile Schools agent role. */
export function availableSchoolsRoles(userRoles: readonly string[]): SchoolsRole[] {
  const isAgent = userRoles.some((r) => (SCHOOL_AGENT_ROLES as readonly string[]).includes(r));
  return isAgent ? ['agent', 'parent'] : ['parent'];
}

/** The remembered choice when it is still allowed, else agent first for agents. */
export function resolveSchoolsRole(available: SchoolsRole[], stored: string | null): SchoolsRole {
  if (stored && (available as string[]).includes(stored)) return stored as SchoolsRole;
  return available[0];
}

export function readStoredSchoolsRole(): string | null {
  try { return localStorage.getItem(SCHOOLS_ROLE_KEY); } catch { return null; }
}

export function writeStoredSchoolsRole(role: SchoolsRole) {
  try { localStorage.setItem(SCHOOLS_ROLE_KEY, role); } catch { /* storage blocked */ }
}

export type AttentionKind = 'pick_school' | 'finish_setup' | 'changes_requested' | 'awaiting_approval' | 'rejected' | 'offline_queue';

export interface AttentionItem {
  kind: AttentionKind;
  title: string;
  detail: string;
  tone: 'danger' | 'warning' | 'info';
}

/** What the agent should act on, most urgent first. Empty means all caught up. */
export function agentAttention(input: {
  hasCurrentSchool: boolean;
  partnershipStatus: PartnershipStatus | null | undefined;
  missingForSubmit: string[];
  pendingUploads: number;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!input.hasCurrentSchool) {
    items.push({ kind: 'pick_school', title: 'Choose the school you are at', detail: 'Pick one from your schools below', tone: 'warning' });
  } else {
    switch (input.partnershipStatus ?? null) {
      case 'changes_requested':
        items.push({ kind: 'changes_requested', title: 'Ops asked for changes', detail: 'Update the school set-up and resubmit', tone: 'danger' });
        break;
      case 'rejected':
        items.push({ kind: 'rejected', title: 'School partnership rejected', detail: 'See the note from ops', tone: 'danger' });
        break;
      case 'submitted':
        items.push({ kind: 'awaiting_approval', title: 'Waiting for ops approval', detail: 'Nothing to do until ops reviews it', tone: 'info' });
        break;
      case 'approved':
      case 'suspended':
        break;
      default: {
        const n = input.missingForSubmit.length;
        items.push({
          kind: 'finish_setup',
          title: 'Finish the school set-up',
          detail: n > 0 ? `Still missing: ${input.missingForSubmit.join(', ')}` : 'Ready to submit for approval',
          tone: 'warning',
        });
      }
    }
  }
  if (input.pendingUploads > 0) {
    items.push({
      kind: 'offline_queue',
      title: `${input.pendingUploads} record${input.pendingUploads === 1 ? '' : 's'} waiting to upload`,
      detail: 'They send when you are back online',
      tone: 'info',
    });
  }
  return items;
}

/**
 * Welile Schools home: a public entry point (/schools, no sign-in) with an
 * onboarding funnel and a separate home for each role — parent, school owner and
 * Welile agent. These helpers hold the rules so the pages stay presentation only.
 */
import type { PartnershipStatus } from '@/lib/welileSchoolsPartnership';

export type SchoolsRole = 'parent' | 'school' | 'agent';

/** Switcher order: the two outside audiences first, Welile's own agents last. */
export const SCHOOLS_ROLES: SchoolsRole[] = ['parent', 'school', 'agent'];

export const SCHOOLS_ROLE_LABEL: Record<SchoolsRole, string> = {
  parent: 'Parent',
  school: 'School owner',
  agent: 'Welile agent',
};

/** Mirrors the database's welile_schools_agent_ok(): agents and Welile Schools ops. */
export const SCHOOL_AGENT_ROLES = [
  'agent', 'sub_agent', 'senior_agent',
  'agent_ops', 'manager', 'super_admin', 'coo', 'ceo', 'cto', 'operations',
] as const;

/** Set once the visitor finishes the funnel; holds the role they picked or last viewed. */
export const SCHOOLS_ROLE_KEY = 'welile:schools-home:role';

/** Can this signed-in account do the agent's real work (gate log, registrations, set-up)? */
export function canWorkAsSchoolAgent(userRoles: readonly string[] | null | undefined): boolean {
  return (userRoles ?? []).some((r) => (SCHOOL_AGENT_ROLES as readonly string[]).includes(r));
}

export function isSchoolsRole(value: unknown): value is SchoolsRole {
  return typeof value === 'string' && (SCHOOLS_ROLES as string[]).includes(value);
}

/** The remembered role, or null when the visitor has not been through the funnel yet. */
export function readStoredSchoolsRole(): SchoolsRole | null {
  try {
    const v = localStorage.getItem(SCHOOLS_ROLE_KEY);
    return isSchoolsRole(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredSchoolsRole(role: SchoolsRole) {
  try { localStorage.setItem(SCHOOLS_ROLE_KEY, role); } catch { /* storage blocked */ }
}

export function clearStoredSchoolsRole() {
  try { localStorage.removeItem(SCHOOLS_ROLE_KEY); } catch { /* storage blocked */ }
}

/** `?role=parent` (e.g. from an SMS link) skips the funnel straight to that home. */
export function roleFromQuery(search: string): SchoolsRole | null {
  const v = new URLSearchParams(search).get('role');
  return isSchoolsRole(v) ? v : null;
}

export interface RoleIntro {
  title: string;
  points: { title: string; body: string }[];
}

/** The funnel's second step: what each role gets from Welile Schools. */
export const ROLE_INTRO: Record<SchoolsRole, RoleIntro> = {
  parent: {
    title: 'Keep your child in school from day one',
    points: [
      { title: 'Welile pays the school', body: 'Your child\'s term fees go straight to the school at the start of term.' },
      { title: 'You pay in small daily amounts', body: 'Pay any amount, any day, by MTN or Airtel.' },
      { title: 'Pay early, pay less', body: 'The facilitation fee is worked out daily on what you still owe.' },
    ],
  },
  school: {
    title: 'Get full fees at the start of every term',
    points: [
      { title: 'Paid upfront', body: 'Welile pays each enrolled student\'s fees into your account at the start of term.' },
      { title: 'Less time chasing balances', body: 'Parents repay Welile, not your bursar.' },
      { title: 'More students enrolled', body: 'A Welile agent at your school signs families up.' },
    ],
  },
  agent: {
    title: 'Run Welile Schools at your school',
    points: [
      { title: 'Register the school and its students', body: 'Each student with their parent or guardian, plus daily gate in and out.' },
      { title: 'Set up the partnership', body: 'Bursar, payout account, terms and fees, sent to ops for approval.' },
      { title: 'Sign up families', body: 'Help parents start School Fees Plans and follow up late payers.' },
    ],
  },
};

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

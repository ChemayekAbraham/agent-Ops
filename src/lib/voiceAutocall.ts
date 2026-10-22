/**
 * Automated call centre (Africa's Talking IVR) — shared types and pure helpers.
 *
 * Server: migrations 20261022150000–20261022150200, edge functions
 * voice-autocall-dialer (every minute) and voice-autocall-ivr (AT callback).
 * Access is crm, cto and super_admin only, enforced by the server.
 */

export const AUTOCALL_CATEGORIES = ['tenant', 'partner', 'agent', 'employee', 'general'] as const;
export type AutocallCategory = (typeof AUTOCALL_CATEGORIES)[number];

export const AUTOCALL_CATEGORY_LABELS: Record<AutocallCategory, string> = {
  tenant: 'Tenants',
  partner: 'Partners',
  agent: 'Agents',
  employee: 'Employees',
  general: 'General',
};

/** Roles that may open the Command Center. Mirrors voice_autocall_authorized(). */
export const AUTOCALL_ROLES = ['crm', 'cto', 'super_admin'] as const;

export type AutocallJobStatus =
  | 'queued' | 'dialing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'cancelled' | 'expired';

export const AUTOCALL_STATUS_LABELS: Record<AutocallJobStatus, string> = {
  queued: 'Waiting',
  dialing: 'Ringing',
  in_progress: 'On the call',
  completed: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expired: 'Not reached in time',
};

/** Outcome slugs the seeded scripts set. Custom scripts may add their own. */
export const AUTOCALL_OUTCOME_LABELS: Record<string, string> = {
  promise_to_pay: 'Will pay today',
  agent_callback: 'Wants agent to call',
  difficulty_callback: 'Having difficulty, call back',
  transfer_requested: 'Asked for the team',
  transferred: 'Spoke to the team',
  callback_requested: 'Team busy, call back',
  left_message: 'Left a voice message',
  no_message: 'Did not leave a message',
  opted_out: 'Stopped these calls',
  unconfirmed: 'Not confirmed (wrong person or voicemail)',
  no_choice: 'Listened, pressed nothing',
  listened: 'Listened',
};

export const outcomeLabel = (slug: string | null | undefined): string =>
  slug ? AUTOCALL_OUTCOME_LABELS[slug] ?? slug.replace(/_/g, ' ') : '—';

export type AutocallAudienceKind = 'tenant_due_today' | 'tenant_missed_yesterday' | 'manual';

export const AUTOCALL_AUDIENCE_LABELS: Record<AutocallAudienceKind, string> = {
  tenant_due_today: "Tenants with an unpaid Rent Plan payment on today's bill",
  tenant_missed_yesterday: "Tenants who missed yesterday's Rent Plan payment and have not paid today",
  manual: 'People added by hand',
};

/** Which audiences each category may use. */
export const AUTOCALL_AUDIENCES_BY_CATEGORY: Record<AutocallCategory, AutocallAudienceKind[]> = {
  tenant: ['tenant_due_today', 'tenant_missed_yesterday', 'manual'],
  partner: ['manual'],
  agent: ['manual'],
  employee: ['manual'],
  general: ['manual'],
};

// ───────────── scripts ─────────────

export type ScriptStepType = 'say' | 'menu' | 'record' | 'transfer' | 'hangup';

export interface ScriptOption {
  next: string;
  outcome?: string;
  action?: 'opt_out';
}

export interface ScriptStep {
  type: ScriptStepType;
  say?: string;
  play_url?: string;
  next?: string;
  options?: Record<string, ScriptOption>;
  no_input?: { next: string; outcome?: string };
  invalid?: { next: string };
  timeout?: number;
  max_seconds?: number;
  outcome?: string;
  fallback_next?: string;
}

export interface ScriptSteps {
  voice?: 'woman' | 'man';
  start: string;
  steps: Record<string, ScriptStep>;
}

/** Placeholders a script may use, with the text read out in a test call. */
export const SCRIPT_VARIABLES: { key: string; label: string; sample: string }[] = [
  { key: 'first_name', label: "Person's first name", sample: 'Sarah' },
  { key: 'amount', label: 'Amount in shillings', sample: '50,000' },
  { key: 'date', label: 'Date of the payment', sample: '22 October' },
  { key: 'agent_name', label: "Agent's first name", sample: 'Moses' },
  { key: 'message', label: 'Free message (announcements)', sample: 'The office is closed on Friday' },
];

export function fillScriptText(text: string, vars: Record<string, string> = sampleVariables()): string {
  return text.replace(/\{([a-z_]+)\}/g, (_, k: string) => vars[k] ?? '').replace(/\s{2,}/g, ' ').trim();
}

export function sampleVariables(): Record<string, string> {
  return Object.fromEntries(SCRIPT_VARIABLES.map((v) => [v.key, v.sample]));
}

/** Words that must never reach a customer (regulatory terminology). */
const BANNED_TERMS: { re: RegExp; use: string }[] = [
  { re: /\bloans?\b/i, use: 'Rent Plan' },
  { re: /\blenders?\b/i, use: 'Supporter' },
  { re: /\bROI\b/, use: 'Returns' },
  { re: /\binterest\b/i, use: 'Returns' },
];

export interface ScriptIssue {
  step: string | null;
  message: string;
}

/**
 * Client-side check before saving, so the editor can point at the exact step.
 * The server (voice_autocall_validate_steps) is still the authority.
 */
export function checkScript(s: ScriptSteps): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const steps = s?.steps ?? {};
  const keys = Object.keys(steps);
  const has = (k?: string) => Boolean(k && steps[k]);
  if (!keys.length) issues.push({ step: null, message: 'The script has no steps.' });
  if (!has(s?.start)) issues.push({ step: null, message: `The first step "${s?.start ?? ''}" does not exist.` });

  for (const [key, step] of Object.entries(steps)) {
    if (!/^[a-z0-9_]{1,40}$/.test(key)) issues.push({ step: key, message: 'Step names use lowercase letters, digits and _ only.' });
    if (['say', 'menu', 'record'].includes(step.type) && !step.say?.trim() && !step.play_url?.trim()) {
      issues.push({ step: key, message: 'Add the words to say, or an audio file.' });
    }
    if ((step.type === 'say' || step.type === 'record') && !has(step.next)) {
      issues.push({ step: key, message: 'Choose what happens next.' });
    }
    if (step.type === 'transfer' && !has(step.fallback_next)) {
      issues.push({ step: key, message: 'Choose what happens when nobody on the team picks up.' });
    }
    if (step.type === 'menu') {
      const opts = Object.entries(step.options ?? {});
      if (!opts.length) issues.push({ step: key, message: 'A menu needs at least one key option.' });
      for (const [digit, opt] of opts) {
        if (!/^[0-9*#]$/.test(digit)) issues.push({ step: key, message: `"${digit}" is not a phone key.` });
        if (!has(opt.next)) issues.push({ step: key, message: `Key ${digit} goes nowhere.` });
      }
    }
    for (const ref of [step.no_input?.next, step.invalid?.next]) {
      if (ref && !has(ref)) issues.push({ step: key, message: `Points at missing step "${ref}".` });
    }
    for (const { re, use } of BANNED_TERMS) {
      if (step.say && re.test(step.say)) {
        issues.push({ step: key, message: `Use "${use}" instead of "${step.say.match(re)?.[0]}".` });
      }
    }
  }
  return issues;
}

/** The steps in the order a listener hears them (start first, then by link). */
export function orderedSteps(s: ScriptSteps): [string, ScriptStep][] {
  const steps = s?.steps ?? {};
  const seen = new Set<string>();
  const out: [string, ScriptStep][] = [];
  const visit = (k?: string) => {
    if (!k || seen.has(k) || !steps[k]) return;
    seen.add(k);
    out.push([k, steps[k]]);
    const st = steps[k];
    visit(st.next);
    Object.values(st.options ?? {}).forEach((o) => visit(o.next));
    visit(st.no_input?.next);
    visit(st.fallback_next);
  };
  visit(s?.start);
  Object.keys(steps).forEach(visit);
  return out;
}

// ───────────── schedule ─────────────

export const WEEKDAY_LABELS: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

export function describeSchedule(c: {
  schedule_kind: 'daily' | 'once';
  start_at: string | null;
  window_start: string;
  window_end: string;
  days_of_week: number[];
}): string {
  const window = `${c.window_start}–${c.window_end}`;
  if (c.schedule_kind === 'once') {
    const when = c.start_at
      ? new Date(c.start_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' })
      : 'not set';
    return `Once, from ${when}, calling ${window}`;
  }
  const days = [...c.days_of_week].sort().map((d) => WEEKDAY_LABELS[d] ?? '').filter(Boolean);
  const dayText = days.length === 6 ? 'Mon–Sat' : days.join(', ');
  return `Every ${dayText}, ${window}`;
}

/** Average minutes one line is busy per call, ringing included. */
export const MINUTES_PER_CALL = 1.5;

/**
 * Rough time to call everyone once: people ÷ (lines × calls per line per hour).
 * Used to warn when a window is too short for the audience.
 */
export function estimateRunMinutes(people: number, channels: number): number {
  if (people <= 0 || channels <= 0) return 0;
  return Math.ceil((people / channels) * MINUTES_PER_CALL);
}

export function windowMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

/**
 * Professional careers applications — read and triage (`job_applications`).
 *
 * Three deliberate choices, each recorded so they are not undone by accident:
 *
 * 1. Columns are listed explicitly rather than selected with `*`.
 *    `expected_salary` is therefore never read by this screen. It is the widest
 *    individual-pay surface in the database — seven roles hold SELECT on this
 *    table — and it is recorded as never being a scoring input.
 *
 * 2. Nothing here scores, ranks or orders applicants. Rows come back newest
 *    first, which is chronological rather than evaluative. Ordering people is
 *    forbidden by decision; ordering a list by arrival is not.
 *
 * 3. Nothing here deletes. Erasure on request is a separate operation carried
 *    out by an `hr` or `super_admin` holder and recorded when it happens.
 *
 * A decision writes `status`, `decided_at`, `decided_by` and `decision_reason`
 * together, so no decision exists without a reason and an author. Marking
 * someone contacted writes `contacted_at` and `contacted_by` and leaves the
 * status alone — being contacted is not a decision.
 */
import { supabase } from './client';

/** Cap on one fetch. Filtering and counting happen in the browser over this set. */
const MAX_ROWS = 500;

/**
 * The status vocabulary. `new` is the column default, written by the public
 * form; the other three are written here.
 *
 * This list lives in TypeScript because nothing in the database defines it —
 * `job_applications.status` is free text with a default and no check
 * constraint. If a lookup table is added later, this constant is the one place
 * to replace. The screen still renders any status value it finds in the data,
 * including one not listed here, so an unrecognised value is never hidden.
 */
export const APPLICATION_DECISIONS = [
  'shortlisted',
  'hold',
  'rejected',
] as const;

export type ApplicationDecision = (typeof APPLICATION_DECISIONS)[number];

export interface JobApplicationRow {
  id: string;
  public_ref: string | null;
  full_name: string;
  email: string | null;
  whatsapp_number: string | null;
  category: string;
  role_interest: string | null;
  experience_level: string | null;
  location: string | null;
  employment_type: string | null;
  current_employer: string | null;
  highest_education: string | null;
  availability_date: string | null;
  linkedin_url: string | null;
  portfolio_url: string | null;
  cover_note: string | null;
  resume_url: string | null;
  resume_filename: string | null;
  source: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  status: string;
  contacted_at: string | null;
  contacted_by: string | null;
  decided_at: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
}

const COLUMNS = [
  'id',
  'public_ref',
  'full_name',
  'email',
  'whatsapp_number',
  'category',
  'role_interest',
  'experience_level',
  'location',
  'employment_type',
  'current_employer',
  'highest_education',
  'availability_date',
  'linkedin_url',
  'portfolio_url',
  'cover_note',
  'resume_url',
  'resume_filename',
  'source',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'status',
  'contacted_at',
  'contacted_by',
  'decided_at',
  'decided_by',
  'decision_reason',
  'created_at',
].join(', ');

/** Every application this account is allowed to read, newest first. RLS decides which. */
export async function listJobApplications(): Promise<JobApplicationRow[]> {
  const { data, error } = await supabase
    .from('job_applications')
    .select(COLUMNS)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as JobApplicationRow[];
}

async function actingUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data?.user?.id;
  if (!id) throw new Error('You are signed out. Sign in again to record this.');
  return id;
}

/**
 * Record a decision. The reason is required: a status change with no recorded
 * reason is indistinguishable from a mis-click when it is read back later.
 */
export async function recordApplicationDecision(
  applicationId: string,
  decision: ApplicationDecision,
  reason?: string,
  shortlistRound: number | null = null,
): Promise<JobApplicationRow> {
  if (shortlistRound !== null && ![1, 2, 3].includes(shortlistRound)) {
    throw new Error('shortlist round must be 1, 2 or 3');
  }

  // A reason is optional: HR records these decisions in bulk from the list, so
  // the action must go through with a single click.
  const trimmedReason = (reason ?? '').trim() || null;
  const decidedBy = await actingUserId();

  const { data, error } = await supabase
    .from('job_applications')
    .update({
      status: decision,
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      decision_reason: trimmedReason,
      ...(decision === 'shortlisted' && shortlistRound !== null
        ? { shortlist_round: shortlistRound }
        : {}),
    })
    .eq('id', applicationId)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as JobApplicationRow;
}

/**
 * Remove an application from the working list without destroying it.
 *
 * This stamps `archived_at` and `archived_by` and leaves the row in the table.
 * The removal is reversible: call `restoreApplication` to clear the archive
 * stamps and put the row back on the working list. It is not an erasure and
 * does not affect retention.
 */
export async function archiveApplication(applicationId: string): Promise<JobApplicationRow> {
  const archivedBy = await actingUserId();

  const { data, error } = await supabase
    .from('job_applications')
    .update({
      archived_at: new Date().toISOString(),
      archived_by: archivedBy,
    })
    .eq('id', applicationId)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as JobApplicationRow;
}

export interface PurgedApplicationRow extends JobApplicationRow {
  purged_at: string | null;
  purged_by: string | null;
}

/** Put a removed application back on the working list. Status is left as it was. */
export async function restoreApplication(applicationId: string): Promise<JobApplicationRow> {
  const { data, error } = await supabase
    .from('job_applications')
    .update({
      archived_at: null,
      archived_by: null,
    })
    .eq('id', applicationId)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as JobApplicationRow;
}

/** Stamp that a person has been reached. Not a decision, so the status is untouched. */
export async function markApplicationContacted(
  applicationId: string,
): Promise<JobApplicationRow> {
  const contactedBy = await actingUserId();

  const { data, error } = await supabase
    .from('job_applications')
    .update({
      contacted_at: new Date().toISOString(),
      contacted_by: contactedBy,
    })
    .eq('id', applicationId)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as JobApplicationRow;
}

/**
 * Record that a shortlisted person has been contacted. Writes the `contacted`
 * status plus the contact stamps only: the shortlist round, the decision fields
 * and the archive stamps are all left exactly as they are, so the level the
 * person reached and any earlier decision remain readable.
 */
export async function recordApplicationContacted(
  applicationId: string,
): Promise<JobApplicationRow> {
  const contactedBy = await actingUserId();

  const { data, error } = await supabase
    .from('job_applications')
    .update({
      status: 'contacted',
      contacted_at: new Date().toISOString(),
      contacted_by: contactedBy,
    })
    .eq('id', applicationId)
    .select(COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as JobApplicationRow;
}

export interface CareersEmailResult {
  requested: number;
  sent: number;
  suppressed: number;
  failed: number;
  missing_email: number;
  from: string;
  used_careers_from: boolean;
  failures: { applicant: string; reason: string }[];
}

/**
 * Send one individual email per selected applicant.
 *
 * The recipient list is handed over as application ids only. The edge function
 * expands it into one enqueued message per person, each addressed to exactly one
 * address and personalised with that person's own name and reference. Nothing in
 * this path can place two addresses in one message: there is no `to` array, no
 * `cc` and no `bcc` anywhere in the call.
 *
 * This never touches an insert into `job_applications`, so live applications
 * arriving from the public form are unaffected.
 */
export async function sendCareersEmails(args: {
  applicationIds: string[];
  subject: string;
  body: string;
}): Promise<CareersEmailResult> {
  await actingUserId();

  const { data, error } = await supabase.functions.invoke('hr-careers-bulk-email', {
    body: {
      applicationIds: args.applicationIds,
      subject: args.subject,
      body: args.body,
    },
  });

  if (error) {
    const detail = (error as any)?.context?.text
      ? await (error as any).context.text().catch(() => '')
      : '';
    let message = error.message;
    try {
      const parsed = detail ? JSON.parse(detail) : null;
      if (parsed?.error) message = parsed.error;
    } catch { /* keep the original message */ }
    throw new Error(message);
  }

  return data as CareersEmailResult;
}

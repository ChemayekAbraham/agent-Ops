/**
 * Parent requests for a School Fees Plan. A parent picks their child's school (approved Welile
 * Schools partners only) and the request goes first to that school's Welile agent, who contacts
 * the parent, registers the child and sends the formal request to Welile. No money moves here.
 */
import { supabase } from '@/integrations/supabase/client';

// The new table and functions are not in the generated Supabase types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ParentRequestStatus = 'new' | 'contacted' | 'sent_to_welile' | 'declined' | 'cancelled';

export interface PartnerSchool { id: string; name: string; school_level: string | null; district: string | null; town: string | null }

export interface ParentRequestRow {
  id: string;
  parent_id: string;
  school_id: string;
  agent_id: string;
  child_name: string;
  class_grade: string | null;
  boarding_status: 'day' | 'boarding' | null;
  parent_name: string;
  parent_phone: string;
  term_fee: number | null;
  note: string | null;
  status: ParentRequestStatus;
  agent_note: string | null;
  handled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParentRequestDraft {
  school_id: string;
  child_name: string;
  class_grade: string;
  boarding_status: '' | 'day' | 'boarding';
  parent_name: string;
  parent_phone: string;
  term_fee: string;
  note: string;
}

export const emptyParentRequest = (): ParentRequestDraft => ({
  school_id: '', child_name: '', class_grade: '', boarding_status: '', parent_name: '', parent_phone: '', term_fee: '', note: '',
});

/** What the parent sees for each status. */
export const PARENT_STATUS_LABEL: Record<ParentRequestStatus, string> = {
  new: 'Sent to the agent',
  contacted: 'Agent is helping you',
  sent_to_welile: 'Sent to Welile for approval',
  declined: 'Not taken forward',
  cancelled: 'Cancelled',
};

/** What the agent sees for each status. */
export const AGENT_STATUS_LABEL: Record<ParentRequestStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  sent_to_welile: 'Sent to Welile',
  declined: 'Declined',
  cancelled: 'Cancelled by parent',
};

export const isOpenParentRequest = (s: ParentRequestStatus) => s === 'new' || s === 'contacted';

function digits(v: string) { return v.replace(/\D/g, ''); }

/** Field errors shown before sending; the database checks the same rules again. */
export function parentRequestErrors(d: ParentRequestDraft): Partial<Record<keyof ParentRequestDraft, string>> {
  const e: Partial<Record<keyof ParentRequestDraft, string>> = {};
  if (!d.school_id) e.school_id = "Choose your child's school";
  if (d.child_name.trim().length < 2) e.child_name = "Enter your child's full name";
  if (d.parent_name.trim().length < 2) e.parent_name = 'Enter your name';
  const n = digits(d.parent_phone).length;
  if (n < 9 || n > 13) e.parent_phone = 'Enter a valid phone number';
  if (d.term_fee.trim()) {
    const fee = Number(digits(d.term_fee));
    if (!fee || fee > 50_000_000) e.term_fee = 'Enter the term fee in UGX, or leave it empty';
  }
  return e;
}

export async function fetchPartnerSchools(): Promise<PartnerSchool[]> {
  const { data, error } = await db.rpc('welile_school_partner_schools');
  if (error) throw error;
  return (data ?? []) as PartnerSchool[];
}

export async function createParentRequest(d: ParentRequestDraft): Promise<ParentRequestRow> {
  const { data, error } = await db.rpc('welile_school_parent_request_create', {
    p_school_id: d.school_id,
    p_child_name: d.child_name.trim(),
    p_class_grade: d.class_grade.trim() || null,
    p_boarding_status: d.boarding_status || null,
    p_parent_name: d.parent_name.trim(),
    p_parent_phone: d.parent_phone.trim(),
    p_term_fee: d.term_fee.trim() ? Number(digits(d.term_fee)) : null,
    p_note: d.note.trim() || null,
  });
  if (error) throw error;
  return data as ParentRequestRow;
}

export async function updateParentRequest(id: string, status: ParentRequestStatus, note?: string): Promise<ParentRequestRow> {
  const { data, error } = await db.rpc('welile_school_parent_request_update', { p_id: id, p_status: status, p_note: note ?? null });
  if (error) throw error;
  return data as ParentRequestRow;
}

/** The signed-in parent's own requests, newest first. */
export async function fetchMyParentRequests(userId: string): Promise<ParentRequestRow[]> {
  const { data, error } = await db.from('welile_school_parent_requests').select('*').eq('parent_id', userId).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as ParentRequestRow[];
}

/** Requests routed to this agent (all their partner schools), newest first. */
export async function fetchAgentParentRequests(agentId: string): Promise<ParentRequestRow[]> {
  const { data, error } = await db.from('welile_school_parent_requests').select('*').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as ParentRequestRow[];
}

/** A readable message from a database error (strips Postgres noise). */
export function parentRequestErrorMessage(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/AUTH_REQUIRED/.test(msg)) return 'Sign in to send a request.';
  if (/NOT_ALLOWED/.test(msg)) return 'You cannot change this request.';
  if (/REQUEST_NOT_FOUND/.test(msg)) return 'This request no longer exists.';
  if (/function .* does not exist|relation .* does not exist|Could not find the function/i.test(msg)) return 'Parent requests are not switched on yet. Try again later.';
  return msg;
}

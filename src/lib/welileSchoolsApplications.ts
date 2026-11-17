/**
 * School partnership applications. A school owner applies on /schools; Agent Ops assigns a Welile
 * agent to inspect the school (or declines); the agent starts the inspection, which creates the
 * school record, and then carries on with the existing partnership set-up. No money moves here.
 * Every write goes through a SECURITY DEFINER function that checks the caller.
 */
import { supabase } from '@/integrations/supabase/client';
import type { SchoolRow } from '@/lib/welileSchools';

// The new table and functions are not in the generated Supabase types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ApplicationStatus = 'submitted' | 'agent_assigned' | 'inspecting' | 'declined' | 'withdrawn';
export type SchoolOffers = 'day' | 'boarding' | 'day_and_boarding';

export const OFFERS_OPTIONS: { value: SchoolOffers; label: string }[] = [
  { value: 'day', label: 'Day only' },
  { value: 'boarding', label: 'Boarding only' },
  { value: 'day_and_boarding', label: 'Day and boarding' },
];

export const CONTACT_ROLES = ['Owner / Director', 'Head teacher', 'Deputy head teacher', 'Bursar', 'Other'] as const;

export interface ApplicationRow {
  id: string;
  applicant_id: string;
  status: ApplicationStatus;
  school_name: string;
  school_level: string;
  ownership: string | null;
  offers: SchoolOffers | null;
  estimated_enrollment: number | null;
  registration_number: string | null;
  year_founded: number | null;
  country: string;
  region: string | null;
  district: string;
  town: string | null;
  village: string | null;
  directions: string | null;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy_m: number | null;
  contact_name: string;
  contact_role: string | null;
  contact_phone: string;
  contact_email: string | null;
  head_name: string | null;
  head_phone: string | null;
  bursar_name: string | null;
  bursar_phone: string | null;
  note: string | null;
  assigned_agent_id: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  ops_note: string | null;
  decided_at: string | null;
  school_id: string | null;
  inspection_started_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the owner sees about their own application. */
export interface MyApplication {
  id: string;
  status: ApplicationStatus;
  school_name: string;
  school_level: string;
  district: string;
  town: string | null;
  assigned_agent_name: string | null;
  assigned_agent_phone: string | null;
  ops_note: string | null;
  partnership_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationDraft {
  school_name: string;
  school_level: string;
  ownership: string;
  offers: '' | SchoolOffers;
  estimated_enrollment: string;
  registration_number: string;
  year_founded: string;
  region: string;
  district: string;
  town: string;
  village: string;
  directions: string;
  latitude: number | null;
  longitude: number | null;
  gps_accuracy_m: number | null;
  contact_name: string;
  contact_role: string;
  contact_phone: string;
  contact_email: string;
  head_name: string;
  head_phone: string;
  bursar_name: string;
  bursar_phone: string;
  note: string;
}

export const emptyApplication = (): ApplicationDraft => ({
  school_name: '', school_level: '', ownership: '', offers: '', estimated_enrollment: '', registration_number: '', year_founded: '',
  region: '', district: '', town: '', village: '', directions: '', latitude: null, longitude: null, gps_accuracy_m: null,
  contact_name: '', contact_role: '', contact_phone: '', contact_email: '', head_name: '', head_phone: '', bursar_name: '', bursar_phone: '', note: '',
});

/** The owner's view of each stage, including the partnership's own progress once the agent is on it. */
export function ownerStatusLabel(a: Pick<MyApplication, 'status' | 'partnership_status'>): string {
  if (a.status === 'inspecting') {
    switch (a.partnership_status) {
      case 'approved': return 'Partnership approved';
      case 'submitted': return 'Sent to Welile for approval';
      case 'changes_requested': return 'Welile asked the agent for changes';
      case 'rejected': return 'Partnership not approved';
      case 'suspended': return 'Partnership suspended';
      default: return 'Agent is setting up your partnership';
    }
  }
  return OWNER_STATUS_LABEL[a.status];
}

const OWNER_STATUS_LABEL: Record<ApplicationStatus, string> = {
  submitted: 'Received. Welile is reviewing it',
  agent_assigned: 'An agent will visit your school',
  inspecting: 'Agent is setting up your partnership',
  declined: 'Not taken forward',
  withdrawn: 'Withdrawn',
};

/** Agent Ops' view of each stage. */
export const OPS_STATUS_LABEL: Record<ApplicationStatus, string> = {
  submitted: 'New',
  agent_assigned: 'Agent assigned',
  inspecting: 'Inspection started',
  declined: 'Declined',
  withdrawn: 'Withdrawn by school',
};

export const isOpenApplication = (s: ApplicationStatus) => s === 'submitted' || s === 'agent_assigned';

function digits(v: string) { return v.replace(/\D/g, ''); }

/** Field errors shown before sending; the database checks the same rules again. */
export function applicationErrors(d: ApplicationDraft): Partial<Record<keyof ApplicationDraft, string>> {
  const e: Partial<Record<keyof ApplicationDraft, string>> = {};
  if (d.school_name.trim().length < 2) e.school_name = "Enter the school's name";
  if (!d.school_level) e.school_level = 'Choose the school level';
  if (d.district.trim().length < 2) e.district = 'Choose the district';
  if (d.contact_name.trim().length < 2) e.contact_name = 'Enter your name';
  const n = digits(d.contact_phone).length;
  if (n < 9 || n > 13) e.contact_phone = 'Enter a valid phone number';
  for (const k of ['head_phone', 'bursar_phone'] as const) {
    const m = digits(d[k]).length;
    if (d[k].trim() && (m < 9 || m > 13)) e[k] = 'Enter a valid phone number, or leave it empty';
  }
  if (d.estimated_enrollment.trim()) {
    const v = Number(digits(d.estimated_enrollment));
    if (!v || v > 50_000) e.estimated_enrollment = 'Enter the number of students';
  }
  if (d.year_founded.trim()) {
    const y = Number(digits(d.year_founded));
    if (y < 1850 || y > new Date().getFullYear()) e.year_founded = 'Enter the year, e.g. 2005';
  }
  if (d.contact_email.trim() && !/^\S+@\S+\.\S+$/.test(d.contact_email.trim())) e.contact_email = 'Enter a valid email, or leave it empty';
  return e;
}

export async function submitApplication(d: ApplicationDraft): Promise<ApplicationRow> {
  const num = (v: string) => (v.trim() ? Number(digits(v)) : null);
  const { data, error } = await db.rpc('welile_school_application_submit', {
    p: {
      school_name: d.school_name.trim(),
      school_level: d.school_level,
      ownership: d.ownership || null,
      offers: d.offers || null,
      estimated_enrollment: num(d.estimated_enrollment),
      registration_number: d.registration_number.trim() || null,
      year_founded: num(d.year_founded),
      country: 'Uganda',
      region: d.region || null,
      district: d.district.trim(),
      town: d.town.trim() || null,
      village: d.village.trim() || null,
      directions: d.directions.trim() || null,
      latitude: d.latitude,
      longitude: d.longitude,
      gps_accuracy_m: d.gps_accuracy_m,
      contact_name: d.contact_name.trim(),
      contact_role: d.contact_role || null,
      contact_phone: d.contact_phone.trim(),
      contact_email: d.contact_email.trim() || null,
      head_name: d.head_name.trim() || null,
      head_phone: d.head_phone.trim() || null,
      bursar_name: d.bursar_name.trim() || null,
      bursar_phone: d.bursar_phone.trim() || null,
      note: d.note.trim() || null,
    },
  });
  if (error) throw error;
  return data as ApplicationRow;
}

export async function fetchMyApplications(): Promise<MyApplication[]> {
  const { data, error } = await db.rpc('welile_school_application_mine');
  if (error) throw error;
  return (data ?? []) as MyApplication[];
}

export async function withdrawApplication(id: string): Promise<void> {
  const { error } = await db.rpc('welile_school_application_withdraw', { p_id: id });
  if (error) throw error;
}

/** Agent Ops: every application, newest first. */
export async function fetchAllApplications(): Promise<ApplicationRow[]> {
  const { data, error } = await db.from('welile_school_applications').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as ApplicationRow[];
}

export async function reviewApplication(id: string, decision: 'assign' | 'decline', agentId: string | null, note: string | null): Promise<ApplicationRow> {
  const { data, error } = await db.rpc('welile_school_application_review', {
    p_id: id, p_decision: decision, p_agent_id: agentId, p_note: note?.trim() || null,
  });
  if (error) throw error;
  return data as ApplicationRow;
}

export interface AgentCandidate { id: string; full_name: string | null; phone: string | null; schools_in_district: number; schools_total: number }

export async function searchAgentsForApplication(query: string, district: string | null): Promise<AgentCandidate[]> {
  const { data, error } = await db.rpc('welile_school_application_agent_search', { p_query: query, p_district: district });
  if (error) throw error;
  return ((data ?? []) as AgentCandidate[]).map((a) => ({ ...a, schools_in_district: Number(a.schools_in_district), schools_total: Number(a.schools_total) }));
}

/** Applications assigned to this agent that still need a visit or are being set up. */
export async function fetchAgentApplications(agentId: string): Promise<ApplicationRow[]> {
  const { data, error } = await db.from('welile_school_applications').select('*')
    .eq('assigned_agent_id', agentId).in('status', ['agent_assigned', 'inspecting'])
    .order('assigned_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as ApplicationRow[];
}

export async function startInspection(id: string): Promise<SchoolRow> {
  const { data, error } = await db.rpc('welile_school_application_start_inspection', { p_id: id });
  if (error) throw error;
  return data as SchoolRow;
}

/** A readable message from a database error (strips Postgres noise). */
export function applicationErrorMessage(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/AUTH_REQUIRED/.test(msg)) return 'Sign in to continue.';
  if (/NOT_AUTHORIZED/.test(msg)) return 'Only Agent Ops can do this.';
  if (/APPLICATION_NOT_FOUND/.test(msg)) return 'This application no longer exists.';
  if (/function .* does not exist|relation .* does not exist|Could not find the function|PGRST202|schema cache/i.test(msg)) {
    return 'School applications are not switched on yet. Nothing was saved.';
  }
  return msg;
}

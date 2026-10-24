import { supabase } from '@/integrations/supabase/client';

export const SCHOOL_LEVELS = ['Nursery/ECD', 'Primary', 'Secondary/High School', 'TVET/Vocational', 'University/Tertiary'] as const;
export const SCHOOL_OWNERSHIP = ['Government', 'Private', 'Community/Faith-based'] as const;
export const FACILITY_TYPES = ['Classroom Block', 'Lab', 'Library', 'Dormitory', 'Kitchen', 'Water/Solar', 'Bus'] as const;

export const PROFILE_ROLES = [
  { key: 'pupil', label: 'Pupil / Student', group: 'pupil' },
  { key: 'teacher', label: 'Teacher / Lecturer', group: 'teacher' },
  { key: 'head', label: 'Head Teacher / Admin', group: 'staff' },
  { key: 'non_teaching', label: 'Non-Teaching Staff', group: 'staff' },
  { key: 'parent', label: 'Parent / Guardian', group: 'parent' },
  { key: 'supplier', label: 'School Supplier / Vendor', group: 'staff' },
  { key: 'asset', label: 'School Facility / Asset', group: 'asset' },
] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number]['key'];
export type RoleGroup = (typeof PROFILE_ROLES)[number]['group'];

export function roleGroup(role: string): RoleGroup {
  return (PROFILE_ROLES.find((r) => r.key === role)?.group ?? 'staff') as RoleGroup;
}
export function roleLabel(role: string): string {
  return PROFILE_ROLES.find((r) => r.key === role)?.label ?? role;
}

export interface SchoolRow {
  id: string;
  created_by?: string;
  name: string;
  school_level: string;
  ownership?: string | null;
  head_name?: string | null;
  head_phone?: string | null;
  estimated_enrollment?: number | null;
  country: string;
  region?: string | null;
  district?: string | null;
  sub_county?: string | null;
  town?: string | null;
  parish?: string | null;
  village?: string | null;
  gate_name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  gps_accuracy_m?: number | null;
  gps_source?: string | null;
  created_at?: string;
}

export interface SchoolProfileRow {
  id: string;
  school_id: string;
  registered_by?: string;
  client_ref?: string | null;
  role: string;
  full_name?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  age?: number | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  id_number?: string | null;
  class_grade?: string | null;
  stream?: string | null;
  boarding_status?: string | null;
  guardian_name?: string | null;
  guardian_phone?: string | null;
  guardian_whatsapp?: string | null;
  guardian_occupation?: string | null;
  residence_village?: string | null;
  fee_support_need?: boolean | null;
  subject_department?: string | null;
  staff_id?: string | null;
  years_at_school?: number | null;
  next_of_kin?: string | null;
  facility_type?: string | null;
  facility_condition?: string | null;
  facility_capacity?: number | null;
  has_smartphone?: boolean | null;
  signup_link_sent?: boolean;
  signup_link_sent_at?: string | null;
  signup_link_channel?: string | null;
  needs_free_smartphone?: boolean;
  smartphone_contact_phone?: string | null;
  smartphone_handover_point?: string | null;
  smartphone_verification_status?: string | null;
  smartphone_status?: string | null;
  created_at?: string;
}

export function buildSchoolSignupLink(agentId: string, schoolId: string, profileId: string): string {
  const p = new URLSearchParams({ ref: agentId, school: schoolId, profile: profileId });
  return `https://welileapp.com/auth?${p.toString()}`;
}

export function buildSignupMessage(name: string | null | undefined, schoolName: string, link: string): string {
  const who = name?.trim() ? `Hello ${name.trim().split(/\s+/)[0]}` : 'Hello';
  return `${who}, you were registered at ${schoolName} by a Welile agent. Join the Welile App here: ${link}`;
}

/** Normalise a Ugandan-style number to digits for wa.me / sms links (2567XXXXXXXX). */
export function toIntlDigits(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('256')) return d;
  if (d.startsWith('0')) return `256${d.slice(1)}`;
  if (d.length === 9) return `256${d}`;
  return d;
}

/** Smartphone rule: has phone → sign-up link; no phone → free smartphone queue (status Requested). */
export function smartphoneFields(hasSmartphone: boolean | null): Pick<SchoolProfileRow, 'has_smartphone' | 'needs_free_smartphone' | 'smartphone_status'> {
  if (hasSmartphone === false) return { has_smartphone: false, needs_free_smartphone: true, smartphone_status: 'Requested' };
  return { has_smartphone: hasSmartphone, needs_free_smartphone: false, smartphone_status: null };
}

export function mapLink(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps?q=${lat},${lng}`;
}
export function osmLink(lat?: number | null, lng?: number | null): string | null {
  if (lat == null || lng == null) return null;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
}

export function locationPath(s: Partial<SchoolRow>): string {
  return [s.country, s.region, s.district, s.town, s.village].filter(Boolean).join(' → ');
}

/* ---------------- Offline queue (local storage) ---------------- */
const QUEUE_KEY = 'welile-schools-pending-profiles-v1';
const LOCK_KEY = 'welile-schools-locked-school-v1';

export function readPendingProfiles(): SchoolProfileRow[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
export function writePendingProfiles(rows: SchoolProfileRow[]) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(rows)); } catch { /* storage full */ }
}
export function readLockedSchool(): SchoolRow | null {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch { return null; }
}
export function writeLockedSchool(s: SchoolRow | null) {
  try { s ? localStorage.setItem(LOCK_KEY, JSON.stringify(s)) : localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
}

const db = supabase as any;

/** Save a profile; on network failure keep it locally (client_ref makes retries idempotent). */
export async function saveProfile(row: SchoolProfileRow): Promise<{ saved: boolean; row: SchoolProfileRow }> {
  const { id, ...payload } = row;
  const { data, error } = await db.from('welile_school_profiles')
    .upsert({ id, ...payload }, { onConflict: 'client_ref', ignoreDuplicates: false })
    .select().single();
  if (error) {
    writePendingProfiles([...readPendingProfiles().filter((p) => p.client_ref !== row.client_ref), row]);
    return { saved: false, row };
  }
  return { saved: true, row: data as SchoolProfileRow };
}

export async function flushPendingProfiles(): Promise<number> {
  const pending = readPendingProfiles();
  if (!pending.length) return 0;
  const left: SchoolProfileRow[] = [];
  let sent = 0;
  for (const p of pending) {
    if (p.school_id.startsWith('local-')) { left.push(p); continue; }
    const { id, ...payload } = p;
    const { error } = await db.from('welile_school_profiles').upsert({ id, ...payload }, { onConflict: 'client_ref' });
    if (error) left.push(p); else sent++;
  }
  writePendingProfiles(left);
  return sent;
}

export async function markSignupSent(profileId: string, channel: 'whatsapp' | 'sms' | 'copy') {
  await db.from('welile_school_profiles')
    .update({ signup_link_sent: true, signup_link_sent_at: new Date().toISOString(), signup_link_channel: channel })
    .eq('id', profileId);
}

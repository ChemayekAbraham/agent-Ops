import { supabase } from '@/integrations/supabase/client';
import { toIntlDigits as schoolsToIntlDigits, eatDateKey as schoolsEatDateKey, formatEatTime as schoolsFormatEatTime, mapLink as schoolsMapLink, osmLink as schoolsOsmLink } from '@/lib/welileSchools';

export const toIntlDigits = schoolsToIntlDigits;
export const eatDateKey = schoolsEatDateKey;
export const formatEatTime = schoolsFormatEatTime;
export const mapLink = schoolsMapLink;
export const osmLink = schoolsOsmLink;

export const MEDICAL_FACILITY_TYPES = [
  { key: 'hospital', label: '🏥 Hospital' },
  { key: 'clinic', label: '🩺 Clinic' },
  { key: 'pharmacy', label: '💊 Pharmacy' },
  { key: 'medical_center', label: '🏨 Medical Center' },
  { key: 'diagnostic_lab', label: '🧪 Diagnostic Lab' },
  { key: 'health_centre_ii_iii_iv', label: '🏛️ Health Centre II / III / IV' },
  { key: 'maternity_home', label: '🤱 Maternity Home' },
] as const;
export const MEDICAL_OWNERSHIP_OPTIONS = [
  { key: 'government', label: 'Government' },
  { key: 'private', label: 'Private' },
  { key: 'faith_based_ngo', label: 'Faith-based / NGO' },
] as const;
export const MEDICAL_ENTRY_POINTS = ['Main Gate', 'OPD Reception', 'Pharmacy Counter', 'Emergency Entrance', 'Cashier / Receipts Desk'] as const;
export const MEDICAL_DEPARTMENTS = ['OPD', 'Pharmacy', 'Maternity', 'Lab', 'Emergency', 'Inpatient', 'Cashier'] as const;
export const MEDICAL_PROFILE_ROLES = [
  { key: 'patient', label: '🤒 Patient', group: 'patient' },
  { key: 'caregiver_attendant', label: '🤝 Caregiver / Attendant', group: 'visitor' },
  { key: 'doctor_clinician', label: '🩺 Doctor / Clinician', group: 'staff' },
  { key: 'pharmacist_dispenser', label: '💊 Pharmacist / Dispenser', group: 'staff' },
  { key: 'nurse_midwife', label: '👩‍⚕️ Nurse / Midwife', group: 'staff' },
  { key: 'lab_cashier_staff', label: '🧪 Lab / Cashier / Staff', group: 'staff' },
  { key: 'medical_supplier', label: '🚚 Medical Supplier', group: 'visitor' },
  { key: 'facility_asset', label: '🏷️ Facility Asset', group: 'asset' },
] as const;
export const MEDICAL_GATE_ROLES = MEDICAL_PROFILE_ROLES.filter((r) => r.key !== 'facility_asset');
export const VISIT_PURPOSE_PRESETS = ['Consultation / OPD', 'Buying Medicine', 'Lab Test / Scan', 'Maternity / Antenatal', 'Inpatient Visit', 'Drug Restock Delivery', 'Discharged with Receipt'] as const;
export const TX_IN_CATEGORIES = [
  { key: 'pharmacy_medicine', label: 'Pharmacy / Medicine' },
  { key: 'consultation_opd', label: 'Consultation / OPD' },
  { key: 'lab_diagnostics', label: 'Lab / Diagnostics' },
  { key: 'maternity_inpatient', label: 'Maternity / Inpatient' },
  { key: 'insurance_welile_health', label: 'Insurance / Welile Health' },
  { key: 'other_in', label: 'Other IN' },
] as const;
export const TX_OUT_CATEGORIES = [
  { key: 'drug_stock_supplier', label: 'Drug Stock / Supplier' },
  { key: 'medical_equipment', label: 'Medical Equipment' },
  { key: 'staff_allowance', label: 'Staff Allowance' },
  { key: 'facility_utility_rent', label: 'Utility / Rent' },
  { key: 'patient_refund', label: 'Patient Refund' },
  { key: 'other_out', label: 'Other OUT' },
] as const;
export const PAYMENT_METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'mobile_money', label: 'Mobile Money' },
  { key: 'welile_wallet', label: 'Welile Wallet' },
  { key: 'insurance_credit', label: 'Insurance / Credit' },
] as const;
export const MEDICAL_ASSET_TYPES = ['Hospital Bed', 'Wheelchair', 'Oxygen Cylinder', 'Fridge / Cold Chain', 'Ultrasound / Scan', 'Ambulance', 'Solar / Generator'] as const;

export type MedicalGroup = 'patient' | 'staff' | 'visitor' | 'asset';
export function medicalRoleGroup(role: string): MedicalGroup {
  return (MEDICAL_PROFILE_ROLES.find((r) => r.key === role)?.group ?? 'visitor') as MedicalGroup;
}
export function medicalRoleLabel(role: string): string {
  return MEDICAL_PROFILE_ROLES.find((r) => r.key === role)?.label ?? role;
}
export function facilityTypeLabel(t: string): string {
  return MEDICAL_FACILITY_TYPES.find((x) => x.key === t)?.label ?? t;
}
export function ownershipLabel(o: string): string {
  return MEDICAL_OWNERSHIP_OPTIONS.find((x) => x.key === o)?.label ?? o;
}
export function txCategoryLabel(c: string): string {
  return [...TX_IN_CATEGORIES, ...TX_OUT_CATEGORIES].find((x) => x.key === c)?.label ?? c;
}
export function paymentMethodLabel(m: string): string {
  return PAYMENT_METHODS.find((x) => x.key === m)?.label ?? m;
}

export interface MedicalFacilityRow {
  id: string;
  facility_name: string;
  facility_type: string;
  ownership: string;
  country: string;
  region?: string | null;
  district?: string | null;
  sub_county_or_town?: string | null;
  parish_or_ward?: string | null;
  cell_or_village?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy_m?: number | null;
  gps_source?: string | null;
  entry_point_name: string;
  in_charge_name?: string | null;
  in_charge_phone?: string | null;
  approx_daily_patients?: number | null;
  registered_by_agent_id?: string | null;
  registered_by_agent_name?: string | null;
  registered_by_agent_phone?: string | null;
  created_at?: string;
}

export interface MedicalProfileRow {
  id: string;
  client_ref?: string | null;
  facility_id: string;
  role_type: string;
  full_name: string;
  phone?: string | null;
  department_or_ward?: string | null;
  next_of_kin_name?: string | null;
  next_of_kin_phone?: string | null;
  has_smartphone?: boolean | null;
  signup_link_sent?: boolean;
  signup_channel?: string | null;
  smartphone_queue_status: string;
  asset_category?: string | null;
  asset_quantity?: number | null;
  notes?: string | null;
  registered_by_agent_id?: string | null;
  registered_by_agent_name?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy_m?: number | null;
  created_at?: string;
}

export interface MedicalGateLogRow {
  id: string;
  client_ref?: string | null;
  facility_id: string;
  profile_id?: string | null;
  direction: 'in' | 'out';
  person_name: string;
  role_type: string;
  phone?: string | null;
  department_or_ward?: string | null;
  entry_point_name?: string | null;
  visit_purpose_or_note?: string | null;
  attendant_or_kin_name?: string | null;
  attendant_or_kin_phone?: string | null;
  agent_id: string;
  agent_name?: string | null;
  agent_phone?: string | null;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy_m?: number | null;
  recorded_at: string;
}

export interface MedicalTransactionRow {
  id: string;
  client_ref?: string | null;
  facility_id: string;
  profile_id?: string | null;
  gate_log_id?: string | null;
  tx_direction: 'in' | 'out';
  receipt_number: string;
  category: string;
  amount_ugx: number;
  payment_method: string;
  payer_or_payee_name: string;
  payer_or_payee_phone?: string | null;
  items_or_description?: string | null;
  agent_id: string;
  agent_name?: string | null;
  agent_phone?: string | null;
  recorded_at: string;
}

export function generateReceiptNumber(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `WM-RCP-${Array.from(bytes, (b) => chars[b % chars.length]).join('')}`;
}

export function buildMedicineSignupLink(agentId: string, facilityId: string, profileId: string): string {
  const p = new URLSearchParams({ ref: agentId, facility: facilityId, profile: profileId });
  return `https://welileapp.com/auth?${p.toString()}`;
}

export function buildMedicineSignupMessage(name: string | null | undefined, link: string, facilityName: string): string {
  const who = name?.trim() ? `Hello ${name.trim().split(/\s+/)[0]}` : 'Hello';
  return `${who}, you were registered at ${facilityName} by a Welile agent. Join the Welile App here: ${link}`;
}

export function medicineSmartphoneFields(hasSmartphone: boolean): Pick<MedicalProfileRow, 'has_smartphone' | 'smartphone_queue_status'> {
  return { has_smartphone: hasSmartphone, smartphone_queue_status: hasSmartphone ? 'not_needed' : 'queued' };
}

export function facilityLocationPath(f: Partial<MedicalFacilityRow>): string {
  return [f.country, f.region, f.district, f.sub_county_or_town, f.parish_or_ward, f.cell_or_village].filter(Boolean).join(' → ');
}

/* ---------------- Local storage ---------------- */
const LOCK_KEY = 'welile-medicine-locked-facility-v1';
const PROFILE_QUEUE = 'welile-medicine-pending-profiles-v1';
const GATE_QUEUE = 'welile-medicine-pending-gate-logs-v1';
const GATE_LOCAL = 'welile-medicine-gate-logs-v1';
const TX_QUEUE = 'welile-medicine-pending-transactions-v1';
const TX_LOCAL = 'welile-medicine-transactions-v1';

function readJson<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function writeJson(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full */ }
}

export function readLockedFacility(): MedicalFacilityRow | null { return readJson<MedicalFacilityRow | null>(LOCK_KEY, null); }
export function writeLockedFacility(f: MedicalFacilityRow | null) {
  try { f ? localStorage.setItem(LOCK_KEY, JSON.stringify(f)) : localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
}

const db = supabase as any;
const sameRef = (a: { id: string; client_ref?: string | null }, b: { id: string; client_ref?: string | null }) => a.id === b.id || (!!b.client_ref && a.client_ref === b.client_ref);

/* Profiles */
export function readPendingMedicalProfiles(): MedicalProfileRow[] { return readJson(PROFILE_QUEUE, []); }
function writePendingMedicalProfiles(rows: MedicalProfileRow[]) { writeJson(PROFILE_QUEUE, rows); }

export async function saveMedicalProfile(row: MedicalProfileRow): Promise<{ saved: boolean; row: MedicalProfileRow }> {
  const { created_at, ...payload } = row;
  const { data, error } = await db.from('welile_medical_profiles').upsert(payload, { onConflict: 'client_ref' }).select().single();
  if (error) {
    writePendingMedicalProfiles([...readPendingMedicalProfiles().filter((p) => !sameRef(p, row)), row]);
    return { saved: false, row };
  }
  return { saved: true, row: data as MedicalProfileRow };
}
export async function flushPendingMedicalProfiles(): Promise<number> {
  const pending = readPendingMedicalProfiles();
  if (!pending.length) return 0;
  const left: MedicalProfileRow[] = []; let sent = 0;
  for (const p of pending) {
    const { created_at, ...payload } = p;
    const { error } = await db.from('welile_medical_profiles').upsert(payload, { onConflict: 'client_ref' });
    if (error) left.push(p); else sent++;
  }
  writePendingMedicalProfiles(left);
  return sent;
}
export async function markMedicalSignupSent(profileId: string, channel: 'whatsapp' | 'sms' | 'qr') {
  await db.from('welile_medical_profiles').update({ signup_link_sent: true, signup_channel: channel }).eq('id', profileId);
}

/* Gate logs */
export function readPendingMedicalGateLogs(): MedicalGateLogRow[] { return readJson(GATE_QUEUE, []); }
function writePendingMedicalGateLogs(rows: MedicalGateLogRow[]) { writeJson(GATE_QUEUE, rows); }
export function readLocalMedicalGateLogs(facilityId?: string): MedicalGateLogRow[] {
  const all = readJson<MedicalGateLogRow[]>(GATE_LOCAL, []);
  return facilityId ? all.filter((l) => l.facility_id === facilityId) : all;
}
export function writeLocalMedicalGateLogs(rows: MedicalGateLogRow[]) { writeJson(GATE_LOCAL, rows.slice(-2000)); }
function upsertLocalGate(row: MedicalGateLogRow) {
  const all = readLocalMedicalGateLogs();
  const i = all.findIndex((l) => sameRef(l, row));
  if (i >= 0) all[i] = row; else all.push(row);
  writeLocalMedicalGateLogs(all);
}
export async function saveMedicalGateLog(row: MedicalGateLogRow): Promise<{ saved: boolean; row: MedicalGateLogRow }> {
  upsertLocalGate(row);
  const { data, error } = await db.from('welile_medical_gate_logs').upsert(row, { onConflict: 'client_ref' }).select().single();
  if (error) {
    writePendingMedicalGateLogs([...readPendingMedicalGateLogs().filter((l) => !sameRef(l, row)), row]);
    return { saved: false, row };
  }
  upsertLocalGate(data as MedicalGateLogRow);
  return { saved: true, row: data as MedicalGateLogRow };
}
export async function flipMedicalGateLogDirection(log: MedicalGateLogRow): Promise<{ saved: boolean; row: MedicalGateLogRow }> {
  const row: MedicalGateLogRow = { ...log, direction: log.direction === 'in' ? 'out' : 'in' };
  upsertLocalGate(row);
  writePendingMedicalGateLogs(readPendingMedicalGateLogs().map((l) => (sameRef(l, row) ? row : l)));
  const { data, error } = await db.from('welile_medical_gate_logs').update({ direction: row.direction }).eq('id', row.id).select().single();
  if (error) return { saved: false, row };
  upsertLocalGate(data as MedicalGateLogRow);
  return { saved: true, row: data as MedicalGateLogRow };
}
export async function flushPendingMedicalGateLogs(): Promise<number> {
  const pending = readPendingMedicalGateLogs();
  if (!pending.length) return 0;
  const left: MedicalGateLogRow[] = []; let sent = 0;
  for (const l of pending) {
    const { error } = await db.from('welile_medical_gate_logs').upsert(l, { onConflict: 'client_ref' });
    if (error) left.push(l); else sent++;
  }
  writePendingMedicalGateLogs(left);
  return sent;
}

/* Transactions / receipts */
export function readPendingMedicalTransactions(): MedicalTransactionRow[] { return readJson(TX_QUEUE, []); }
function writePendingMedicalTransactions(rows: MedicalTransactionRow[]) { writeJson(TX_QUEUE, rows); }
export function readLocalMedicalTransactions(facilityId?: string): MedicalTransactionRow[] {
  const all = readJson<MedicalTransactionRow[]>(TX_LOCAL, []);
  return facilityId ? all.filter((t) => t.facility_id === facilityId) : all;
}
export function writeLocalMedicalTransactions(rows: MedicalTransactionRow[]) { writeJson(TX_LOCAL, rows.slice(-2000)); }
function upsertLocalTx(row: MedicalTransactionRow) {
  const all = readLocalMedicalTransactions();
  const i = all.findIndex((t) => sameRef(t, row));
  if (i >= 0) all[i] = row; else all.push(row);
  writeLocalMedicalTransactions(all);
}
export async function saveMedicalTransaction(row: MedicalTransactionRow): Promise<{ saved: boolean; row: MedicalTransactionRow }> {
  upsertLocalTx(row);
  const { data, error } = await db.from('welile_medical_transactions').upsert(row, { onConflict: 'client_ref' }).select().single();
  if (error) {
    writePendingMedicalTransactions([...readPendingMedicalTransactions().filter((t) => !sameRef(t, row)), row]);
    return { saved: false, row };
  }
  upsertLocalTx(data as MedicalTransactionRow);
  return { saved: true, row: data as MedicalTransactionRow };
}
export async function flushPendingMedicalTransactions(): Promise<number> {
  const pending = readPendingMedicalTransactions();
  if (!pending.length) return 0;
  const left: MedicalTransactionRow[] = []; let sent = 0;
  for (const t of pending) {
    // A receipt linked to a gate log still waiting to upload must wait for it.
    if (t.gate_log_id && readPendingMedicalGateLogs().some((l) => l.id === t.gate_log_id)) { left.push(t); continue; }
    const { error } = await db.from('welile_medical_transactions').upsert(t, { onConflict: 'client_ref' });
    if (error) left.push(t); else sent++;
  }
  writePendingMedicalTransactions(left);
  return sent;
}

/* ---------------- Daily summaries (East Africa Time) ---------------- */

type GateBucket = 'patient' | 'staff' | 'visitor';
function gateBucket(role: string): GateBucket {
  const g = medicalRoleGroup(role);
  return g === 'asset' ? 'visitor' : g;
}
function personKey(l: MedicalGateLogRow) {
  return l.profile_id || `${l.role_type}:${l.person_name.trim().toLowerCase()}`;
}

export interface MedicalGateSummary {
  todayLogs: MedicalGateLogRow[];
  enteredToday: number;
  exitedToday: number;
  currentlyInside: number;
  byGroup: Record<GateBucket, { in: number; out: number; inside: number }>;
  personStatus: Record<string, { direction: 'in' | 'out'; recorded_at: string; log: MedicalGateLogRow }>;
}

export function computeMedicalGateSummary(logs: MedicalGateLogRow[], now: Date = new Date()): MedicalGateSummary {
  const today = eatDateKey(now);
  const todays = logs.filter((l) => eatDateKey(l.recorded_at) === today);
  const latest = new Map<string, MedicalGateLogRow>();
  [...todays].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at)).forEach((l) => latest.set(personKey(l), l));
  const byGroup: MedicalGateSummary['byGroup'] = { patient: { in: 0, out: 0, inside: 0 }, staff: { in: 0, out: 0, inside: 0 }, visitor: { in: 0, out: 0, inside: 0 } };
  todays.forEach((l) => { byGroup[gateBucket(l.role_type)][l.direction]++; });
  let currentlyInside = 0;
  const personStatus: MedicalGateSummary['personStatus'] = {};
  latest.forEach((log) => {
    if (log.direction === 'in') { currentlyInside++; byGroup[gateBucket(log.role_type)].inside++; }
    const st = { direction: log.direction, recorded_at: log.recorded_at, log };
    if (log.profile_id) personStatus[log.profile_id] = st;
    personStatus[log.person_name.trim().toLowerCase()] = st;
  });
  return {
    todayLogs: [...todays].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)),
    enteredToday: todays.filter((l) => l.direction === 'in').length,
    exitedToday: todays.filter((l) => l.direction === 'out').length,
    currentlyInside, byGroup, personStatus,
  };
}

export interface MedicalTxSummary {
  receiptsInCount: number;
  payoutsOutCount: number;
  totalCountToday: number;
  moneyInTodayUgx: number;
  moneyOutTodayUgx: number;
  netCashflowTodayUgx: number;
  allTimeInUgx: number;
  allTimeOutUgx: number;
  todayTransactions: MedicalTransactionRow[];
}

export function computeMedicalTxSummary(txs: MedicalTransactionRow[], now: Date = new Date()): MedicalTxSummary {
  const today = eatDateKey(now);
  const amt = (t: MedicalTransactionRow) => Number(t.amount_ugx) || 0;
  const todays = txs.filter((t) => eatDateKey(t.recorded_at) === today);
  const sum = (list: MedicalTransactionRow[], dir: 'in' | 'out') => list.filter((t) => t.tx_direction === dir).reduce((s, t) => s + amt(t), 0);
  const moneyIn = sum(todays, 'in');
  const moneyOut = sum(todays, 'out');
  return {
    receiptsInCount: todays.filter((t) => t.tx_direction === 'in').length,
    payoutsOutCount: todays.filter((t) => t.tx_direction === 'out').length,
    totalCountToday: todays.length,
    moneyInTodayUgx: moneyIn,
    moneyOutTodayUgx: moneyOut,
    netCashflowTodayUgx: moneyIn - moneyOut,
    allTimeInUgx: sum(txs, 'in'),
    allTimeOutUgx: sum(txs, 'out'),
    todayTransactions: [...todays].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)),
  };
}

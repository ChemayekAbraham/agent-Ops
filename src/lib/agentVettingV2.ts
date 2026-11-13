/**
 * Agent verification v2 (E78): the home LC1 letter, what is still missing, and when a
 * verification runs out.
 *
 * The database is the judge. `_agent_vetting_v2_missing(p_agent)` lists what the agent
 * still owes, `agent_vetting_gate_status(p_agent_id)` says whether they are verified and
 * until when, and `agent_vetting_save_home_lc1(p_bucket, p_path)` records the letter after
 * it is uploaded. Server messages are shown as they come.
 */
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';
import type { VettingStepKey } from '@/lib/agentVetting';

type UntypedRpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as UntypedRpc).call(supabase, fn, args);

export const HOME_LC1_BUCKET = 'lc-letters';
/** The existing agent agreement screen. */
export const AGENT_AGREEMENT_PATH = '/agent-agreement';
/** Where the agent sets their withdrawal mobile money number and the name on it. */
export const MOBILE_MONEY_SETTINGS_PATH = '/settings?section=account&tab=withdrawal';

/** Storage path for the agent's home LC1 letter; it starts with their own user id. */
export function homeLc1Path(uid: string, now: number = Date.now()): string {
  return `${uid}/vetting/home_lc1_${now}.jpg`;
}

/** A plain error carrying the server's message as it is. */
function serverError(message: unknown, fallback: string): Error {
  return new Error(typeof message === 'string' && message.trim() ? message : fallback);
}

/**
 * Uploads the home LC1 letter, then records it with `agent_vetting_save_home_lc1`.
 * Returns the stored path; throws with the server's message when either step fails.
 */
export async function saveHomeLc1(uid: string, file: File, now: number = Date.now()): Promise<{ bucket: string; path: string }> {
  let upload: File = file;
  try {
    upload = (await optimizeImage(file, { maxWidth: 2000, maxHeight: 2000, quality: 0.85, format: 'image/jpeg' })).file;
  } catch {
    upload = file;
  }
  const path = homeLc1Path(uid, now);
  const { error: upErr } = await supabase.storage
    .from(HOME_LC1_BUCKET)
    .upload(path, upload, { cacheControl: '86400', upsert: false, contentType: upload.type || 'image/jpeg' });
  if (upErr) throw serverError(upErr.message, 'Could not upload the LC1 letter. Please try again.');

  const { data, error } = await rpc('agent_vetting_save_home_lc1', { p_bucket: HOME_LC1_BUCKET, p_path: path });
  if (error) throw serverError(error.message, 'Could not save the LC1 letter. Please try again.');
  const r = (data && typeof data === 'object' ? data : {}) as { success?: boolean; message?: string; error?: string };
  if (r.success === false) throw serverError(r.message ?? r.error, 'Could not save the LC1 letter. Please try again.');
  return { bucket: HOME_LC1_BUCKET, path };
}

const text = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'message', 'text', 'item', 'key']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
    }
  }
  return null;
};

/** The missing list as plain lines: accepts text[], a jsonb array, or `{ missing: [...] }`. */
export function parseV2Missing(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return raw.trim() ? [raw.trim()] : []; }
  }
  if (list && !Array.isArray(list) && typeof list === 'object') list = (list as Record<string, unknown>).missing;
  if (!Array.isArray(list)) return [];
  return list.map(text).filter((t): t is string => !!t);
}

export async function fetchV2Missing(agentId: string): Promise<string[]> {
  const { data, error } = await rpc('_agent_vetting_v2_missing', { p_agent: agentId });
  if (error) throw new Error(error.message);
  return parseV2Missing(data);
}

export type MissingKind = 'home_lc1' | 'agreement' | 'mobile_money' | 'step' | 'other';
export type MissingItem = {
  /** The server's line, shown as it is. */
  text: string;
  kind: MissingKind;
  /** The wizard step that fixes it, for 'home_lc1' and 'step'. */
  step: VettingStepKey | null;
  /** The screen that fixes it, for 'agreement' and 'mobile_money'. */
  href: string | null;
};

/** Which wizard step a server line refers to (v1 wording plus the home LC1 letter). */
export function stepForMissing(line: string): VettingStepKey | null {
  const t = line.toLowerCase();
  if (/\blc\s?1\b|\blc\b|lc letter|local council/.test(t)) return 'home_lc1';
  if (t.includes('phone') && !t.includes('next of kin') && !t.includes('mobile money')) return 'phone';
  if (t.includes('email')) return 'email';
  if (t.includes('next of kin')) return 'next_of_kin';
  if (t.includes('passport') || t.includes('selfie')) return 'passport_photo';
  if (t.includes('national id') || t.includes(' id ') || t.includes('nin')) return 'national_id';
  if (t.includes('location') || t.includes('gps')) return 'location';
  if (t.includes('stay') || t.includes('district') || t.includes('village') || t.includes('residence')) return 'residence';
  return null;
}

export function classifyMissing(line: string): MissingItem {
  const t = line.toLowerCase();
  if (t.includes('agreement')) return { text: line, kind: 'agreement', step: null, href: AGENT_AGREEMENT_PATH };
  if (t.includes('mobile money') || t.includes('momo') || t.includes('mobile_money')) {
    return { text: line, kind: 'mobile_money', step: null, href: MOBILE_MONEY_SETTINGS_PATH };
  }
  const step = stepForMissing(line);
  if (step === 'home_lc1') return { text: line, kind: 'home_lc1', step, href: null };
  if (step) return { text: line, kind: 'step', step, href: null };
  return { text: line, kind: 'other', step: null, href: null };
}

export type GateStatus = {
  enforced: boolean;
  /** e.g. 'verified', 'expired', 'submitted', 'unverified', 'rejected'. */
  status: string | null;
  blocked: boolean;
  /** The server's message; for 'expired' it says how to verify again. */
  reason: string | null;
  expires_at: string | null;
};

export function parseGateStatus(raw: unknown): GateStatus {
  let r: unknown = raw;
  if (Array.isArray(r)) r = r[0];
  const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    enforced: o.enforced === true,
    status: s(o.status),
    blocked: o.blocked === true,
    reason: s(o.reason) ?? s(o.message),
    expires_at: s(o.expires_at),
  };
}

export async function fetchGateStatus(agentId: string): Promise<GateStatus> {
  const { data, error } = await rpc('agent_vetting_gate_status', { p_agent_id: agentId });
  if (error) throw new Error(error.message);
  return parseGateStatus(data);
}

/** "Verified until 12 Nov 2027" in Kampala time, or null when there is no valid date. */
export function verifiedUntilLabel(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime())) return null;
  return `Verified until ${d.toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric' })}`;
}

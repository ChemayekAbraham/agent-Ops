/**
 * Agent vetting — shapes and the checklist the vetting screen shows.
 *
 * Everything comes from `get_my_agent_vetting` (migration 20261027160000).
 * The checklist mirrors what `submit_agent_vetting` checks so the agent can
 * see what is left before pressing Submit; the server re-checks everything
 * and is the only judge. Agent Ops then approves or rejects.
 */

export type VettingStatus = 'unverified' | 'submitted' | 'verified' | 'rejected';

export type VettingStepKey =
  | 'phone'
  | 'email'
  | 'residence'
  | 'location'
  | 'national_id'
  | 'passport_photo'
  | 'next_of_kin';

export type VettingResidence = {
  region: string | null;
  district: string | null;
  sub_county: string | null;
  parish: string | null;
  village: string | null;
  town: string | null;
  city: string | null;
  complete: boolean;
};

export type VettingNationalId = {
  ok: boolean;
  /**
   * The ID the agent is using: the checked source once the ID passes, otherwise
   * the one they chose (e.g. 'parent' while waiting for the parent to approve).
   */
  source: 'own' | 'parent' | null;
  reason: string | null;
  nin_masked: string | null;
  has_front: boolean;
  has_back: boolean;
  can_use_parent: boolean;
  /** Set when the NIN is already held by another account. */
  linked_to: { first_name: string | null; phone_masked: string | null } | null;
  accounts_on_id: number | null;
  /** The agent's own ID on file, for the summary (never the full NIN). */
  name_on_id: string | null;
  /** Storage paths of the agent's own ID photos (sign with identityPhotoUrl to show them). */
  front_path: string | null;
  back_path: string | null;
  front_uploaded_at: string | null;
  back_uploaded_at: string | null;
  /**
   * The account's identity is already verified (identity_already_verified): the ID
   * and selfie on file are final and cannot be sent again, so the step passes as it
   * is and there is no "Replace ID photos".
   */
  identity_verified: boolean;
};

export type AgentVetting = {
  status: VettingStatus;
  review_note: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  enforced: boolean;
  enforce_from: string | null;
  phone: { value: string | null; verified_at: string | null };
  /** null value means no real email on file (synthetic sign-up addresses are hidden). */
  email: { value: string | null; verified_at: string | null };
  residence: VettingResidence;
  gps: { lat: number | null; lng: number | null; accuracy_m: number | null; captured_at: string | null };
  national_id: VettingNationalId;
  passport_photo: { path: string | null; check: unknown };
  next_of_kin: {
    name: string | null;
    phone: string | null;
    relationship: string | null;
    source: 'parent_agent' | 'custom' | null;
  };
  parent_agent: { id: string; name: string | null; phone: string | null } | null;
  gps_rules: { max_accuracy_m: number; max_drift_m: number; max_age_minutes: number };
};

export type VettingStep = {
  key: VettingStepKey;
  label: string;
  done: boolean;
  /** What is left, in words an agent can act on. null when done. */
  hint: string | null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

const STATUSES: VettingStatus[] = ['unverified', 'submitted', 'verified', 'rejected'];
const idSource = (v: unknown): 'own' | 'parent' | null => (v === 'own' || v === 'parent' ? v : null);

export function parseAgentVetting(raw: unknown): AgentVetting {
  const r = obj(raw);
  const phone = obj(r.phone);
  const email = obj(r.email);
  const res = obj(r.residence);
  const gps = obj(r.gps);
  const id = obj(r.national_id);
  const photo = obj(r.passport_photo);
  const nok = obj(r.next_of_kin);
  const parent = r.parent_agent ? obj(r.parent_agent) : null;
  const rules = obj(r.gps_rules);
  const linked = id.linked_to ? obj(id.linked_to) : null;

  return {
    status: STATUSES.includes(r.status) ? r.status : 'unverified',
    review_note: str(r.review_note),
    submitted_at: str(r.submitted_at),
    verified_at: str(r.verified_at),
    enforced: r.enforced === true,
    enforce_from: str(r.enforce_from),
    phone: { value: str(phone.value), verified_at: str(phone.verified_at) },
    email: { value: str(email.value), verified_at: str(email.verified_at) },
    residence: {
      region: str(res.region),
      district: str(res.district),
      sub_county: str(res.sub_county),
      parish: str(res.parish),
      village: str(res.village),
      town: str(res.town),
      city: str(res.city),
      complete: res.complete === true,
    },
    gps: {
      lat: num(gps.lat),
      lng: num(gps.lng),
      accuracy_m: num(gps.accuracy_m),
      captured_at: str(gps.captured_at),
    },
    national_id: {
      ok: id.ok === true,
      source: idSource(id.source) ?? idSource(id.chosen_source),
      reason: str(id.reason),
      nin_masked: str(id.nin_masked),
      has_front: id.has_front === true,
      has_back: id.has_back === true,
      can_use_parent: id.can_use_parent === true,
      linked_to: linked ? { first_name: str(linked.first_name), phone_masked: str(linked.phone_masked) } : null,
      accounts_on_id: num(id.accounts_on_id),
      name_on_id: str(id.name_on_id),
      front_path: str(id.front_path),
      back_path: str(id.back_path),
      front_uploaded_at: str(id.front_uploaded_at),
      back_uploaded_at: str(id.back_uploaded_at),
      identity_verified: id.identity_verified === true,
    },
    passport_photo: { path: str(photo.path), check: photo.check ?? null },
    next_of_kin: {
      name: str(nok.name),
      phone: str(nok.phone),
      relationship: str(nok.relationship),
      source: nok.source === 'parent_agent' || nok.source === 'custom' ? nok.source : null,
    },
    parent_agent: parent && str(parent.id) ? { id: parent.id, name: str(parent.name), phone: str(parent.phone) } : null,
    gps_rules: {
      max_accuracy_m: num(rules.max_accuracy_m) ?? 100,
      max_drift_m: num(rules.max_drift_m) ?? 200,
      max_age_minutes: num(rules.max_age_minutes) ?? 10,
    },
  };
}

const digits = (v: string | null) => (v ?? '').replace(/\D/g, '');

/** True when the captured location is still fresh enough to submit with. */
export function isLocationFresh(v: AgentVetting, now: Date = new Date()): boolean {
  if (!v.gps.captured_at || v.gps.lat === null || v.gps.lng === null) return false;
  const ageMs = now.getTime() - new Date(v.gps.captured_at).getTime();
  return ageMs >= 0 && ageMs <= v.gps_rules.max_age_minutes * 60_000;
}

/** The steps in the order the screen shows them. */
export function vettingChecklist(v: AgentVetting, now: Date = new Date()): VettingStep[] {
  const step = (key: VettingStepKey, label: string, done: boolean, hint: string): VettingStep => ({
    key,
    label,
    done,
    hint: done ? null : hint,
  });

  const residenceDone = !!v.residence.district && !!v.residence.village;
  const nokDone = !!v.next_of_kin.name && digits(v.next_of_kin.phone).length >= 9;

  let locationHint = 'Press "Capture my location" where you are.';
  if (v.gps.captured_at && !isLocationFresh(v, now)) {
    locationHint = 'Your captured location is too old. Capture it again, then submit.';
  }

  return [
    step('phone', 'Phone number', !!v.phone.verified_at, 'Confirm your phone number with the code we send.'),
    step(
      'email',
      'Email address',
      !!v.email.verified_at,
      v.email.value
        ? 'Confirm your email address with the code we send.'
        : 'Add your own email address and confirm it with the code we send.',
    ),
    step('residence', 'Where you stay', residenceDone, 'Add where you stay (at least district and village).'),
    step('location', 'Live location', isLocationFresh(v, now), locationHint),
    step('national_id', 'National ID', v.national_id.ok, v.national_id.reason ?? 'Add your National ID.'),
    step('passport_photo', 'Passport photo', !!v.passport_photo.path, 'Take your passport photo.'),
    step('next_of_kin', 'Next of kin', nokDone, "Add your next of kin's name and phone number."),
  ];
}

export function vettingProgress(steps: VettingStep[]) {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, complete: done === steps.length };
}

/** Agents can edit while unverified or rejected; editing a verified record sends it back for review. */
export function canEditVetting(status: VettingStatus): boolean {
  return status !== 'submitted';
}

export type IdOnFilePart = 'number' | 'front' | 'back';

/**
 * What the agent's own National ID on file looks like, for the Identity step:
 * `complete` shows the summary, `partial` shows the summary plus an upload for
 * each missing part, `none` shows the capture flow. Changing details means
 * uploading new photos; the number and name are read from the card.
 * `locked`: the identity is already verified, so the ID on file is final; show
 * the summary as verified, with no upload or replace (and nothing "missing").
 */
export function nationalIdOnFile(id: VettingNationalId): { state: 'complete' | 'partial' | 'none'; missing: IdOnFilePart[]; locked: boolean } {
  if (id.identity_verified) return { state: 'complete', missing: [], locked: true };
  const missing: IdOnFilePart[] = [];
  if (!id.nin_masked) missing.push('number');
  if (!id.has_front) missing.push('front');
  if (!id.has_back) missing.push('back');
  const state = missing.length === 0 ? 'complete' : missing.length === 3 ? 'none' : 'partial';
  return { state, missing, locked: false };
}

export type IdSnapshot = {
  source: 'own' | 'parent' | null;
  nin_masked: string | null;
  name: string | null;
  front_path: string | null;
  back_path: string | null;
  captured_at: string | null;
};

/**
 * The ID Agent Ops is reviewing and, when the agent replaced it, the one Agent
 * Ops last decided on (agent_vetting.prev_id_*), from agent_vetting_detail.
 */
export function idComparison(detail: Record<string, unknown> | null | undefined): {
  current: IdSnapshot;
  previous: IdSnapshot | null;
  changed_at: string | null;
} {
  const d = obj(detail);
  const snap = (p: '' | 'prev_'): IdSnapshot => ({
    source: idSource(d[`${p}id_source`]),
    nin_masked: str(d[`${p}id_nin_masked`]),
    name: str(d[`${p}id_name`]),
    front_path: str(d[`${p}id_front_path`]),
    back_path: str(d[`${p}id_back_path`]),
    captured_at: str(d[`${p}id_captured_at`]),
  });
  const previous = snap('prev_');
  const hasPrevious = !!(previous.nin_masked || previous.front_path || previous.back_path);
  return { current: snap(''), previous: hasPrevious ? previous : null, changed_at: hasPrevious ? str(d.id_changed_at) : null };
}

export const VETTING_STATUS_LABEL: Record<VettingStatus, string> = {
  unverified: 'Not verified',
  submitted: 'With Agent Ops for review',
  verified: 'Verified',
  rejected: 'Sent back by Agent Ops',
};

/**
 * The rent_requests trigger raises `AGENT_NOT_VETTED: <reason>`; register-tenant
 * answers `{ code: 'agent_not_vetted', error }`. Returns the plain reason, or null.
 */
export function agentNotVettedReason(err: unknown): string | null {
  const e = obj(err);
  if (e.code === 'agent_not_vetted') return str(e.error) ?? str(e.message);
  const msg = typeof err === 'string' ? err : str(e.message) ?? '';
  const m = /AGENT_NOT_VETTED:\s*(.+)$/s.exec(msg);
  return m ? m[1].trim() : null;
}

export type VettingQueueRow = {
  agent_id: string;
  name: string | null;
  phone: string | null;
  district: string | null;
  status: VettingStatus;
  in_scope: boolean;
  id_source: 'own' | 'parent' | null;
  submitted_at: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};

export type VettingQueue = {
  total: number;
  rows: VettingQueueRow[];
  counts: Record<VettingStatus, number>;
};

export function parseVettingQueue(raw: unknown): VettingQueue {
  const r = obj(raw);
  const counts = obj(r.counts);
  const rows = Array.isArray(r.rows) ? r.rows : [];
  return {
    total: num(r.total) ?? 0,
    rows: rows.map((x: unknown) => {
      const o = obj(x);
      return {
        agent_id: String(o.agent_id),
        name: str(o.name),
        phone: str(o.phone),
        district: str(o.district),
        status: STATUSES.includes(o.status) ? o.status : 'unverified',
        in_scope: o.in_scope === true,
        id_source: o.id_source === 'own' || o.id_source === 'parent' ? o.id_source : null,
        submitted_at: str(o.submitted_at),
        reviewed_at: str(o.reviewed_at),
        review_note: str(o.review_note),
      };
    }),
    counts: {
      unverified: num(counts.unverified) ?? 0,
      submitted: num(counts.submitted) ?? 0,
      verified: num(counts.verified) ?? 0,
      rejected: num(counts.rejected) ?? 0,
    },
  };
}

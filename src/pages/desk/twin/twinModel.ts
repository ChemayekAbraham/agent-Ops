/**
 * The Welile digital twin (/desk/twin): how the company ran the last 24 hours.
 *
 * The database builds it (ops_twin_now live; a run saved daily at 08:00 EAT,
 * read through ops_twin_day and ops_twin_history) and this page only reads it.
 * This file holds the payload contract and every pure helper — river stations and panels, lanes, redaction,
 * reconstructed days, the map layout, ordering — so they are testable without
 * a browser. Every string here is rendered as text, never as HTML.
 */

export type NodeStatus = 'verified' | 'partial' | 'gap' | 'draft' | 'not_started';
export const STATUS_ORDER: NodeStatus[] = ['verified', 'partial', 'gap', 'draft', 'not_started'];
export const STATUS_LABEL: Record<NodeStatus, string> = {
  verified: 'Verified',
  partial: 'Partial',
  gap: 'Gap',
  draft: 'Draft',
  not_started: 'Not started',
};

export type LaneKey = 'pipeline' | 'partner' | 'landlord' | 'collections' | 'money' | 'controls';
export const LANE_KEYS: LaneKey[] = ['pipeline', 'partner', 'landlord', 'collections', 'money', 'controls'];
/** The lane bar's short names, in order. */
export const LANE_SHORT: Record<LaneKey, string> = {
  pipeline: 'Rent pipeline',
  partner: 'Funders and partners',
  landlord: 'Landlord payment',
  collections: 'Collections',
  money: 'Money and ledger',
  controls: 'Controls',
};
export const isLaneKey = (v: unknown): v is LaneKey => typeof v === 'string' && (LANE_KEYS as string[]).includes(v);

export type TwinNode = {
  id: string;
  name: string;
  kind: 'object' | 'action';
  family: string;
  owner: string;
  status: NodeStatus;
  baseline: NodeStatus | null;
  source: string;
  note: string;
  /** For an action: the object it changes. */
  on: string | null;
  checks: string[];
  failed: string[];
  lane: string;
};
export type TwinLink = { id: string; from: string; to: string; label: string };
export type TwinCheck = {
  key: string;
  label: string;
  value: number | null;
  ok: boolean;
  severity: 'gap' | 'watch';
  detail: string | null;
  rec: string;
  lane: string;
  owner: string;
};
export type TwinNeed = {
  id: string;
  question: string;
  lean: string;
  source: string;
  lane: string;
  kind: 'decision' | 'rule';
  /** 1 = answer first. Missing sorts last. */
  priority: number | null;
  evidence: string;
  /** Node ids this decision affects. */
  nodes: string[];
};
/** A decision already made and in force. */
export type TwinRuling = {
  id: string;
  question: string;
  ruling: string;
  lane: string;
  kind: 'decision' | 'rule';
  /** Node ids the ruling applies to. */
  nodes: string[];
  source: string;
  decidedAt: string | null;
};
export type TwinMetric = { label: string; value: number | null; unit: string };
export type TwinLane = {
  key: string;
  label: string;
  owner: string;
  note: string;
  nodes: number;
  verified: number;
  partial: number;
  gap: number;
  draft: number;
  not_started: number;
  checks: number;
  failed: number;
  gap_failed: number;
  metrics: TwinMetric[];
};
export type TwinFlow = {
  from: string;
  to: string;
  lane: string;
  dir: 'fwd' | 'back';
  n: number;
  ugx: number;
  no_actor: number;
  actors: number;
  first: string;
  last: string;
};
export type TwinDesk = { desk: string; acted: number; queue: number };
export type TwinQueue = { status: string; n: number; ugx: number };
export type Nums = Record<string, number | null>;

export type TwinPayload = {
  windowLabel: string;
  windowStart: string | null;
  windowEnd: string | null;
  generatedAt: string | null;
  durationMs: number | null;
  source: string;
  /** A day rebuilt after the fact: no nodes, queues or totals; `note` says why. */
  reconstructed: boolean;
  note: string;
  /** 24 hour labels (EAT); hours[0] is the first bucket. */
  hours: string[];
  queues: TwinQueue[];
  desks: TwinDesk[];
  flow: TwinFlow[];
  /** "lane|fwd", "lane|back", "name|money", "name|partner" → 24 counts. */
  hourly: Record<string, number[]>;
  kpis: Nums;
  money: Nums;
  partner: Nums;
  partnerState: Nums;
  governance: Nums;
  chain30: Nums;
  totals: Nums;
  nodes: TwinNode[];
  links: TwinLink[];
  checks: TwinCheck[];
  needs: TwinNeed[];
  rulings: TwinRuling[];
  lanes: TwinLane[];
  /** Lanes whose detail the server withheld from this viewer (today only 'partner'). */
  redacted: string[];
  errors: string[];
};

export type HistoryDay = {
  runId: string;
  runAt: string;
  day: string;
  source: string;
  reconstructed: boolean;
  windowLabel: string;
  totals: Nums;
  kpis: Nums;
  money: Nums;
  checksFailed: number | null;
};

/** One read: a saved run (runId set) or live (runId null). */
export type Twin = {
  runId: string | null;
  runAt: string | null;
  live: boolean;
  source: string;
  payload: TwinPayload;
  /** From ops_twin_latest / ops_twin_board: the last runs, for the trend line. */
  history: HistoryDay[];
  /** From ops_twin_now: the newest saved run, so the header can say what the 08:00 run was. */
  lastOfficial: { runId: string; runAt: string; windowLabel: string } | null;
  /** The payload exactly as the server sent it, for the offline copy. */
  raw: unknown;
};

// ---------------------------------------------------------------- copy

/**
 * Regulatory wording for text that comes from the database: "Returns", never
 * "ROI". Applied to every server string the page shows.
 */
export function copy(text: string): string {
  if (!text) return text;
  return text.replace(/\bROI\b/g, (_m, at: number) => (at === 0 || /[.!?]\s*$/.test(text.slice(0, at)) ? 'Returns' : 'returns'));
}

/** Every string inside a JSON value in the regulatory wording; keys untouched. For the offline copy. */
export function copyDeep(v: unknown): unknown {
  if (typeof v === 'string') return copy(v);
  if (Array.isArray(v)) return v.map(copyDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, copyDeep(x)]));
  return v;
}

// ---------------------------------------------------------------- parsing

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const nums = (v: unknown): Nums => {
  const out: Nums = {};
  for (const [k, x] of Object.entries(obj(v))) out[k] = num(x);
  return out;
};
const isStatus = (v: unknown): v is NodeStatus => typeof v === 'string' && (STATUS_ORDER as string[]).includes(v);
const strs = (v: unknown): string[] => arr(v).map(str).filter(Boolean);
/** Text a person reads: in the regulatory wording (see copy). */
const txt = (v: unknown): string => copy(str(v));

function readPayload(value: unknown, reconstructedHint: boolean): TwinPayload {
  const p = obj(value);
  const hourly: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(obj(p.hourly))) {
    hourly[k] = Array.from({ length: 24 }, (_, i) => Math.max(0, num(arr(v)[i]) ?? 0));
  }
  return {
    windowLabel: str(p.window_label),
    windowStart: p.window_start ? str(p.window_start) : null,
    windowEnd: p.window_end ? str(p.window_end) : null,
    generatedAt: p.generated_at ? str(p.generated_at) : null,
    durationMs: num(p.duration_ms),
    source: str(p.source),
    reconstructed: reconstructedHint || p.reconstructed === true || p.source === 'reconstructed',
    note: txt(p.note),
    hours: Array.from({ length: 24 }, (_, i) => str(arr(p.hours)[i])),
    queues: arr(p.queues).map((x) => ({ status: str(obj(x).status), n: num(obj(x).n) ?? 0, ugx: num(obj(x).ugx) ?? 0 })),
    desks: arr(p.desks).map((x) => ({ desk: str(obj(x).desk), acted: num(obj(x).acted) ?? 0, queue: num(obj(x).queue) ?? 0 })),
    flow: arr(p.flow).map((x) => {
      const f = obj(x);
      return {
        from: str(f.from) || 'new',
        to: str(f.to),
        lane: str(f.lane),
        dir: f.dir === 'back' ? 'back' : 'fwd',
        n: num(f.n) ?? 0,
        ugx: num(f.ugx) ?? 0,
        no_actor: num(f.no_actor) ?? 0,
        actors: num(f.actors) ?? 0,
        first: str(f.first),
        last: str(f.last),
      } as TwinFlow;
    }),
    hourly,
    kpis: nums(p.kpis),
    money: nums(p.money),
    partner: nums(p.partner),
    partnerState: nums(p.partner_state),
    governance: nums(p.governance),
    chain30: nums(p.chain30),
    totals: nums(p.totals),
    nodes: arr(p.nodes)
      .map((x): TwinNode => {
        const n = obj(x);
        return {
          id: str(n.id),
          name: txt(n.name) || str(n.id),
          kind: n.kind === 'action' ? 'action' : 'object',
          family: str(n.family),
          owner: txt(n.owner),
          status: isStatus(n.status) ? n.status : 'not_started',
          baseline: isStatus(n.baseline) ? n.baseline : null,
          source: str(n.source),
          note: txt(n.note),
          on: n.on ? str(n.on) : null,
          checks: strs(n.checks),
          failed: strs(n.failed),
          lane: str(n.lane),
        };
      })
      .filter((n) => n.id),
    links: arr(p.links)
      .map((x, i) => ({ id: str(obj(x).id) || String(i + 1), from: str(obj(x).from), to: str(obj(x).to), label: txt(obj(x).label) }))
      .filter((l) => l.from && l.to),
    checks: arr(p.checks).map((x): TwinCheck => {
      const c = obj(x);
      return {
        key: str(c.key),
        label: txt(c.label) || str(c.key),
        value: num(c.value),
        ok: c.ok === true,
        severity: c.severity === 'gap' ? 'gap' : 'watch',
        detail: c.detail ? txt(c.detail) : null,
        rec: txt(c.rec),
        lane: str(c.lane),
        owner: txt(c.owner),
      };
    }),
    needs: arr(p.needs).map((x, i): TwinNeed => {
      const n = obj(x);
      return {
        id: str(n.id) || String(i + 1),
        question: txt(n.question),
        lean: txt(n.lean),
        source: txt(n.source),
        lane: str(n.lane),
        kind: n.kind === 'rule' ? 'rule' : 'decision',
        priority: num(n.priority),
        evidence: txt(n.evidence),
        nodes: strs(n.nodes),
      };
    }),
    rulings: arr(p.rulings).map((x, i): TwinRuling => {
      const r = obj(x);
      return {
        id: str(r.id) || String(i + 1),
        question: txt(r.question),
        ruling: txt(r.ruling),
        lane: str(r.lane),
        kind: r.kind === 'rule' ? 'rule' : 'decision',
        nodes: strs(r.nodes),
        source: txt(r.source),
        decidedAt: str(r.decided_at) || null,
      };
    }),
    lanes: arr(p.lanes).map((x): TwinLane => {
      const l = obj(x);
      const n = (k: string) => num(l[k]) ?? 0;
      return {
        key: str(l.key),
        label: txt(l.label) || str(l.key),
        owner: txt(l.owner),
        note: txt(l.note),
        nodes: n('nodes'),
        verified: n('verified'),
        partial: n('partial'),
        gap: n('gap'),
        draft: n('draft'),
        not_started: n('not_started'),
        checks: n('checks'),
        failed: n('failed'),
        gap_failed: n('gap_failed'),
        metrics: arr(l.metrics).map((m) => ({ label: txt(obj(m).label), value: num(obj(m).value), unit: str(obj(m).unit) })),
      };
    }),
    redacted: strs(p.redacted),
    errors: arr(p.errors).map((e) => str(obj(e).section) || str(e)).filter(Boolean),
  };
}

export function readHistory(value: unknown): HistoryDay[] {
  return arr(value).map((x) => {
    const h = obj(x);
    return {
      runId: str(h.run_id),
      runAt: str(h.run_at),
      day: str(h.day) || (h.window_end ? str(h.window_end).slice(0, 10) : ''),
      source: str(h.source),
      reconstructed: h.reconstructed === true || h.source === 'reconstructed',
      windowLabel: str(h.window_label),
      totals: nums(h.totals),
      kpis: nums(h.kpis),
      money: nums(h.money),
      checksFailed: num(h.checks_failed),
    };
  });
}

/** Whitelist any of the twin reads (now, latest, day, board). Null when there is no run. */
export function readTwin(value: unknown): Twin | null {
  const raw = obj(value);
  if (!raw.payload) return null;
  const lo = obj(raw.last_official);
  const reconstructed = raw.reconstructed === true || raw.source === 'reconstructed';
  return {
    runId: raw.run_id === null || raw.run_id === undefined ? null : str(raw.run_id),
    runAt: raw.run_at ? str(raw.run_at) : null,
    live: raw.live === true || raw.run_id === null || raw.run_id === undefined,
    source: str(raw.source) || str(obj(raw.payload).source),
    payload: readPayload(raw.payload, reconstructed),
    history: readHistory(raw.history),
    lastOfficial: lo.run_id ? { runId: str(lo.run_id), runAt: str(lo.run_at), windowLabel: str(lo.window_label) } : null,
    raw: raw.payload,
  };
}

// ---------------------------------------------------------------- what is on screen

export const eatTime = (iso: string | number | Date | null) => {
  if (iso === null) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit' });
};

/** The header line: "Live, updated HH:MM EAT" or "Saved run N, <window_label>". */
export function screenLabel(t: Twin, loadedAt: number | null): string {
  if (t.runId === null) return `Live, updated ${eatTime(loadedAt ?? t.runAt)} EAT`;
  return `Saved run ${t.runId}, ${t.payload.windowLabel}`;
}

export const isRedacted = (p: TwinPayload, lane: string) => p.redacted.includes(lane);
export const PARTNER_LIMITED = 'Partner detail is limited to the COO, CEO and CFO';

/** The sections a view shows, in order. Reconstructed days keep only what was recorded. */
export type Section = 'ribbon' | 'tiles' | 'map' | 'checks' | 'health' | 'needs' | 'rulings' | 'nodes' | 'links' | 'lanehead' | 'tables' | 'money' | 'partner';
/** Reconstructed days have no lanes to open: the river, money, partner flows and checks, whatever view was asked for. */
export function sectionsFor(view: 'company' | LaneKey, reconstructed: boolean): Section[] {
  if (reconstructed) return ['money', 'partner', 'checks'];
  return view === 'company'
    ? ['ribbon', 'tiles', 'map', 'checks', 'health', 'needs', 'rulings', 'nodes', 'links']
    : ['lanehead', 'checks', 'map', 'tables', 'nodes', 'links'];
}

// ---------------------------------------------------------------- lanes

export type LaneState = 'gap' | 'partial' | 'verified';
export function laneState(l: Pick<TwinLane, 'failed' | 'gap_failed'>): LaneState {
  return l.gap_failed > 0 ? 'gap' : l.failed > 0 ? 'partial' : 'verified';
}

/** The lane bar: Company, then every lane in the payload's order; red badge = gap_failed, amber = failed. */
export function laneTabs(p: TwinPayload): { key: 'company' | string; label: string; badge: { n: number; tone: 'gap' | 'watch' } | null }[] {
  const lanes = [...p.lanes].sort((a, b) => {
    const ia = LANE_KEYS.indexOf(a.key as LaneKey);
    const ib = LANE_KEYS.indexOf(b.key as LaneKey);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return [
    { key: 'company', label: 'Company', badge: null },
    ...lanes.map((l) => ({
      key: l.key,
      label: isLaneKey(l.key) ? LANE_SHORT[l.key] : copy(l.label),
      badge: l.gap_failed > 0 ? { n: l.gap_failed, tone: 'gap' as const } : l.failed > 0 ? { n: l.failed, tone: 'watch' as const } : null,
    })),
  ];
}

export function metricValue(m: TwinMetric): string {
  if (m.value === null) return '—';
  if (m.unit === 'ugx') return ugx(m.value);
  if (m.unit === 'pct') return `${m.value}%`;
  if (m.unit === 'days') return `${m.value} days`;
  return int(m.value);
}

export const laneChecks = (p: TwinPayload, lane: string | null) => p.checks.filter((c) => !lane || c.lane === lane);
export const laneNodes = (p: TwinPayload, lane: string | null) => p.nodes.filter((n) => !lane || n.lane === lane);
/** Links that touch the lane (either end). */
export function laneLinks(p: TwinPayload, lane: string | null): TwinLink[] {
  if (!lane) return p.links;
  const ids = new Set(laneNodes(p, lane).map((n) => n.id));
  return p.links.filter((l) => ids.has(l.from) || ids.has(l.to));
}

/** The desk where action on a node is taken: by its owner first, else its lane. */
const OWNER_DESK: [RegExp, string][] = [
  [/service cent(re|er)/i, 'service-centre'],
  [/agent ops/i, 'agent-ops'],
  [/tenant ops/i, 'tenant-ops'],
  [/landlord ops/i, 'landlord-ops'],
  [/partner ops/i, 'partner-ops'],
  [/customer care/i, 'customer-care'],
  [/\b(cfo|finops|funder)/i, 'cfo'],
  [/\bcoo\b/i, 'coo'],
];
const LANE_DESK: Record<string, string> = {
  pipeline: 'coo',
  partner: 'partner-ops',
  landlord: 'landlord-ops',
  collections: 'tenant-ops',
  money: 'cfo',
  controls: 'ontology',
};
export const DESK_NAME: Record<string, string> = {
  'service-centre': 'Service Centre',
  'agent-ops': 'Agent Ops',
  'tenant-ops': 'Tenant Ops',
  'landlord-ops': 'Landlord Ops',
  'partner-ops': 'Partner Ops',
  'customer-care': 'Customer Care',
  cfo: 'Funders',
  coo: 'COO',
  ontology: 'Ontology',
};
export function deskForNode(n: Pick<TwinNode, 'owner' | 'lane'>): string | null {
  for (const [re, desk] of OWNER_DESK) if (re.test(n.owner)) return desk;
  return LANE_DESK[n.lane] ?? null;
}

// ---------------------------------------------------------------- the river

export type Station = {
  key: string;
  label: string;
  /** Queue statuses whose count is "waiting now" here. */
  q: string[];
  /** Flow `from` statuses that leave this station. */
  from: string[];
  /** The name this desk has in the stage_overdue check's detail. */
  overdue: string | null;
  checks: string[];
  nodes: string[];
  lane: LaneKey;
};

export const STATIONS: Station[] = [
  { key: 'agents', label: 'Agents submit', q: [], from: ['new'], overdue: null, checks: ['bursts'], nodes: ['O6', 'A1', 'A2'], lane: 'pipeline' },
  { key: 'sc', label: 'Service Centre', q: ['service_center_review'], from: ['service_center_review'], overdue: 'Service Centre', checks: ['sc_review_no_staff_id', 'sc_duplicate_reviews', 'sc_backlog'], nodes: ['O7', 'A4', 'A5'], lane: 'pipeline' },
  { key: 'ao', label: 'Agent Ops', q: ['pending'], from: ['pending'], overdue: 'Agent Ops', checks: ['desk_evidence_agent_ops', 'stale_freezes'], nodes: ['A6', 'A7', 'O39'], lane: 'pipeline' },
  { key: 'to', label: 'Tenant Ops', q: ['agent_ops_approved'], from: ['agent_ops_approved'], overdue: 'Tenant Ops', checks: ['desk_evidence_tenant_ops'], nodes: ['A9', 'A10', 'O38'], lane: 'pipeline' },
  // _ops_twin_lane puts tenant_ops_approved and landlord_ops_approved both in the landlord_ops lane.
  { key: 'lo', label: 'Landlord Ops', q: ['tenant_ops_approved', 'landlord_ops_approved'], from: ['tenant_ops_approved', 'landlord_ops_approved'], overdue: 'Landlord Ops', checks: ['desk_evidence_landlord_ops', 'funded_unverified_landlord'], nodes: ['A11', 'A12', 'O9'], lane: 'pipeline' },
  { key: 'coo', label: 'COO', q: ['partner_ops_approved'], from: ['partner_ops_approved'], overdue: 'COO', checks: ['other_desk_at_coo', 'self_acting', 'serious_concern_on_board', 'desk_heartbeat'], nodes: ['A14', 'A15', 'A16', 'O17'], lane: 'pipeline' },
  { key: 'fb', label: 'Funders board', q: ['coo_approved'], from: ['coo_approved'], overdue: 'Funders board', checks: ['funded_no_funder', 'no_actor_moves'], nodes: ['O14', 'A21', 'O12'], lane: 'pipeline' },
  { key: 'funded', label: 'Funded, paying landlord', q: ['funded'], from: ['funded'], overdue: null, checks: ['payout_late', 'payout_failed_24h', 'recall_no_actor', 'payouts_awaiting_receipt'], nodes: ['O22', 'O21', 'A24', 'A23'], lane: 'landlord' },
  { key: 'rep', label: 'Repaying', q: ['repaying'], from: ['repaying'], overdue: null, checks: [], nodes: ['O2', 'A26', 'A27'], lane: 'collections' },
];
export const POOL_STATUSES = ['rejected', 'cancelled', 'deleted_by_agent'];
const POOL_INFO = { checks: ['bursts', 'recall_no_actor'], nodes: ['O1', 'A2'], lane: 'pipeline' as LaneKey };

/** The station a lane leaves from (see _ops_twin_lane). Forward moves go one station right. */
export const LANE_FROM: Record<string, number> = {
  submit: 0,
  service_centre: 1,
  agent_ops: 2,
  tenant_ops: 3,
  landlord_ops: 4,
  coo: 5,
  funding: 6,
  plan_live: 7,
  recall: 7,
  repayment: 8,
  other: 1,
};

/** Where a request with this status sits on the river (for a live stage event). */
export function stopOfStatus(status: string | null | undefined): Stop {
  const s = status ?? 'new';
  if (s === 'completed') return 'end';
  if (POOL_STATUSES.includes(s)) return 'pool';
  const i = STATIONS.findIndex((st) => st.from.includes(s));
  return i >= 0 ? i : 0;
}

export function waitingNow(queues: TwinQueue[]): { n: number; ugx: number }[] {
  return STATIONS.map((s) =>
    queues.filter((q) => s.q.includes(q.status)).reduce((t, q) => ({ n: t.n + q.n, ugx: t.ugx + q.ugx }), { n: 0, ugx: 0 }),
  );
}

/** "pool" is the sent-back / rejected / recalled basin under the river; "end" is off the right edge (completed). */
export type Stop = number | 'pool' | 'end';
export type Dot = { start: number; dur: number; from: Stop; to: Stop; kind: 'fwd' | 'back'; jitter: number };

/** One dot per stage move, spread through its hour. Money and partner keys are drawn as the money strip. */
export function buildDots(hourly: Record<string, number[]>): Dot[] {
  const dots: Dot[] = [];
  for (const key of Object.keys(hourly).sort()) {
    const [lane, dir] = key.split('|');
    if (dir !== 'fwd' && dir !== 'back') continue;
    hourly[key].forEach((n, h) => {
      for (let i = 0; i < n; i++) {
        const start = h + ((i + 0.5) / n) * 0.92;
        const jitter = ((i * 37 + h * 13 + lane.length * 7) % 17) - 8;
        const at = LANE_FROM[lane] ?? 1;
        if (lane === 'resubmit') dots.push({ start, dur: 0.9, from: 'pool', to: 1, kind: 'fwd', jitter });
        else if (dir === 'fwd') dots.push({ start, dur: 0.9, from: at, to: at + 1 > STATIONS.length - 1 ? 'end' : at + 1, kind: 'fwd', jitter });
        else dots.push({ start, dur: 0.9, from: at, to: 'pool', kind: 'back', jitter });
      }
    });
  }
  return dots;
}

export const HOUR_NAMES: Record<string, string> = {
  'withdrawals|money': 'Withdrawals paid',
  'promissory|money': 'Promissory notes entered',
  'landlord_paid|money': 'Landlord payouts completed',
  'portfolios|partner': 'Partner portfolios opened',
  'roi|partner': 'Returns credits raised',
  'settlements|partner': 'Proxy settlements',
  'claims|partner': 'Funder holds',
  'submit|fwd': 'Requests submitted',
  'resubmit|fwd': 'Requests resubmitted',
  'service_centre|fwd': 'Service Centre passes',
  'service_centre|back': 'Service Centre rejections',
  'agent_ops|fwd': 'Agent Ops passes',
  'agent_ops|back': 'Agent Ops send-backs',
  'tenant_ops|fwd': 'Tenant Ops passes',
  'tenant_ops|back': 'Tenant Ops send-backs',
  'landlord_ops|fwd': 'Landlord Ops passes',
  'landlord_ops|back': 'Landlord Ops send-backs',
  'coo|fwd': 'Pushed to funders',
  'coo|back': 'COO send-backs and demotions',
  'funding|fwd': 'Funded',
  'recall|back': 'Recalled',
  'plan_live|fwd': 'Plans gone live',
  'repayment|fwd': 'Plans completed',
};
export const hourName = (key: string) => HOUR_NAMES[key] ?? copy(key.replace('|', ' ').replace(/_/g, ' '));

/** The money strip: money and partner keys (partner keys are absent when redacted). */
export function moneyLanes(hourly: Record<string, number[]>): { key: string; label: string; counts: number[] }[] {
  return Object.keys(hourly)
    .filter((k) => k.endsWith('|money') || k.endsWith('|partner'))
    .sort()
    .map((k) => ({ key: k, label: hourName(k), counts: hourly[k] }));
}

/** Everything recorded in one hour, for the hour panel. */
export function hourActivity(hourly: Record<string, number[]>, h: number): { key: string; label: string; n: number }[] {
  return Object.keys(hourly)
    .map((k) => ({ key: k, label: hourName(k), n: hourly[k][h] ?? 0 }))
    .filter((r) => r.n > 0);
}

/** "HH:MM" for a river time t in hours (0..24), from the window's hour labels. */
export function clockAt(hours: string[], t: number): string {
  if (t >= 24) return hours[0] || '--:--';
  const h = Math.max(0, Math.floor(t));
  const base = hours[h] || '';
  if (!/^\d{2}:\d{2}$/.test(base)) return '--:--';
  return `${base.slice(0, 2)}:${String(Math.floor((t - h) * 60)).padStart(2, '0')}`;
}

/** Past the time limit at a desk, read from the stage_overdue check's detail ("Agent Ops 16, COO 3, …"). */
export function overdueAt(checks: TwinCheck[], desk: string | null): number | null {
  if (!desk) return null;
  const c = checks.find((x) => x.key === 'stage_overdue');
  if (!c) return null;
  const esc = desk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = (c.detail ?? '').match(new RegExp(`${esc} (\\d+)`));
  return m ? Number(m[1]) : 0;
}

export type StationPanel = {
  title: string;
  isPool: boolean;
  waiting: { n: number; ugx: number } | null;
  out: TwinFlow[];
  inn: TwinFlow[];
  overdue: number | null;
  checks: TwinCheck[];
  nodes: string[];
  lane: LaneKey;
};

/** What a tap on a desk (0..8) or the basin shows. */
export function stationPanel(p: TwinPayload, at: number | 'pool'): StationPanel {
  if (at === 'pool') {
    return {
      title: 'Sent back, rejected or recalled',
      isPool: true,
      waiting: null,
      out: p.flow.filter((f) => f.dir === 'back'),
      inn: p.flow.filter((f) => POOL_STATUSES.includes(f.from)),
      overdue: null,
      checks: POOL_INFO.checks.map((k) => p.checks.find((c) => c.key === k)).filter((c): c is TwinCheck => !!c),
      nodes: POOL_INFO.nodes,
      lane: POOL_INFO.lane,
    };
  }
  const st = STATIONS[at];
  const w = waitingNow(p.queues)[at];
  return {
    title: st.label,
    isPool: false,
    waiting: st.q.length ? w : null,
    out: p.flow.filter((f) => st.from.includes(f.from)),
    inn: st.q.length ? p.flow.filter((f) => st.q.includes(f.to)) : [],
    overdue: overdueAt(p.checks, st.overdue),
    checks: st.checks.map((k) => p.checks.find((c) => c.key === k)).filter((c): c is TwinCheck => !!c),
    nodes: st.nodes,
    lane: st.lane,
  };
}

// ---------------------------------------------------------------- checks, needs, ribbon

/** Failed first; among failed, gap before watch; passed after. Stable otherwise. */
export function orderChecks(checks: TwinCheck[]): TwinCheck[] {
  const rank = (c: TwinCheck) => (c.ok ? 2 : c.severity === 'gap' ? 0 : 1);
  return checks.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

/** Priority 1 first; missing priority last; stable otherwise. */
export function orderNeeds(needs: TwinNeed[]): TwinNeed[] {
  return needs
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.priority ?? 99) - (b.n.priority ?? 99) || a.i - b.i)
    .map((x) => x.n);
}

/** Newest ruling first; undated last; stable otherwise. */
export function orderRulings(rulings: TwinRuling[]): TwinRuling[] {
  const t = (r: TwinRuling) => (r.decidedAt ? Date.parse(r.decidedAt) || 0 : 0);
  return rulings
    .map((r, i) => ({ r, i }))
    .sort((a, b) => t(b.r) - t(a.r) || a.i - b.i)
    .map((x) => x.r);
}

/** Decisions waiting that affect a node, and rulings that apply to it, matched by node id. */
export function decisionsForNode(p: Pick<TwinPayload, 'needs' | 'rulings'>, nodeId: string): { waiting: TwinNeed[]; rulings: TwinRuling[] } {
  return {
    waiting: orderNeeds(p.needs.filter((n) => n.nodes.includes(nodeId))),
    rulings: orderRulings(p.rulings.filter((r) => r.nodes.includes(nodeId))),
  };
}

/** Which nodes each check guards. */
export function guardsByCheck(nodes: TwinNode[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of nodes) for (const k of n.checks) (out[k] ??= []).push(n.id);
  return out;
}

export type Delta = { label: string; delta: number; worseWhenUp: boolean; ugx: boolean };
/**
 * "What changed" since the previous saved run: the newest saved, non-reconstructed
 * run that started before what is on screen. Null when there is none yet.
 */
export function whatChanged(t: Twin, history: HistoryDay[]): { since: HistoryDay; deltas: Delta[] } | null {
  const now = t.runAt ? Date.parse(t.runAt) : Date.now();
  const prev = history
    .filter((h) => !h.reconstructed && h.totals.nodes !== undefined && h.runId !== t.runId && Date.parse(h.runAt) < now)
    .sort((a, b) => Date.parse(a.runAt) - Date.parse(b.runAt))
    .pop();
  if (!prev) return null;
  const p = t.payload;
  const d = (a: number | null | undefined, b: number | null | undefined) => (a ?? 0) - (b ?? 0);
  const failedNow = p.checks.filter((c) => !c.ok).length;
  return {
    since: prev,
    deltas: [
      { label: 'Gap nodes', delta: d(p.totals.gap, prev.totals.gap), worseWhenUp: true, ugx: false },
      { label: 'Failed checks', delta: failedNow - (prev.checksFailed ?? prev.totals.checks_failed ?? 0), worseWhenUp: true, ugx: false },
      { label: 'Stage moves', delta: d(p.kpis.moves, prev.kpis.moves), worseWhenUp: false, ugx: false },
      { label: 'UGX funded', delta: d(p.money.funded_ugx, prev.money.funded_ugx), worseWhenUp: false, ugx: true },
    ],
  };
}

// ---------------------------------------------------------------- the map

export type Placed = { node: TwinNode; x: number; y: number; r: number };
export type Edge = { a: string; b: string; tether: boolean; label: string };
export const MAP_W = 900;
export const MAP_H = 620;

/** Where each object family sits: centre x, centre y, ring radius (0 = a row). */
const REGION: Record<string, [number, number, number]> = {
  Request: [440, 300, 0],
  Party: [190, 300, 112],
  Decision: [318, 92, 58],
  Audit: [150, 88, 50],
  Event: [560, 92, 50],
  Evidence: [60, 585, 0],
  Communication: [120, 530, 0],
  Case: [465, 495, 108],
  Money: [690, 300, 104],
  Control: [730, 92, 82],
  Partner: [795, 525, 68],
  Product: [55, 440, 0],
};

/**
 * Objects grouped by family in fixed regions; each action orbits the object it
 * changes. Deterministic, so the map does not move between runs.
 */
export function layoutMap(nodes: TwinNode[], links: TwinLink[]): { placed: Placed[]; byId: Map<string, Placed>; edges: Edge[] } {
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.from, (degree.get(l.from) ?? 0) + 1);
    degree.set(l.to, (degree.get(l.to) ?? 0) + 1);
  }
  const placed: Placed[] = nodes.map((node) => ({
    node,
    x: MAP_W / 2,
    y: MAP_H / 2,
    r: node.kind === 'object' ? 7 + Math.min(8, (degree.get(node.id) ?? 0) * 0.9) : 4.5,
  }));
  const byId = new Map(placed.map((p) => [p.node.id, p]));

  const families = new Map<string, Placed[]>();
  for (const p of placed) if (p.node.kind === 'object') families.set(p.node.family, [...(families.get(p.node.family) ?? []), p]);
  let spare = 0;
  for (const [family, list] of families) {
    const [cx, cy, ring] = REGION[family] ?? [450, 200 + (spare++ % 3) * 140, 80];
    list.forEach((p, i) => {
      if (family === 'Request') {
        p.x = cx + (i === 0 ? 0 : 118 + (i - 1) * 60);
        p.y = cy + (i === 0 ? 0 : 92);
      } else if (list.length === 1 || ring === 0) {
        p.x = cx + i * 95;
        p.y = cy;
      } else {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / list.length;
        p.x = cx + ring * Math.cos(a);
        p.y = cy + ring * Math.sin(a) * 0.82;
      }
    });
  }

  const actionsOn = new Map<string, Placed[]>();
  const loose: Placed[] = [];
  for (const p of placed) {
    if (p.node.kind !== 'action') continue;
    if (p.node.on && byId.has(p.node.on)) actionsOn.set(p.node.on, [...(actionsOn.get(p.node.on) ?? []), p]);
    else loose.push(p);
  }
  for (const [objectId, list] of actionsOn) {
    const c = byId.get(objectId)!;
    const r = list.length > 6 ? 66 : 27;
    list.forEach((p, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / list.length;
      p.x = c.x + r * Math.cos(a);
      p.y = c.y + r * Math.sin(a);
    });
  }
  loose.forEach((p, i) => {
    p.x = 40 + (i % 20) * 22;
    p.y = MAP_H - 16;
  });
  for (const p of placed) {
    p.x = Math.min(MAP_W - 12, Math.max(12, p.x));
    p.y = Math.min(MAP_H - 12, Math.max(12, p.y));
  }

  const edges: Edge[] = [];
  for (const l of links) if (byId.has(l.from) && byId.has(l.to)) edges.push({ a: l.from, b: l.to, tether: false, label: l.label });
  for (const p of placed) if (p.node.kind === 'action' && p.node.on && byId.has(p.node.on)) edges.push({ a: p.node.id, b: p.node.on, tether: true, label: 'changes' });
  return { placed, byId, edges };
}

// ---------------------------------------------------------------- reading the gaps

/** Two gaps that touch: through a link, or an action and the object it changes. */
export type GapPair = { a: TwinNode; b: TwinNode; how: string };
export type GapChain = { gaps: TwinNode[]; pairs: GapPair[] };

/**
 * Gaps grouped into chains of gaps that touch, largest chain first, plus the
 * gaps on their own. In a lane view only that lane's gaps count.
 */
export function gapChains(nodes: TwinNode[], links: TwinLink[], lane: string | null = null): { chains: GapChain[]; alone: TwinNode[] } {
  const gaps = nodes.filter((n) => n.status === 'gap' && (!lane || n.lane === lane));
  const byId = new Map(gaps.map((n) => [n.id, n]));
  const pairs: GapPair[] = [];
  const seen = new Set<string>();
  const add = (x: string, y: string, how: string) => {
    const a = byId.get(x);
    const b = byId.get(y);
    if (!a || !b || x === y) return;
    const key = `${x}|${y}|${how}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a, b, how });
  };
  for (const l of links) add(l.from, l.to, l.label);
  for (const n of gaps) if (n.kind === 'action' && n.on) add(n.id, n.on, 'changes');

  // Union-find over the gaps.
  const parent = new Map(gaps.map((n) => [n.id, n.id]));
  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  for (const p of pairs) parent.set(root(p.a.id), root(p.b.id));

  const groups = new Map<string, TwinNode[]>();
  for (const n of gaps) groups.set(root(n.id), [...(groups.get(root(n.id)) ?? []), n]);
  const chains: GapChain[] = [];
  const alone: TwinNode[] = [];
  for (const [r, list] of groups) {
    if (list.length < 2) alone.push(list[0]);
    else chains.push({ gaps: list, pairs: pairs.filter((p) => root(p.a.id) === r) });
  }
  chains.sort((x, y) => y.gaps.length - x.gaps.length || x.gaps[0].id.localeCompare(y.gaps[0].id));
  return { chains, alone };
}

// ---------------------------------------------------------------- board link

/**
 * The boardroom display code: #t=<code> (preferred, never sent to a server) or
 * ?t=<code> for links already handed out. Empty when absent or not on /desk/twin.
 */
export function twinBoardToken(path: string, search: string, hash = ''): string {
  if (!/^\/desk\/twin\/?$/.test(path)) return '';
  try {
    const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('t');
    const fromSearch = new URLSearchParams(search).get('t');
    return (fromHash ?? fromSearch ?? '').trim();
  } catch {
    return '';
  }
}

/** The address with the code taken out of both the query and the hash; Board mode kept on. */
export function addressWithoutToken(path: string, search: string, hash: string): string {
  const q = new URLSearchParams(search);
  q.delete('t');
  q.set('board', '1');
  const h = new URLSearchParams(hash.replace(/^#/, ''));
  h.delete('t');
  const hs = h.toString();
  return `${path}?${q.toString()}${hs ? `#${hs}` : ''}`;
}

/** Milliseconds until the next 08:05 EAT (UTC+3, no daylight saving). */
export function msUntilNextEat0805(now: number): number {
  const EAT = 3 * 3_600_000;
  const local = now + EAT;
  const day = Math.floor(local / 86_400_000) * 86_400_000;
  let next = day + (8 * 60 + 5) * 60_000;
  if (next <= local) next += 86_400_000;
  return next - local;
}

// ---------------------------------------------------------------- formatting

const whole = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
export const int = (v: number | null | undefined) => (v === null || v === undefined ? '—' : whole.format(v));
export function ugx(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (Math.abs(v) >= 1e9) return `UGX ${(v / 1e9).toFixed(2)}bn`;
  if (Math.abs(v) >= 1e6) return `UGX ${(v / 1e6).toFixed(2)}M`;
  return `UGX ${whole.format(v)}`;
}
export function pct(a: number | null | undefined, b: number | null | undefined): string {
  return a === null || a === undefined || !b ? '—' : `${Math.round((100 * a) / b)}%`;
}
export function eat(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString('en-GB', { timeZone: 'Africa/Kampala', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} EAT`;
}
/** YYYY-MM-DD in Kampala. */
export function eatDate(ms: number): string {
  return new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);
}

export const STAGE_LABEL: Record<string, string> = {
  new: 'New submission',
  service_center_review: 'Service Centre review',
  pending: 'Agent Ops queue',
  agent_ops_approved: 'Tenant Ops queue',
  tenant_ops_approved: 'Landlord Ops queue',
  landlord_ops_approved: 'Landlord Ops passed',
  partner_ops_approved: 'COO queue',
  coo_approved: 'On the funders board',
  funded: 'Funded, landlord not yet paid',
  repaying: 'Repaying',
  completed: 'Completed',
  rejected: 'Sent back or rejected',
  cancelled: 'Cancelled',
  deleted_by_agent: 'Deleted by agent',
};
export const stageLabel = (s: string) => STAGE_LABEL[s] ?? s;

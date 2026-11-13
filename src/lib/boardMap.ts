/**
 * Boardroom screen 3, the OPS COMMAND MAP (E96): board_display_feed(p_token)
 * returns display.screen = 'map' and feed.map. This file whitelists that
 * payload and holds the rules the screen shows; it never invents a figure.
 * A count or amount the server did not send stays null and reads "—", never 0.
 * Names (tenant, agent, funder, landlord) come only to a link locked to the
 * office network; otherwise they are null and nothing is shown for them.
 */

export type Readiness = 'red' | 'amber' | 'green';
export type Severity = 'critical' | 'high' | 'medium';
export type Tone = 'red' | 'amber' | 'none';

export interface CountUgx { n: number | null; ugx: number | null }
export interface MapKpis {
  soldToday: CountUgx;
  selected: CountUgx & { oldestHours: number | null };
  onBoard: CountUgx;
  inDesks: number | null;
  repaying: number | null;
  arrearsPingsToday: number | null;
  agentsActive60d: number | null;
  agentsFrozen: number | null;
}
interface LatLng { lat: number; lng: number }
export interface Names { tenant: string | null; agent: string | null; funder: string | null; landlord: string | null }
export interface MoneyPoint extends LatLng, Names {
  ugx: number | null;
  hours: number | null;
  area: string | null;
  /** The agent's base, when known: the selected house is joined to it by a dashed line. */
  agentLat: number | null;
  agentLng: number | null;
}
export interface Cell extends LatLng { n: number }
export interface AgentBase extends LatLng { frozen: boolean; name: string | null }
export interface MapLayers {
  sold: MoneyPoint[];
  selected: MoneyPoint[];
  onBoard: MoneyPoint[];
  desks: Cell[];
  repaying: Cell[];
  arrearsToday: Cell[];
  agents: AgentBase[];
  emptyHouses: Cell[];
}
export interface MoneyInMotion extends Names { hours: number | null; ugx: number | null }
export interface MapAlert { severity: Severity; kind: string; text: string; rank: number | null }
export interface MapStage {
  ord: number;
  desk: string;
  stage: string;
  waiting: number | null;
  waitingUgx: number | null;
  done24h: number | null;
  perDay7d: number | null;
  daysToClear: number | null;
}
export interface MapCoverage {
  desksGps: number | null;
  desksExcludedLegacy: number | null;
  repayingGps: number | null;
  repayingTotal: number | null;
  agentsWithBase: number | null;
}
export interface BoardMap {
  readiness: Readiness | null;
  readinessRule: string | null;
  asOf: string | null;
  kpis: MapKpis;
  layers: MapLayers;
  moneyInMotion: MoneyInMotion[];
  alerts: MapAlert[];
  stages: MapStage[];
  coverage: MapCoverage;
  names: boolean;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const cu = (v: unknown): CountUgx => {
  const o = rec(v);
  return { n: num(o.n), ugx: num(o.ugx) };
};
const latLng = (o: Rec): LatLng | null => {
  const lat = num(o.lat);
  const lng = num(o.lng);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
};
const names = (o: Rec): Names => ({ tenant: str(o.tenant), agent: str(o.agent), funder: str(o.funder), landlord: str(o.landlord) });

function moneyPoints(v: unknown): MoneyPoint[] {
  const out: MoneyPoint[] = [];
  for (const o of arr(v)) {
    const p = latLng(o);
    if (!p) continue;
    const a = latLng({ lat: o.agent_lat, lng: o.agent_lng });
    out.push({ ...p, ...names(o), ugx: num(o.ugx), hours: num(o.hours), area: str(o.area), agentLat: a?.lat ?? null, agentLng: a?.lng ?? null });
  }
  return out;
}
function cells(v: unknown): Cell[] {
  const out: Cell[] = [];
  for (const o of arr(v)) {
    const p = latLng(o);
    const n = num(o.n);
    if (p && n !== null && n > 0) out.push({ ...p, n });
  }
  return out;
}
function agents(v: unknown): AgentBase[] {
  const out: AgentBase[] = [];
  for (const o of arr(v)) {
    const p = latLng(o);
    if (p) out.push({ ...p, frozen: o.frozen === true, name: str(o.name) });
  }
  return out;
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2 };

/** Alerts by severity (critical, high, medium), then the server's rank. Unknown severities are dropped. */
export function readAlerts(v: unknown): MapAlert[] {
  return arr(v)
    .map((o) => ({ severity: String(o.severity) as Severity, kind: str(o.kind) ?? '', text: str(o.text) ?? '', rank: num(o.rank) }))
    .filter((a) => a.severity in SEVERITY_ORDER && a.text)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => SEVERITY_ORDER[x.a.severity] - SEVERITY_ORDER[y.a.severity] || (x.a.rank ?? 1e9) - (y.a.rank ?? 1e9) || x.i - y.i)
    .map(({ a }) => a);
}

/** Money in motion, oldest first (most hours first; unknown last). */
export function readMoneyInMotion(v: unknown): MoneyInMotion[] {
  return arr(v)
    .map((o, i) => ({ m: { ...names(o), hours: num(o.hours), ugx: num(o.ugx) }, i }))
    .sort((x, y) => (y.m.hours ?? -1) - (x.m.hours ?? -1) || x.i - y.i)
    .map(({ m }) => m);
}

export function readStages(v: unknown): MapStage[] {
  return arr(v)
    .map((o) => ({
      ord: num(o.ord) ?? 0,
      desk: str(o.desk) ?? '',
      stage: str(o.stage) ?? '',
      waiting: num(o.waiting),
      waitingUgx: num(o.waiting_ugx),
      done24h: num(o.done_24h),
      perDay7d: num(o.per_day_7d),
      daysToClear: num(o.days_to_clear),
    }))
    .filter((s) => s.stage)
    .sort((a, b) => a.ord - b.ord);
}

/** feed.map (and feed.stages for the strip), whitelisted. Null when the feed carries no map. */
export function readBoardMap(map: unknown, stages: unknown): BoardMap | null {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const m = rec(map);
  const k = rec(m.kpis);
  const l = rec(m.layers);
  const c = rec(m.coverage);
  const sel = rec(k.selected);
  const r = str(m.readiness);
  return {
    readiness: r === 'red' || r === 'amber' || r === 'green' ? r : null,
    readinessRule: str(m.readiness_rule),
    asOf: str(m.as_of),
    kpis: {
      soldToday: cu(k.sold_today),
      selected: { ...cu(sel), oldestHours: num(sel.oldest_hours) },
      onBoard: cu(k.on_board),
      inDesks: num(k.in_desks),
      repaying: num(k.repaying),
      arrearsPingsToday: num(k.arrears_pings_today),
      agentsActive60d: num(k.agents_active_60d),
      agentsFrozen: num(k.agents_frozen),
    },
    layers: {
      sold: moneyPoints(l.sold),
      selected: moneyPoints(l.selected),
      onBoard: moneyPoints(l.on_board),
      desks: cells(l.desks),
      repaying: cells(l.repaying),
      arrearsToday: cells(l.arrears_today),
      agents: agents(l.agents),
      emptyHouses: cells(l.empty_houses),
    },
    moneyInMotion: readMoneyInMotion(m.money_in_motion),
    alerts: readAlerts(m.alerts),
    stages: readStages(stages ?? m.stages),
    coverage: {
      desksGps: num(rec(c.desks).gps),
      desksExcludedLegacy: num(rec(c.desks).excluded_legacy_kigishu),
      repayingGps: num(rec(c.repaying).gps),
      repayingTotal: num(rec(c.repaying).total),
      agentsWithBase: num(c.agents_with_base),
    },
    names: m.names === true,
  };
}

/* ───────────── what the screen shows ───────────── */

/** Money waiting: red past 72 h, amber past 24 h. */
export function hoursTone(hours: number | null | undefined): Tone {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 'none';
  if (hours > 72) return 'red';
  if (hours > 24) return 'amber';
  return 'none';
}

/** "5 h" under a day, "1.5 d" from a day; "—" when unknown. */
export function hoursText(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  if (hours < 24) return `${Math.max(0, Math.round(hours))} h`;
  return `${(Math.round((hours / 24) * 10) / 10).toFixed(1)} d`;
}

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });
/** "UGX 4.45M"; "—" when unknown. */
export function ugxShort(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `UGX ${COMPACT.format(v)}`;
}
/** "200K" for a row; "—" when unknown. */
export function ugxBare(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : COMPACT.format(v);
}
/** "3,814"; "—" when unknown (never a zero the server did not send). */
export function countText(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-GB');
}

/** "B. Muhanguzi": a short name for a dense line; null stays null. */
export function shortName(full: string | null): string | null {
  if (!full) return null;
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

/** "B. Muhanguzi → M. Magezi → landlord not paid": only the names that came. */
export function motionLine(m: Pick<MoneyInMotion, 'funder' | 'agent' | 'landlord'>): string {
  const parts = [shortName(m.funder), shortName(m.agent)].filter(Boolean) as string[];
  parts.push(m.landlord ? `${shortName(m.landlord)} not paid` : 'landlord not paid');
  return parts.join(' → ');
}

export type StageTone = 'red' | 'amber' | 'clear' | 'board' | 'selected' | 'sold' | 'none';
export interface StageTile {
  key: string; label: string; value: string; sub: string; tone: StageTone; bottleneck: boolean;
  /** Screen 2's extra line: "UGX 42.2M waiting · 6.9 / day". */
  detail: string;
}

/**
 * The pipeline strip: the server's stages in order, then SOLD TODAY from the KPIs.
 * A desk 3+ days to clear is red (the slowest one gets ▲), 1+ day amber, an empty desk green.
 */
export function stageTiles(stages: MapStage[], soldToday: CountUgx | null): StageTile[] {
  const worst = stages.reduce<MapStage | null>((w, s) => ((s.daysToClear ?? 0) >= 3 && (s.daysToClear ?? 0) > (w?.daysToClear ?? 0) ? s : w), null);
  const tiles: StageTile[] = stages.map((s, i) => {
    const key = `${s.ord}-${s.desk}-${i}`;
    const tile = tileFor(s, key);
    // The board and selected tiles already show their UGX as the sub line.
    const ugxLine = s.waiting && tile.tone !== 'board' && tile.tone !== 'selected' ? `${ugxShort(s.waitingUgx)} waiting` : null;
    const detail = [ugxLine, s.perDay7d === null ? null : `${rate1(s.perDay7d)} / day`].filter(Boolean).join(' · ');
    return { ...tile, detail };
  });
  if (soldToday) tiles.push({ key: 'sold-today', label: 'SOLD TODAY', value: countText(soldToday.n), sub: ugxShort(soldToday.ugx), tone: 'sold', bottleneck: false, detail: '' });
  return tiles;

  function tileFor(s: MapStage, key: string): Omit<StageTile, 'detail'> {
    if (s.stage === 'Funders dashboard') return { key, label: 'FUNDERS BOARD', value: countText(s.waiting), sub: ugxShort(s.waitingUgx), tone: 'board', bottleneck: false };
    if (s.stage === 'Selected, waiting') return { key, label: 'SELECTED, WAITING', value: countText(s.waiting), sub: ugxShort(s.waitingUgx), tone: 'selected', bottleneck: false };
    if (s.waiting === null) {
      // A stage that counts arrivals, not a queue (Submitted).
      return { key, label: s.stage.toUpperCase(), value: countText(s.done24h), sub: 'today', tone: 'none', bottleneck: false };
    }
    const d = s.daysToClear;
    const tone: StageTone = s.waiting === 0 ? 'clear' : d !== null && d >= 3 ? 'red' : d !== null && d >= 1 ? 'amber' : 'none';
    const sub = s.waiting === 0 ? `${countText(s.done24h)} cleared today` : d === null ? 'not clearing' : `${rate1(d)} d to clear`;
    return { key, label: s.stage.toUpperCase(), value: countText(s.waiting), sub, tone, bottleneck: worst === s };
  }
}

const rate1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * Screen 2's lead, in the desks' own words (StageFlow's flow sentence):
 * "6.9 new requests a day come in; the slowest stage, Service Centre, clears 6.9 a day."
 * The slowest stage is the one that would take longest to clear; one with work
 * waiting and nothing clearing outranks a slow queue.
 */
export function pipelineLead(stages: MapStage[]): string | null {
  if (stages.length === 0) return null;
  const entry = stages.find((s) => s.ord === 0) ?? stages[0];
  const intake = entry.perDay7d === null ? '—' : rate1(entry.perDay7d);
  const waiting = stages.filter((s) => (s.waiting ?? 0) > 0);
  if (waiting.length === 0) return `${intake} new requests a day come in. Nothing is waiting at any desk.`;
  const neck = waiting.reduce((w, s) => ((s.daysToClear ?? Infinity) > (w.daysToClear ?? Infinity) ? s : w));
  return `${intake} new requests a day come in; the slowest stage, ${neck.stage}, clears ${neck.perDay7d === null ? '—' : rate1(neck.perDay7d)} a day.`;
}

/** "SC 221 · COO 14": the two queues the COO watches, from the stages. */
export function desksSub(stages: MapStage[]): string {
  const w = (desk: string) => stages.find((s) => s.desk === desk)?.waiting;
  const parts = [] as string[];
  const sc = w('service-centre');
  const coo = w('coo');
  if (sc !== null && sc !== undefined) parts.push(`SC ${countText(sc)}`);
  if (coo !== null && coo !== undefined) parts.push(`COO ${countText(coo)}`);
  return parts.join(' · ');
}

export type LayerKey = 'sold' | 'selected' | 'onBoard' | 'desks' | 'repaying' | 'arrearsToday' | 'agents' | 'emptyHouses';
export const LAYER_ORDER: LayerKey[] = ['sold', 'selected', 'onBoard', 'desks', 'repaying', 'arrearsToday', 'agents', 'emptyHouses'];
/** Shown at first: everything but the faint empty-house heat and the repaying cells (as in the approved preview). */
export const LAYER_DEFAULTS: Record<LayerKey, boolean> = {
  sold: true, selected: true, onBoard: true, desks: true, repaying: false, arrearsToday: true, agents: true, emptyHouses: false,
};
export const LAYER_LABEL: Record<LayerKey, string> = {
  sold: 'Sold · landlord paid',
  selected: 'Selected · money with agent',
  onBoard: 'On funders board',
  desks: 'In the desks',
  repaying: 'Repaying · live plans',
  arrearsToday: 'Arrears pings · today',
  agents: 'Agent bases',
  emptyHouses: 'Empty houses · heat',
};
const sumN = (c: Cell[]) => c.reduce((s, x) => s + x.n, 0);
/** The count beside each layer switch: the KPI where there is one, else what the layer holds. */
export function layerCount(map: BoardMap, key: LayerKey): number | null {
  const k = map.kpis;
  switch (key) {
    case 'sold': return k.soldToday.n;
    case 'selected': return k.selected.n;
    case 'onBoard': return k.onBoard.n;
    case 'desks': return k.inDesks;
    case 'repaying': return k.repaying;
    case 'arrearsToday': return k.arrearsPingsToday;
    case 'agents': return map.layers.agents.length;
    case 'emptyHouses': return sumN(map.layers.emptyHouses);
  }
}

/** Marker size for a cell of n requests: grows with the square root, capped so Kampala does not swallow the map. */
export function cellScale(n: number, base = 4, per = 2.4, cap = 26): number {
  return Math.min(cap, base + per * Math.sqrt(Math.max(0, n)));
}

/** "13 NOV 2026", Kampala. */
export function kampalaDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
}

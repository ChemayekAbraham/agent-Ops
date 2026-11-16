import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { rpc } from '../reviewApi';
import { MarkerLegend, MARKER_CSS, PickedMarks, marksByDay, markerLines, readMarkers, type DayMarks, type Marker } from './markers';
import { LABEL, statusText } from '../deskTheme';
import { fmt } from '../format';
import { isMissingDbObject } from '../deskLive';
import { Card, EmptyState, ErrorLine, LoadingRows, Segmented, stackLayout } from '../ui';
import { plainError } from '../arrears/arrearsApi';

/**
 * "Where rent requests get stuck" (E108): `posting_funnel(p_days, p_form)`.
 * Agents who opened the posting form against those who posted, day by day;
 * the steps they reached (from button taps — direction, not exact); in the
 * tracked sessions, the items that blocked them and where they gave up; and
 * what send-backs most often ask for. Every figure is the server's.
 *
 * The card shows nothing until the server has the function, and nothing to
 * a viewer it refuses (it is for the COO, the CEO, Agent Ops and the Service
 * Centre).
 */

export const FUNNEL_DAYS = [7, 14, 30] as const;
export type FunnelDays = (typeof FUNNEL_DAYS)[number];
export const FUNNEL_FORMS = [
  { key: 'agent_post', label: 'Agent' },
  { key: 'tenant_self', label: 'Tenant self-apply' },
] as const;
export type FunnelForm = (typeof FUNNEL_FORMS)[number]['key'];

/**
 * Item and step keys in words (src/lib/formFunnel.ts FUNNEL_ITEMS and
 * FUNNEL_STEPS, plus older names). Unknown keys read as their words.
 */
export const ITEM_WORDS: Record<string, string> = {
  house_photos: 'House photos',
  landlord: 'Landlord details',
  rent: 'Rent amount',
  family_size: 'Family size',
  work: 'Work details',
  phone: 'Phone number',
  duplicate: 'Duplicate request',
  other: 'Other',
  start: 'Start',
  repayment: 'Repayment plan',
  tenant: 'Tenant details',
  house_landlord: 'House and landlord',
  smartphone: 'Smartphone',
  documents: 'Documents',
  review: 'Review',
  unknown: 'Unknown',
  id_front: 'ID photo front',
  id_back: 'ID photo back',
  national_id: 'National ID number',
  nin: 'National ID number',
  selfie: 'Selfie',
  tenant_photo: 'Tenant photo',
  tenant_phone: 'Tenant phone',
  tenant_name: 'Tenant name',
  lc1_letter: 'LC1 letter',
  lc1: 'LC1 letter',
  landlord_name: 'Landlord name',
  landlord_phone: 'Landlord phone',
  landlord_id: 'Landlord ID',
  house_photo: 'House photo',
  house_location: 'House location (GPS)',
  gps: 'House location (GPS)',
  location: 'House location (GPS)',
  next_of_kin: 'Next of kin',
  nok: 'Next of kin',
  rent_amount: 'Rent amount',
  tenancy_agreement: 'Tenancy agreement',
  agreement: 'Guarantor agreement',
  caretaker_phone: 'Caretaker phone',
  meter_photo: 'Meter photo',
};
export function itemWords(key: unknown): string {
  const k = String(key ?? '').trim();
  if (!k) return '—';
  if (ITEM_WORDS[k.toLowerCase()]) return ITEM_WORDS[k.toLowerCase()];
  const s = k.replace(/[_-]+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
type Pair = { label: string; value: number | null };
/** A list the server sent as [{step|item|…, agents|n|…}] or as {label: n}, in its own order. */
export function pairs(v: unknown, labelKeys: string[], valueKeys: string[]): Pair[] {
  if (Array.isArray(v)) {
    return v.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const lk = labelKeys.find((k) => o[k] !== undefined && o[k] !== null);
      const vk = valueKeys.find((k) => o[k] !== undefined);
      return { label: String(lk ? o[lk] : '—'), value: vk ? num(o[vk]) : null };
    });
  }
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([label, value]) => ({ label, value: num(value) }));
  return [];
}

type Daily = { day: string; agents_opened: number | null; agents_posted: number | null; conversion_pct: number | null };
type Blocking = { item: string; sessions_blocked: number | null; abandoned_after: number | null; fixed_and_posted: number | null };
export type Funnel = {
  agents_opened: number | null;
  agents_posted: number | null;
  conversion_pct: number | null;
  requests: number | null;
  daily: Daily[];
  milestones: Pair[];
  blocking: Blocking[];
  lastBlock: Pair[];
  abandonedAt: Pair[];
  submitFailures: { code: string; times: number | null; agents: number | null }[] | number | null;
  checklist: Pair[];
  byVetting: { status: string; agents_opened: number | null; agents_posted: number | null }[];
  drafts: { open: number | null; agents: number | null; missing: Pair[] } | null;
  markers: Marker[];
};

export function readFunnel(data: unknown): Funnel {
  const d = (data ?? {}) as Record<string, unknown>;
  const head = ((d.headline && typeof d.headline === 'object' ? d.headline : d) ?? {}) as Record<string, unknown>;
  const t = (d.tracked ?? {}) as Record<string, unknown>;
  const sf = t.submit_failures;
  return {
    agents_opened: num(head.agents_opened),
    agents_posted: num(head.agents_posted),
    conversion_pct: num(head.conversion_pct),
    requests: num(head.requests),
    daily: (Array.isArray(d.daily) ? d.daily : []).slice(-28).map((x: Record<string, unknown>) => ({
      day: String(x.day ?? x.date ?? ''),
      agents_opened: num(x.agents_opened),
      agents_posted: num(x.agents_posted),
      conversion_pct: num(x.conversion_pct),
    })),
    milestones: pairs(d.milestones, ['step', 'milestone', 'label', 'name'], ['agents', 'n', 'count']),
    blocking: (Array.isArray(t.blocking_items) ? t.blocking_items : [])
      .map((x: Record<string, unknown>) => ({
        item: String(x.item ?? ''),
        sessions_blocked: num(x.sessions_blocked),
        abandoned_after: num(x.abandoned_after),
        fixed_and_posted: num(x.fixed_and_posted),
      }))
      // Sorted by how many gave up after it (the brief's order); the figures are the server's.
      .sort((a: Blocking, b: Blocking) => (b.abandoned_after ?? -1) - (a.abandoned_after ?? -1)),
    lastBlock: pairs(t.last_block_before_quitting, ['item', 'label', 'step'], ['sessions', 'n', 'count', 'agents']),
    abandonedAt: pairs(t.abandoned_at_step, ['step', 'label', 'item'], ['sessions', 'n', 'count', 'agents']),
    submitFailures:
      typeof sf === 'number' || typeof sf === 'string'
        ? num(sf)
        : Array.isArray(sf)
          ? sf.map((x: Record<string, unknown>) => ({ code: String(x.code ?? x.reason ?? x.error ?? 'unknown'), times: num(x.times ?? x.n ?? x.count), agents: num(x.agents) }))
          : null,
    checklist: pairs(d.resubmit_checklist, ['item', 'label'], ['agents', 'n', 'count']),
    byVetting: (Array.isArray(d.by_vetting) ? d.by_vetting : []).map((x: Record<string, unknown>) => ({
      status: String(x.status ?? 'no record'),
      agents_opened: num(x.agents_opened),
      agents_posted: num(x.agents_posted),
    })),
    drafts:
      d.drafts && typeof d.drafts === 'object'
        ? (() => {
            const dr = d.drafts as Record<string, unknown>;
            return { open: num(dr.open), agents: num(dr.agents), missing: pairs(dr.missing, ['item', 'label'], ['drafts', 'n', 'count']) };
          })()
        : null,
    markers: readMarkers(d.markers),
  };
}

export function usePostingFunnel(days: FunnelDays, form: FunnelForm) {
  return useQuery({
    queryKey: ['desk-feed', 'posting-funnel', days, form],
    queryFn: async () => {
      const { data, error } = await rpc('posting_funnel', { p_days: days, p_form: form });
      if (error) throw error;
      return readFunnel(data);
    },
    staleTime: 5 * 60_000,
    retry: (n, e) => !isMissingDbObject(e) && n < 1,
  });
}

const refused = (e: unknown) => (e as { code?: string } | null)?.code === '42501';

/* Validated pair (dataviz palette slots 1–2; light and dark both pass): opened = blue, posted = orange. */
const VIZ_CSS = `.funnel-viz{--viz-opened:#2a78d6;--viz-posted:#eb6834;--viz-grid:hsl(var(--border));--viz-ink:hsl(var(--muted-foreground))}
.dark .funnel-viz{--viz-opened:#3987e5;--viz-posted:#d95926}`;

const shortDay = (v: string) => (Number.isFinite(Date.parse(v)) ? new Date(`${v.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : v);

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={stackLayout(8)} aria-label={title}>
      <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        {title}
        {note && <span className={`${LABEL} ml-2 font-normal`}>{note}</span>}
      </h3>
      {children}
    </section>
  );
}

function PairList({ rows, words, label }: { rows: Pair[]; words?: boolean; label: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ul style={{ ...stackLayout(4), margin: 0, padding: 0, listStyle: 'none' }} aria-label={label}>
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`} className="flex justify-between gap-3 text-sm">
          <span className="text-foreground" style={{ overflowWrap: 'anywhere' }}>
            {words ? itemWords(r.label) : r.label}
          </span>
          <span className="tabular-nums text-foreground">{fmt('int', r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** An agent who opened the form but is not verified: the vetting row to look at. */
export const openedUnverified = (r: { status: string; agents_opened: number | null }) => r.status !== 'verified' && (r.agents_opened ?? 0) > 0;
const VETTING_WORDS: Record<string, string> = { verified: 'Verified', unverified: 'Not verified', submitted: 'Submitted, waiting', rejected: 'Rejected', 'no record': 'No vetting record' };

function DailyCharts({ daily, markers }: { daily: Daily[]; markers: Marker[] }) {
  const [table, setTable] = useState(false);
  const [picked, setPicked] = useState<DayMarks | null>(null);
  if (daily.length === 0) return <p className="text-sm text-muted-foreground">No days came back.</p>;
  const data = daily.map((d) => ({ ...d, label: shortDay(d.day) }));
  // Markers sit on the day they happened, when that day is on the chart.
  const onChart = new Set(daily.map((d) => d.day.slice(0, 10)));
  const marks = marksByDay(markers.filter((m) => onChart.has(m.day)));
  const xFor = (day: string) => (onChart.has(day) ? shortDay(day) : null);
  const axis = { stroke: 'var(--viz-grid)', tick: { fill: 'var(--viz-ink)', fontSize: 11 } };
  return (
    <div className="funnel-viz change-markers" style={stackLayout(10)}>
      <style>{VIZ_CSS + MARKER_CSS}</style>
      {/* Two charts, one axis each: counts, then the conversion rate. */}
      <div style={{ height: 180 }} aria-label="Agents who opened and posted, by day" role="img">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--viz-grid)" strokeOpacity={0.5} vertical={false} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axis} allowDecimals={false} width={40} />
            <Tooltip contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--popover-foreground))', fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12, color: 'var(--viz-ink)' }} />
            <Line type="monotone" dataKey="agents_opened" name="Agents opened" stroke="var(--viz-opened)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line type="monotone" dataKey="agents_posted" name="Agents posted" stroke="var(--viz-posted)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            {markerLines(marks, xFor, setPicked)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ height: 120 }} aria-label="Conversion, by day" role="img">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <CartesianGrid stroke="var(--viz-grid)" strokeOpacity={0.5} vertical={false} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" minTickGap={24} />
            <YAxis {...axis} width={40} unit="%" />
            <Tooltip formatter={(v: number) => [`${v}%`, 'Conversion']} contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', color: 'hsl(var(--popover-foreground))', fontSize: 12 }} />
            <Line type="monotone" dataKey="conversion_pct" name="Conversion" stroke="var(--viz-opened)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
            {markerLines(marks, xFor, setPicked)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {marks.length > 0 && <MarkerLegend />}
      <PickedMarks picked={picked} onClose={() => setPicked(null)} />
      <button type="button" className="w-fit text-xs text-muted-foreground underline underline-offset-4" onClick={() => setTable((t) => !t)} aria-expanded={table}>
        {table ? 'Hide the table' : 'Show as a table'}
      </button>
      {table && (
        <div style={{ overflowX: 'auto' }}>
          <table className="w-full text-sm" data-daily-table>
            <thead>
              <tr>
                <th className={`${LABEL} px-2 py-1 text-left font-normal`}>Day</th>
                <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Opened</th>
                <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Posted</th>
                <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day} className="border-t border-[var(--desk-line-color)]">
                  <td className="px-2 py-1 text-foreground">{shortDay(d.day)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', d.agents_opened)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', d.agents_posted)}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-foreground">{d.conversion_pct === null ? '—' : `${d.conversion_pct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Milestones({ rows }: { rows: Pair[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No steps came back.</p>;
  // Bar lengths only scale the server's numbers to the widest one.
  const max = Math.max(1, ...rows.map((r) => r.value ?? 0));
  return (
    <ol style={{ ...stackLayout(6), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Agents reaching each step" data-milestones>
      {rows.map((r, i) => (
        <li key={`${r.label}-${i}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 11rem) minmax(0, 1fr) auto', alignItems: 'center', gap: 8 }} data-milestone={r.label}>
          <span className="text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
            {itemWords(r.label)}
          </span>
          <span style={{ height: 10, borderRadius: 4, background: 'hsl(var(--muted))', overflow: 'hidden' }} aria-hidden>
            <span style={{ display: 'block', height: '100%', width: `${((r.value ?? 0) / max) * 100}%`, borderRadius: 4, background: 'hsl(var(--primary))' }} />
          </span>
          <span className="text-sm tabular-nums text-foreground">{fmt('int', r.value)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The funnel is a heavy report: it loads only once the card scrolls into view,
 * and starts on the shortest window so a page view does not trigger the slow read.
 */
export function PostingFunnelCard({ board }: { board: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  if (!seen) return <div ref={ref} style={{ minHeight: 120 }} aria-hidden />;
  return <PostingFunnelCardBody board={board} />;
}

function PostingFunnelCardBody({ board }: { board: boolean }) {
  const [days, setDays] = useState<FunnelDays>(7);
  const [form, setForm] = useState<FunnelForm>('agent_post');
  const q = usePostingFunnel(days, form);
  // Not on the server yet, or not for this viewer: no card.
  if (q.error && (isMissingDbObject(q.error) || refused(q.error))) return null;
  const f = q.data;

  const controls = (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Segmented<FunnelDays>
        ariaLabel="Days"
        value={days}
        onChange={(v) => v !== null && setDays(v)}
        options={FUNNEL_DAYS.map((d) => ({ value: d, label: `${d} days` }))}
      />
      <Segmented<FunnelForm> ariaLabel="Form" value={form} onChange={(v) => v !== null && setForm(v)} options={FUNNEL_FORMS.map((x) => ({ value: x.key, label: x.label }))} />
    </div>
  );

  return (
    <Card board={board} title="Where rent requests get stuck" ariaLabel="Where rent requests get stuck" busy={q.isLoading}>
      {controls}
      {q.isLoading ? (
        <LoadingRows rows={4} label="Loading where requests get stuck" />
      ) : q.error ? (
        <ErrorLine>{plainError(q.error, {})}</ErrorLine>
      ) : !f ? (
        <EmptyState>Nothing came back.</EmptyState>
      ) : (
        <div style={stackLayout(18)} data-posting-funnel={form}>
          <p className={`${board ? 'text-xl' : 'text-lg'} text-foreground`} style={{ margin: 0 }} data-funnel-headline>
            <span className="font-semibold tabular-nums">{fmt('int', f.agents_opened)}</span> agents opened →{' '}
            <span className="font-semibold tabular-nums">{fmt('int', f.agents_posted)}</span> posted ({f.conversion_pct === null ? '—' : `${f.conversion_pct}%`}) ·{' '}
            <span className="tabular-nums">{fmt('int', f.requests)}</span> requests
          </p>

          <Section title="By day" note="last 28 days">
            <DailyCharts daily={f.daily} markers={f.markers} />
          </Section>

          <Section title="Steps reached" note="from button taps — direction, not exact">
            <Milestones rows={f.milestones} />
          </Section>

          <Section title="What blocked them" note="tracked sessions">
            {f.blocking.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing blocked a tracked session.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-sm" data-blocking-items>
                  <thead>
                    <tr>
                      <th className={`${LABEL} px-2 py-1 text-left font-normal`}>Item</th>
                      <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Sessions blocked</th>
                      <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Gave up after</th>
                      <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Fixed and posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.blocking.map((b) => (
                      <tr key={b.item} className="border-t border-[var(--desk-line-color)]" data-blocking={b.item}>
                        <td className="px-2 py-1 text-foreground">{itemWords(b.item)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', b.sessions_blocked)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', b.abandoned_after)}</td>
                        <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', b.fixed_and_posted)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <Section title="Last block before quitting">
              <PairList rows={f.lastBlock} words label="Last block before quitting" />
            </Section>
            <Section title="Gave up at step">
              <PairList rows={f.abandonedAt} words label="Gave up at step" />
            </Section>
            <Section title="Submit failures">
              {Array.isArray(f.submitFailures) ? (
                f.submitFailures.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None.</p>
                ) : (
                  <ul style={{ ...stackLayout(4), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Submit failures">
                    {f.submitFailures.map((x) => (
                      <li key={x.code} className="flex justify-between gap-3 text-sm" data-submit-failure={x.code}>
                        <span className="text-foreground" style={{ overflowWrap: 'anywhere' }}>
                          {x.code}
                        </span>
                        <span className="tabular-nums text-foreground">
                          {fmt('int', x.times)}×{x.agents !== null ? ` · ${fmt('int', x.agents)} agents` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )
              ) : (
                <p className="text-sm tabular-nums text-foreground" style={{ margin: 0 }} data-submit-failures>
                  {fmt('int', f.submitFailures)}
                </p>
              )}
            </Section>
          </div>

          <Section title="Send-back checklist" note="what send-backs ask for, by agents">
            <PairList rows={f.checklist} words label="Send-back checklist" />
          </Section>

          <Section title="By vetting status" note="agents who opened the form but are not verified are marked">
            {f.byVetting.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-sm" data-by-vetting>
                  <thead>
                    <tr>
                      <th className={`${LABEL} px-2 py-1 text-left font-normal`}>Status</th>
                      <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Agents opened</th>
                      <th className={`${LABEL} px-2 py-1 text-right font-normal`}>Agents posted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.byVetting.map((v) => {
                      const flag = openedUnverified(v);
                      return (
                        <tr key={v.status} className={`border-t border-[var(--desk-line-color)] ${flag ? 'bg-[hsl(var(--warning)/0.12)]' : ''}`} data-vetting={v.status} data-flag={flag || undefined}>
                          <td className="px-2 py-1 text-foreground">
                            {VETTING_WORDS[v.status] ?? v.status}
                            {flag && <span className={`ml-2 text-xs ${statusText.warn}`}>opened, not verified</span>}
                          </td>
                          <td className={`px-2 py-1 text-right tabular-nums ${flag ? `font-semibold ${statusText.warn}` : 'text-foreground'}`}>{fmt('int', v.agents_opened)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-foreground">{fmt('int', v.agents_posted)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {f.drafts && (
            <Section title="Drafts not posted">
              <p className="text-sm text-foreground" style={{ margin: 0 }} data-drafts>
                <span className="font-semibold tabular-nums">{fmt('int', f.drafts.open)}</span> open drafts ·{' '}
                <span className="tabular-nums">{fmt('int', f.drafts.agents)}</span> agents
              </p>
              <PairList rows={f.drafts.missing} words label="Missing from drafts" />
            </Section>
          )}
        </div>
      )}
    </Card>
  );
}

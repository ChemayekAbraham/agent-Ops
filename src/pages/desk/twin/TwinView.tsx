import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, FileDown, RefreshCw } from 'lucide-react';
import { CALM, FOCUS } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import {
  LANE_SHORT,
  PARTNER_LIMITED,
  STATUS_LABEL,
  STATUS_ORDER,
  copy,
  eat,
  eatDate,
  guardsByCheck,
  int,
  isLaneKey,
  isRedacted,
  laneChecks,
  laneLinks,
  laneNodes,
  laneState,
  laneTabs,
  metricValue,
  orderChecks,
  orderNeeds,
  pct,
  screenLabel,
  sectionsFor,
  stageLabel,
  ugx,
  whatChanged,
  type HistoryDay,
  type LaneKey,
  type NodeStatus,
  type Nums,
  type Twin,
  type TwinLane,
  type TwinPayload,
} from './twinModel';
import { downloadText, fillOfflineTemplate, offlineSnapshot, toMarkdown } from './twinReport';
import type { TwinSource } from './twinSource';
import { useTwin, type TwinMode } from './useTwin';
import { TwinRiver } from './TwinRiver';
import { StatusPill, TwinMap, statusColour } from './TwinMap';
import './twin.css';

/**
 * The twin's whole screen below the desk header (or the boardroom header):
 * status line, the river, the lane bar, then the Company or lane view.
 * Read-only. All data is rendered as text.
 */

type View = 'company' | LaneKey;

function readParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
function writeParam(name: string, value: string | null) {
  try {
    const url = new URL(window.location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* the choice just isn't kept in the address */
  }
}

const BTN = `desk-pill inline-flex items-center gap-1.5 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-xs font-medium ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground disabled:opacity-50`;

export function TwinView({ source, board, onOpenDesk }: { source: TwinSource; board: boolean; onOpenDesk?: (desk: string) => void }) {
  const initialDay = readParam('day');
  const initialMode: TwinMode = initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay) ? { kind: 'day', date: initialDay } : { kind: 'live' };
  const tw = useTwin(source, initialMode);
  const [view, setViewState] = useState<View>(() => {
    const l = readParam('lane');
    return isLaneKey(l) ? l : 'company';
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const setView = useCallback((v: View) => {
    setViewState(v);
    setSelected(null);
    writeParam('lane', v === 'company' ? null : v);
    document.getElementById('twin-lanes')?.scrollIntoView({ block: 'start' });
  }, []);
  const setMode = (m: TwinMode) => {
    tw.setMode(m);
    writeParam('day', m.kind === 'day' ? m.date : null);
  };

  const { twin, loading, error, loadedAt, history } = tw;
  const p = twin?.payload ?? null;
  const laneName = useCallback((l: LaneKey) => LANE_SHORT[l], []);

  const showNode = useCallback(
    (id: string) => {
      const node = p?.nodes.find((n) => n.id === id);
      if (view !== 'company' && node && node.lane !== view) {
        setViewState('company');
        writeParam('lane', null);
      }
      setSelected(id);
      window.setTimeout(() => document.getElementById('twin-map')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    },
    [p, view],
  );

  const report = () => {
    if (!twin) return;
    downloadText(`welile-twin-report-${eatDate(Date.now())}.md`, toMarkdown(twin, loadedAt), 'text/markdown');
  };
  const offline = async () => {
    if (!twin) return;
    setSaving('Building the offline copy…');
    try {
      const res = await fetch('/twin-offline-template.html', { cache: 'no-store' });
      if (!res.ok) throw new Error(`template ${res.status}`);
      const html = fillOfflineTemplate(await res.text(), offlineSnapshot(twin, history, loadedAt));
      downloadText(`welile-twin-${eatDate(Date.now())}.html`, html, 'text/html');
      setSaving(null);
    } catch {
      setSaving('The offline copy could not be built. Try again.');
    }
  };

  const days = useMemo(() => [...history].sort((a, b) => (a.day < b.day ? 1 : -1)), [history]);
  const reconstructed = !!p?.reconstructed;
  const sections = sectionsFor(view, reconstructed);

  return (
    <div className="twin-root min-w-0 space-y-5">
      {/* What is on screen, and how to change it. */}
      <div className="flex flex-wrap items-center gap-2">
        <p className={`${board ? 'text-base' : 'text-sm'} m-0 mr-auto min-w-0 font-medium text-foreground`} role="status" aria-live="polite">
          <span
            className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
            style={{ background: error ? 'var(--twin-gap)' : twin?.runId === null ? 'var(--twin-verified)' : 'var(--twin-draft)' }}
            aria-hidden
          />
          {twin ? screenLabel(twin, loadedAt) : loading ? 'Loading the twin…' : 'No twin loaded'}
          {twin?.lastOfficial && twin.runId === null && (
            <span className="ml-2 font-normal text-muted-foreground">· last saved run {twin.lastOfficial.runId}, {eat(twin.lastOfficial.runAt)}</span>
          )}
        </p>
        <label className="sr-only" htmlFor="twin-day">
          Day shown
        </label>
        <select
          id="twin-day"
          value={tw.mode.kind === 'live' ? 'live' : tw.mode.date}
          onChange={(e) => setMode(e.target.value === 'live' ? { kind: 'live' } : { kind: 'day', date: e.target.value })}
          className={`${BTN} pr-2`}
        >
          <option value="live">Live: last 24 hours</option>
          {days.map((d) => (
            <option key={d.day} value={d.day}>
              {d.day} · run {d.runId}
              {d.reconstructed ? ' (reconstructed)' : ''}
            </option>
          ))}
        </select>
        <button type="button" className={BTN} onClick={tw.refresh} disabled={loading} aria-label="Refresh the twin">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden />
          Refresh
        </button>
        <button type="button" className={BTN} onClick={report} disabled={!twin}>
          <FileDown className="h-3.5 w-3.5" aria-hidden />
          Download today&rsquo;s report (.md)
        </button>
        <button type="button" className={BTN} onClick={offline} disabled={!twin || saving === 'Building the offline copy…'}>
          <Download className="h-3.5 w-3.5" aria-hidden />
          Save offline copy
        </button>
      </div>
      {saving && <p className="m-0 text-sm text-muted-foreground" role="status">{saving}</p>}

      {error && (
        <div className="desk-panel border-l-4 p-4 text-sm" style={{ borderLeftColor: 'var(--twin-gap)' }} role="alert">
          <p className="m-0 text-foreground">{error.message}</p>
          {twin && <p className="m-0 mt-1 text-muted-foreground">Showing the last twin that loaded.</p>}
        </div>
      )}
      {p?.reconstructed && p.note && (
        <div className="desk-panel border-l-4 p-4 text-sm text-foreground" style={{ borderLeftColor: 'var(--twin-draft)' }} role="note">
          {copy(p.note)}
        </div>
      )}

      {loading && !twin && !error && <Loading />}
      {!loading && !twin && !error && <div className="desk-panel p-6 text-sm text-muted-foreground">No twin run for this day.</div>}

      {p && twin && (
        <>
          <section aria-label="The 24-hour river">
            {!reconstructed && (
              <p className={`${board ? 'text-base' : 'text-sm'} m-0 mb-2 text-muted-foreground`}>
                {int(p.kpis.moves ?? 0)} stage moves, {int(p.totals.gap ?? 0)} gap nodes, {int(p.checks.filter((c) => !c.ok).length)} of {int(p.checks.length)} checks failed.
              </p>
            )}
            <TwinRiver
              key={`${twin.runId ?? 'live'}-${p.windowLabel}`}
              payload={p}
              board={board}
              liveMoves={tw.mode.kind === 'live' ? tw.liveMoves : []}
              onShowNode={reconstructed ? undefined : showNode}
              onOpenLane={reconstructed ? undefined : (l) => setView(l)}
              laneLabel={laneName}
            />
          </section>

          {!reconstructed && p.lanes.length > 0 && <LaneBar p={p} view={view} onView={setView} board={board} />}

          {sections.map((s) => {
            const lane = view === 'company' ? null : view;
            switch (s) {
              case 'ribbon':
                return (
                  <Section key={s} title="What changed" board={board}>
                    <Ribbon twin={twin} history={history} />
                  </Section>
                );
              case 'tiles':
                return (
                  <Section key={s} title="The company by lane" lede="Each tile opens its lane." board={board}>
                    <LaneTiles p={p} onView={setView} />
                  </Section>
                );
              case 'lanehead':
                return lane ? <LaneHead key={s} p={p} lane={lane} board={board} /> : null;
              case 'map':
                return (
                  <Section key={s} id="twin-map" title="The company as objects, links and actions" lede="Colour is today's status. Select any node for its owner, evidence, checks and recommendations." board={board}>
                    <TwinMap payload={p} board={board} lane={lane} selected={selected} onSelect={setSelected} onOpenDesk={onOpenDesk} />
                  </Section>
                );
              case 'checks':
                return (
                  <Section key={s} title={lane ? 'What the checks found in this lane' : "What today's checks found"} lede="Red is a gap on the nodes it guards; amber is a watch item. Each has a recommendation and an owner." board={board}>
                    <Checks p={p} lane={reconstructed ? null : lane} board={board} />
                  </Section>
                );
              case 'health':
                return (
                  <Section key={s} title="How the chain held" lede="The window first, then the last 30 days." board={board}>
                    <Health p={p} board={board} />
                  </Section>
                );
              case 'needs':
                return (
                  <Section key={s} title="Decisions waiting" lede="Answer-first items at the top. Each shows its lane, who raised it, the recommendation and the evidence." board={board}>
                    <Needs p={p} board={board} />
                  </Section>
                );
              case 'tables':
                return lane ? (
                  <Section key={s} title="In the window" board={board}>
                    <LaneTables p={p} lane={lane} />
                  </Section>
                ) : null;
              case 'nodes':
                return (
                  <Section key={s} title={lane ? 'Nodes in this lane' : 'Every node'} board={board}>
                    <NodeTable p={p} lane={lane} onPick={showNode} />
                  </Section>
                );
              case 'links':
                return (
                  <Section key={s} title="Links" board={board}>
                    <LinkTable p={p} lane={lane} />
                  </Section>
                );
              case 'money':
                return (
                  <Section key={s} title="Money in the window" board={board}>
                    <LaneTables p={p} lane="money" />
                  </Section>
                );
              case 'partner':
                return (
                  <Section key={s} title="Partner flows in the window" board={board}>
                    <LaneTables p={p} lane="partner" />
                  </Section>
                );
              default:
                return null;
            }
          })}

          {view === 'company' && <Footer twin={twin} history={history} />}
        </>
      )}
    </div>
  );
}

function Section({ id, title, lede, board, children }: { id?: string; title: string; lede?: string; board: boolean; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4">
      <h2 className={`${board ? 'text-2xl' : 'text-xl'} m-0 font-semibold tracking-tight text-foreground`}>{title}</h2>
      {lede ? <p className={`${board ? 'text-base' : 'text-sm'} m-0 mb-3 mt-1 max-w-[75ch] text-muted-foreground`}>{lede}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading the twin">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function LaneBar({ p, view, onView, board }: { p: TwinPayload; view: View; onView: (v: View) => void; board: boolean }) {
  return (
    <nav id="twin-lanes" aria-label="Company and lanes" className="desk-tabs scroll-mt-4 border-b border-[var(--desk-line-color)]" style={{ display: 'flex', flexWrap: 'nowrap', gap: 4, overflowX: 'auto' }}>
      {laneTabs(p).map((t) => {
        const active = t.key === view;
        return (
          <button
            key={t.key}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onView(t.key === 'company' ? 'company' : (t.key as LaneKey))}
            className={`desk-tab inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t border-b-2 px-3 py-2 ${board ? 'text-base' : 'text-sm'} -mb-px ${CALM} ${FOCUS} ${
              active ? 'border-[hsl(var(--primary))] font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {t.badge && (
              <span
                className="inline-flex min-w-[1.25rem] justify-center rounded-full px-1.5 text-[11px] font-bold text-white"
                style={{ background: t.badge.tone === 'gap' ? 'var(--twin-gap)' : 'var(--twin-partial)' }}
                title={t.badge.tone === 'gap' ? 'Gap checks failed' : 'Checks failed'}
              >
                {t.badge.n}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

function Ribbon({ twin, history }: { twin: Twin; history: HistoryDay[] }) {
  const w = whatChanged(twin, history);
  if (!w) return <p className="m-0 text-sm text-muted-foreground">The change since the previous saved run appears once a saved run exists before this one.</p>;
  return (
    <div className="desk-panel grid grid-cols-2 overflow-hidden p-0 md:grid-cols-4">
      {w.deltas.map((d) => {
        const tone = !d.worseWhenUp || d.delta === 0 ? null : d.delta > 0 ? 'hsl(var(--desk-bad))' : 'hsl(var(--desk-ok))';
        const v = d.ugx ? `${d.delta > 0 ? '+' : d.delta < 0 ? '−' : ''}${ugx(Math.abs(d.delta))}` : `${d.delta > 0 ? '+' : ''}${int(d.delta)}`;
        return (
          <div key={d.label} className="border-b border-r border-[var(--desk-line-color)] px-4 py-3">
            <div className="desk-figure text-2xl font-extrabold leading-tight" style={tone ? { color: tone } : undefined}>
              {v}
            </div>
            <div className="text-[13px] text-muted-foreground">
              {d.label} since saved run {w.since.runId} ({eat(w.since.runAt)})
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusBar({ counts, total, small }: { counts: Partial<Record<NodeStatus, number>>; total: number; small?: boolean }) {
  return (
    <div className={`flex ${small ? 'h-2' : 'h-3.5'} overflow-hidden rounded-full bg-[var(--desk-surface)]`} aria-hidden>
      {STATUS_ORDER.map((s) => (
        <span key={s} className="block h-full" style={{ width: `${(100 * (counts[s] ?? 0)) / (total || 1)}%`, background: statusColour(s) }} />
      ))}
    </div>
  );
}

const STATE_COLOUR = { gap: 'var(--twin-gap)', partial: 'var(--twin-partial)', verified: 'var(--twin-verified)' };

function LaneTiles({ p, onView }: { p: TwinPayload; onView: (v: View) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {p.lanes.map((l) => (
        <button
          key={l.key}
          type="button"
          onClick={() => isLaneKey(l.key) && onView(l.key)}
          className={`desk-panel block w-full p-4 text-left ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
        >
          <div className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: STATE_COLOUR[laneState(l)] }} aria-hidden />
            <h3 className="m-0 text-base font-semibold text-foreground">{copy(l.label)}</h3>
          </div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">Owner: {l.owner}</div>
          <div className="my-2">
            <StatusBar counts={l} total={l.nodes} small />
          </div>
          <div className="text-[13px] text-foreground">
            {int(l.nodes)} nodes, {int(l.gap)} gaps.{' '}
            {l.checks ? `${int(l.failed)} of ${int(l.checks)} checks failed${l.gap_failed ? `, ${int(l.gap_failed)} of them gaps.` : '.'}` : 'No daily checks yet.'}
          </div>
          {isRedacted(p, l.key) && <div className="mt-1 text-[13px] text-muted-foreground">{PARTNER_LIMITED}.</div>}
          <dl className="m-0 mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[13px]">
            {l.metrics.map((m) => (
              <div key={m.label} className="contents">
                <dt className="text-muted-foreground">{copy(m.label)}</dt>
                <dd className="m-0 text-right font-medium tabular-nums text-foreground">{metricValue(m)}</dd>
              </div>
            ))}
          </dl>
        </button>
      ))}
    </div>
  );
}

function LaneHead({ p, lane, board }: { p: TwinPayload; lane: LaneKey; board: boolean }) {
  const l: TwinLane | undefined = p.lanes.find((x) => x.key === lane);
  if (!l) return null;
  return (
    <section>
      <h2 className={`${board ? 'text-2xl' : 'text-xl'} m-0 font-semibold tracking-tight text-foreground`}>{copy(l.label)}</h2>
      <p className={`${board ? 'text-base' : 'text-sm'} m-0 mb-3 mt-1 max-w-[75ch] text-muted-foreground`}>
        Owner: {l.owner}. {copy(l.note)}
      </p>
      {isRedacted(p, lane) && (
        <p className="m-0 mb-3 text-sm font-medium text-foreground" role="note">
          {PARTNER_LIMITED}. This screen shows the lane&rsquo;s totals only.
        </p>
      )}
      <div className="desk-panel grid grid-cols-2 overflow-hidden p-0 md:grid-cols-5">
        {l.metrics.map((m) => (
          <div key={m.label} className="border-b border-r border-[var(--desk-line-color)] px-4 py-3">
            <div className="desk-figure text-2xl font-extrabold leading-tight">{metricValue(m)}</div>
            <div className="text-[13px] text-muted-foreground">{copy(m.label)}</div>
          </div>
        ))}
        <div className="border-b border-r border-[var(--desk-line-color)] px-4 py-3">
          <div className="desk-figure text-2xl font-extrabold leading-tight" style={l.gap_failed > 0 ? { color: 'hsl(var(--desk-bad))' } : undefined}>
            {int(l.failed)} of {int(l.checks)}
          </div>
          <div className="text-[13px] text-muted-foreground">checks failed, {int(l.gap_failed)} of them gaps</div>
        </div>
      </div>
    </section>
  );
}

function Checks({ p, lane, board }: { p: TwinPayload; lane: LaneKey | null; board: boolean }) {
  const all = laneChecks(p, lane);
  const ordered = useMemo(() => orderChecks(all), [all]);
  const guards = useMemo(() => guardsByCheck(p.nodes), [p.nodes]);
  const failed = ordered.filter((c) => !c.ok);
  const passed = ordered.filter((c) => c.ok);
  if (!all.length) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        {lane && isRedacted(p, lane) ? `${PARTNER_LIMITED}.` : lane === 'collections' ? 'This lane has no daily checks yet. It is the next one to build out.' : 'No daily checks here.'}
      </p>
    );
  }
  return (
    <>
      {failed.length === 0 && <p className="m-0 text-sm text-muted-foreground">Every check passed in this window.</p>}
      <div className="grid gap-2.5">
        {failed.map((c) => {
          const tone = c.severity === 'gap' ? 'var(--twin-gap)' : 'var(--twin-partial)';
          const text = c.severity === 'gap' ? 'hsl(var(--desk-bad))' : 'hsl(var(--desk-warn))';
          return (
            <div key={c.key} data-sev={c.severity} className="desk-panel grid grid-cols-[72px_1fr] gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[90px_1fr]" style={{ borderLeft: `4px solid ${tone}` }}>
              <div className={`${board ? 'text-3xl' : 'text-2xl'} row-span-2 font-extrabold leading-none tabular-nums`} style={{ color: text }}>
                {int(c.value)}
              </div>
              <div className={`${board ? 'text-base' : 'text-sm'} font-semibold text-foreground`}>
                <span className="mr-2 text-xs font-bold uppercase tracking-wide" style={{ color: text }}>
                  {c.severity === 'gap' ? 'Gap' : 'Watch'}
                </span>
                {copy(c.label)}
                {c.detail ? <span className="font-normal text-muted-foreground"> ({copy(c.detail)})</span> : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {c.rec && (
                  <>
                    <b className="font-semibold text-foreground">Recommendation:</b> {copy(c.rec)}
                  </>
                )}
                {c.owner ? ` Owner: ${c.owner}.` : ''}
                {guards[c.key] ? ` Guards ${guards[c.key].join(', ')}.` : ''}
              </div>
            </div>
          );
        })}
      </div>
      {passed.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className={`cursor-pointer rounded text-muted-foreground ${FOCUS}`}>{int(passed.length)} checks passed</summary>
          <ul className="mt-2 columns-1 gap-6 pl-5 text-muted-foreground md:columns-2">
            {passed.map((c) => (
              <li key={c.key} className="list-disc">
                {copy(c.label)}
                {c.detail ? ` (${copy(c.detail)})` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Health({ p, board }: { p: TwinPayload; board: boolean }) {
  const k = p.kpis;
  const m = p.money;
  const c = p.chain30;
  const t = p.totals;
  const n = (v: number | null | undefined) => v ?? 0;
  const passes = n(k.sc_pass) + n(k.ao_pass) + n(k.to_pass) + n(k.lo_pass);
  const backs = n(k.sc_reject) + n(k.ao_back) + n(k.to_back) + n(k.lo_back) + n(k.coo_back);
  const items: { v: string; k: string; alert?: boolean }[] = [
    { v: `${int(k.submitted)} + ${int(k.resubmitted)}`, k: 'new and resubmitted requests' },
    { v: int(passes), k: `desk passes; ${int(backs)} sent back or rejected` },
    { v: int(k.coo_push), k: `pushed to funders by the COO; ${int(k.demoted)} demoted` },
    { v: ugx(m.funded_ugx), k: `${int(m.funded_n)} funded in the window` },
    { v: ugx(m.landlord_paid_ugx), k: `${int(m.landlord_paid_n)} landlord payouts completed` },
    { v: pct(c.funder_claim, c.funded_n), k: `of ${int(c.funded_n)} fundings in 30 days carry a funder claim` },
    { v: pct(c.paid_24h, c.funded_n), k: 'of 30-day fundings paid the landlord within 24 h' },
    { v: c.median_days !== null && c.median_days !== undefined ? `${c.median_days} days` : '—', k: `median submit to funding (p90 ${c.p90_days ?? '—'})` },
    { v: int(t.gap_checks_failed), k: 'gap checks failed', alert: n(t.gap_checks_failed) > 0 },
    { v: int(t.needs_open), k: 'decisions waiting', alert: n(t.needs_open) > 0 },
  ];
  return (
    <>
      <div className="desk-panel grid grid-cols-2 overflow-hidden p-0 md:grid-cols-3 xl:grid-cols-5">
        {items.map((it) => (
          <div key={it.k} className="border-b border-r border-[var(--desk-line-color)] px-4 py-3">
            <div className={`${board ? 'text-3xl' : 'text-2xl'} desk-figure font-extrabold leading-tight`} style={it.alert ? { color: 'hsl(var(--desk-bad))' } : undefined}>
              {it.v}
            </div>
            <div className="text-[13px] text-muted-foreground">{it.k}</div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <StatusBar counts={t as Partial<Record<NodeStatus, number>>} total={n(t.nodes)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-4 text-[13px] text-muted-foreground">
        {STATUS_ORDER.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: statusColour(s) }} aria-hidden />
            {STATUS_LABEL[s]} {int(t[s] ?? 0)}
          </span>
        ))}
        <span>
          {int(t.nodes)} nodes ({int(t.objects)} objects, {int(t.actions)} actions), {int(t.links)} links
        </span>
      </div>
    </>
  );
}

function Needs({ p, board }: { p: TwinPayload; board: boolean }) {
  const lanes = new Map(p.lanes.map((l) => [l.key, isLaneKey(l.key) ? LANE_SHORT[l.key] : copy(l.label)]));
  if (!p.needs.length) return <p className="m-0 text-sm text-muted-foreground">No open decisions.</p>;
  return (
    <ol className="m-0 grid list-none gap-2 p-0">
      {orderNeeds(p.needs).map((n) => {
        const tags = [n.priority === 1 ? 'Answer first' : null, lanes.get(n.lane) ?? n.lane, n.kind === 'rule' ? 'a rule to set' : null, n.source ? `raised by ${n.source}` : 'raised by the twin'].filter(Boolean);
        return (
          <li key={n.id} className="desk-panel grid grid-cols-[44px_1fr] gap-x-3 px-4 py-3" style={n.priority === 1 ? { borderLeft: '4px solid var(--twin-gap)' } : undefined}>
            <span className="text-xl font-extrabold text-muted-foreground tabular-nums">{n.id}</span>
            <div className="min-w-0 space-y-1">
              <div className={`${board ? 'text-base' : 'text-sm'} text-foreground`}>{copy(n.question)}</div>
              <div className="text-xs text-muted-foreground">{tags.join(' · ')}</div>
              {n.lean && <div className="text-sm text-muted-foreground"><b className="font-semibold text-foreground">Recommendation:</b> {copy(n.lean)}</div>}
              {n.evidence && <div className="text-sm text-muted-foreground"><b className="font-semibold text-foreground">Evidence:</b> {copy(n.evidence)}</div>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Table({ caption, head, rows }: { caption?: string; head: string[]; rows: (string | number | null | undefined)[][] }) {
  return (
    <div className="desk-panel overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="px-3 pt-2 text-left text-[13px] font-semibold text-foreground">{caption}</caption>}
        <thead>
          <tr className="text-left text-[13px] text-muted-foreground">
            {head.map((h, i) => (
              <th key={h} className={`px-3 py-2 font-medium ${i ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[var(--desk-line-color)]">
              {r.map((c, j) => (
                <td key={j} className={`px-3 py-1.5 ${j ? 'text-right tabular-nums' : 'text-foreground'}`}>
                  {c === null || c === undefined ? '' : typeof c === 'number' ? int(c) : c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LaneTables({ p, lane }: { p: TwinPayload; lane: LaneKey }) {
  const m: Nums = p.money;
  const k: Nums = p.kpis;
  const pa: Nums = p.partner;
  const ps: Nums = p.partnerState;
  const pair = (a: number | null | undefined, b: number | null | undefined) => `${int(a)} / ${int(b)}`;
  if (lane === 'pipeline') {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Table caption="Desks" head={['Desk', 'Waiting now', 'Acted in window']} rows={p.desks.map((d) => [`${d.desk}${d.queue > 0 && d.acted === 0 ? ' (no action)' : ''}`, d.queue, d.acted])} />
        <Table caption="Stages now" head={['Stage', 'Requests', 'UGX']} rows={p.queues.map((q) => [stageLabel(q.status), q.n, q.ugx])} />
        <Table
          caption="Moves in the window"
          head={['Move', 'Count']}
          rows={[
            ['Submitted / resubmitted', pair(k.submitted, k.resubmitted)],
            ['Service Centre pass / reject', pair(k.sc_pass, k.sc_reject)],
            ['Agent Ops pass / back', pair(k.ao_pass, k.ao_back)],
            ['Tenant Ops pass / back', pair(k.to_pass, k.to_back)],
            ['Landlord Ops pass / back', pair(k.lo_pass, k.lo_back)],
            ['COO push / back', pair(k.coo_push, k.coo_back)],
            ['Demoted from the funders board', k.demoted],
            ['Funded', m.funded_n],
          ]}
        />
        <Table caption="Stage moves" head={['Move', 'Count', 'UGX', 'Time (EAT)']} rows={p.flow.map((f) => [`${stageLabel(f.from)} → ${stageLabel(f.to)}`, f.n, f.ugx, `${f.first}–${f.last}`])} />
      </div>
    );
  }
  if (lane === 'partner') {
    if (isRedacted(p, 'partner')) return <p className="m-0 text-sm font-medium text-foreground">{PARTNER_LIMITED}.</p>;
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Table
          caption="Partner side in the window"
          head={['Measure', 'Count', 'UGX']}
          rows={[
            ['New partner portfolios', pa.portfolios_new_n, pa.portfolios_new_ugx],
            ['Pending funder portfolios', pa.pending_portfolios_new_n, pa.pending_portfolios_new_ugx],
            ['Funder commitments', pa.commitments_new_n, pa.commitments_new_ugx],
            ['Funder holds on tenants', pa.claims_new_n, pa.claims_new_ugx],
            ['Returns credits raised', pa.roi_ops_n, pa.roi_ops_ugx],
            ['Returns credits approved', pa.roi_approved_n, pa.roi_approved_ugx],
            ['Proxy settlements to partners', pa.settlements_n, pa.settlements_ugx],
            ['Empty-house reservations', pa.allocations_n, pa.allocations_ugx],
            ['Promissory notes entered', m.promissory_new_n, m.promissory_new_ugx],
            ['Promissory notes approved', m.promissory_approved_n, m.promissory_approved_ugx],
            ['Investment withdrawals', pa.investment_withdrawals_n, pa.investment_withdrawals_ugx],
          ]}
        />
        <Table
          caption="Partner Ops activity and state"
          head={['Measure', 'Count', 'UGX']}
          rows={[
            ['Field officers assigned', pa.field_officers_assigned_n, null],
            ['Partner Ops follow-ups', pa.partner_followups_n, null],
            ['Funder release notices', pa.release_notices_n, null],
            ['Active partner portfolios now', ps.active_portfolios, ps.active_principal_ugx],
            ['Not verified by the CFO', ps.active_not_cfo_verified, null],
            ['Payout date already passed', ps.active_roi_date_past, null],
          ]}
        />
      </div>
    );
  }
  if (lane === 'landlord') {
    return (
      <Table
        caption="Landlord payment in the window"
        head={['Measure', 'Count', 'UGX']}
        rows={[
          ['Landlord payouts completed', m.landlord_paid_n, m.landlord_paid_ugx],
          ['Landlord payouts failed', m.payout_failed_n, m.payout_failed_ugx],
          ['Funded requests recalled', k.recalled, null],
        ]}
      />
    );
  }
  if (lane === 'collections') {
    return (
      <Table
        caption="Repayment in the window"
        head={['Measure', 'Count']}
        rows={[
          ['Plans gone live (landlord paid)', k.plans_live],
          ['Plans completed', k.completed],
        ]}
      />
    );
  }
  if (lane === 'money') {
    return (
      <Table
        caption="Money in the window"
        head={['Measure', 'Count', 'UGX']}
        rows={[
          ['Withdrawals paid', m.withdrawals_n, m.withdrawals_ugx],
          ['Special advances disbursed', m.special_adv_disbursed_n, m.special_adv_disbursed_ugx],
          ['Ledger money in', m.gl_n, m.gl_in],
          ['Ledger money out', null, m.gl_out],
          ['Ledger entries without idempotency key', m.gl_no_idem, null],
          ['Solvency bypasses', m.gl_solvency_bypass, null],
          ['Corrections', p.governance.corrections_n, p.governance.corrections_ugx],
          ['Pool reserve moves', p.governance.pool_reserve_moves_n, p.governance.pool_reserve_moves_ugx],
        ]}
      />
    );
  }
  return (
    <Table
      caption="Controls in the window"
      head={['Measure', 'Count']}
      rows={[
        ['System changes', m.system_changes],
        ['System changes with no approver', m.system_changes_no_approver],
        ['Switch changes', m.switch_changes],
        ['Switch changes with no actor', m.switch_changes_no_actor],
        ['Config changes', p.governance.config_changes_n],
        ['Backups run', m.backups],
        ['Backups not successful', m.backups_not_success],
        ['Audit events', m.ops_events],
        ['Audit events without explanation', m.ops_events_unexplained],
      ]}
    />
  );
}

type NodeFilter = { s: 'all' | NodeStatus; k: 'all' | 'object' | 'action' };

function NodeTable({ p, lane, onPick }: { p: TwinPayload; lane: LaneKey | null; onPick: (id: string) => void }) {
  const [f, setF] = useState<NodeFilter>({ s: 'all', k: 'all' });
  const rows = laneNodes(p, lane).filter((n) => (f.s === 'all' || n.status === f.s) && (f.k === 'all' || n.kind === f.k));
  const chip = (label: string, on: boolean, set: () => void) => (
    <button
      key={label}
      type="button"
      aria-pressed={on}
      onClick={set}
      className={`desk-pill border px-3 py-1 text-[13px] ${CALM} ${FOCUS} ${on ? 'border-foreground bg-foreground text-background' : 'border-[var(--desk-line-color)] hover:bg-[var(--desk-surface-hover)]'}`}
    >
      {label}
    </button>
  );
  return (
    <>
      {lane && isRedacted(p, lane) && <p className="m-0 mb-2 text-sm text-muted-foreground">{PARTNER_LIMITED}.</p>}
      <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Node filters">
        {chip('All statuses', f.s === 'all', () => setF({ ...f, s: 'all' }))}
        {STATUS_ORDER.map((s) => chip(STATUS_LABEL[s], f.s === s, () => setF({ ...f, s })))}
        {chip('Objects and actions', f.k === 'all', () => setF({ ...f, k: 'all' }))}
        {chip('Objects', f.k === 'object', () => setF({ ...f, k: 'object' }))}
        {chip('Actions', f.k === 'action', () => setF({ ...f, k: 'action' }))}
      </div>
      <div className="desk-panel overflow-x-auto p-0">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left text-[13px] text-muted-foreground">
              {['ID', 'Name', 'Type', 'Status', 'Owner', 'Evidence source', 'Note'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id} className="border-t border-[var(--desk-line-color)] align-top">
                <td className="px-3 py-1.5 text-muted-foreground">{n.id}</td>
                <td className="px-3 py-1.5">
                  <button type="button" onClick={() => onPick(n.id)} className={`rounded p-0 text-left underline underline-offset-4 ${FOCUS}`}>
                    {n.name}
                  </button>
                </td>
                <td className="px-3 py-1.5">{n.kind}</td>
                <td className="px-3 py-1.5">
                  <StatusPill status={n.status} />
                </td>
                <td className="px-3 py-1.5">{n.owner}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{n.source}</td>
                <td className="px-3 py-1.5 text-muted-foreground">{copy(n.note)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 mt-1 text-xs text-muted-foreground">{int(rows.length)} shown</p>
    </>
  );
}

function LinkTable({ p, lane }: { p: TwinPayload; lane: LaneKey | null }) {
  const names = new Map(p.nodes.map((n) => [n.id, n.name]));
  const ls = laneLinks(p, lane);
  return (
    <details className="text-sm">
      <summary className={`cursor-pointer rounded text-muted-foreground ${FOCUS}`}>{lane ? `Show the ${int(ls.length)} links that touch this lane` : `Show all ${int(ls.length)} links`}</summary>
      <div className="mt-2">
        <Table head={['#', 'From', 'Link', 'To']} rows={ls.map((l) => [l.id, names.get(l.from) ?? l.from, l.label, names.get(l.to) ?? l.to])} />
      </div>
    </details>
  );
}

function Footer({ twin, history }: { twin: Twin; history: HistoryDay[] }) {
  const p = twin.payload;
  const h = history.filter((x) => x.totals.gap !== undefined || x.checksFailed !== null);
  const W = 420;
  const H = 90;
  const max = Math.max(1, ...h.map((r) => Math.max(r.totals.gap ?? 0, r.checksFailed ?? 0)));
  const x = (i: number) => (10 + (i * (W - 20)) / Math.max(1, h.length - 1)).toFixed(1);
  const y = (v: number | null | undefined) => (H - ((v ?? 0) / max) * (H - 10)).toFixed(1);
  return (
    <footer className="space-y-3 pt-4 text-[13px] text-muted-foreground">
      <p className="m-0 max-w-[90ch]">
        {twin.runId ? `Saved run ${twin.runId}` : 'Live view'} covers {p.windowLabel}
        {p.durationMs !== null ? ` and took ${int(p.durationMs)} ms` : ''}. The database saves one run every day at 08:00 EAT; people and accounts appear only as roles or
        masked labels.
        {p.errors.length ? ` Sections that failed this run: ${p.errors.join(', ')}.` : ''}
      </p>
      {h.length >= 2 ? (
        <svg viewBox={`0 0 ${W} ${H + 22}`} className="block h-auto w-full max-w-[420px]" role="img" aria-label="Gap nodes and failed checks per day">
          <polyline points={h.filter((r) => r.totals.gap !== undefined).map((r) => `${x(h.indexOf(r))},${y(r.totals.gap)}`).join(' ')} fill="none" stroke="var(--twin-gap)" strokeWidth={2} />
          <polyline points={h.map((r, i) => `${x(i)},${y(r.checksFailed)}`).join(' ')} fill="none" stroke="var(--twin-partial)" strokeWidth={2} />
          <text x={10} y={H + 18} fontSize={12} fill="var(--twin-muted)">
            Gap nodes (red) and failed checks (amber), last {h.length} days
          </text>
        </svg>
      ) : (
        <p className="m-0">The trend line appears from the second saved day.</p>
      )}
    </footer>
  );
}

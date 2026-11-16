import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Pause, Play, RotateCcw, X } from 'lucide-react';
import { CALM, FOCUS, prefersReducedMotion } from '../deskTheme';
import {
  STATIONS,
  buildDots,
  clockAt,
  copy,
  hourActivity,
  int,
  moneyLanes,
  stageLabel,
  stationPanel,
  ugx,
  waitingNow,
  type Dot,
  type LaneKey,
  type Stop,
  type TwinFlow,
  type TwinPayload,
} from './twinModel';
import type { LiveMove } from './useTwin';

/**
 * The 24-hour river, always on top. One dot per stage move, replayed hour by
 * hour; a day loops in 30 seconds. Above a desk: waiting now. Below: moved on.
 * The red basin collects sent-back, rejected and recalled moves; the strip
 * under it is money and partner activity by hour.
 *
 * Tap (or Enter / Space on) a desk, the basin or an hour for its panel. A live
 * stage event sends one extra dot across straight away.
 *
 * The animation writes SVG attributes from requestAnimationFrame, so React
 * does not re-render every frame.
 */

const LOOP_SECONDS = 30;
const LIVE_MS = 1_600;
const X0 = 70;
const DX = 132;
const RY = 150;
const POOL_Y = 252;
const MONEY_Y = 318;
const CW = (1120 - 230) / 24;
const sx = (i: number) => X0 + i * DX;

function at(stop: Stop, jitter: number) {
  if (stop === 'pool') return { x: 600 + jitter * 22, y: POOL_Y };
  if (stop === 'end') return { x: 1180, y: RY + jitter };
  return { x: sx(stop), y: RY + jitter };
}
const ease = (a: number) => (a < 0.5 ? 2 * a * a : 1 - Math.pow(-2 * a + 2, 2) / 2);
function pos(from: Stop, to: Stop, jitter: number, a: number, back: boolean) {
  const A = at(from, jitter);
  const B = at(to, jitter);
  const e = ease(a);
  const x = A.x + (B.x - A.x) * e;
  if (back || from === 'pool' || to === 'pool') {
    const cy = (A.y + B.y) / 2 + (from === 'pool' ? -40 : 40);
    return { x, y: (1 - e) * (1 - e) * A.y + 2 * (1 - e) * e * cy + e * e * B.y };
  }
  return { x, y: A.y + (B.y - A.y) * e };
}

type Panel = { kind: 'station'; at: number | 'pool' } | { kind: 'hour'; h: number } | null;

export function TwinRiver({
  payload,
  board,
  liveMoves = [],
  onShowNode,
  onOpenLane,
  laneLabel,
}: {
  payload: TwinPayload;
  board: boolean;
  liveMoves?: LiveMove[];
  /** "Show on the map": select this node and scroll to the map. */
  onShowNode?: (id: string) => void;
  /** "Open the lane". */
  onOpenLane?: (lane: LaneKey) => void;
  laneLabel?: (lane: LaneKey) => string;
}) {
  const dots = useMemo<Dot[]>(() => buildDots(payload.hourly), [payload.hourly]);
  const waiting = useMemo(() => waitingNow(payload.queues), [payload.queues]);
  const money = useMemo(() => moneyLanes(payload.hourly), [payload.hourly]);
  const moneyTotals = useMemo(() => Array.from({ length: 24 }, (_, h) => money.reduce((t, m) => t + (m.counts[h] ?? 0), 0)), [money]);
  const noQueues = payload.queues.length === 0;

  const reduced = useMemo(() => prefersReducedMotion(), []);
  const [playing, setPlaying] = useState(!reduced);
  const [panel, setPanel] = useState<Panel>(null);
  const t = useRef(reduced ? 24 : 0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const liveRef = useRef(liveMoves);
  liveRef.current = liveMoves;

  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  const liveRefs = useRef<Map<number, SVGCircleElement | null>>(new Map());
  const outRefs = useRef<(SVGTextElement | null)[]>([]);
  const cellRefs = useRef<(SVGCircleElement | null)[]>([]);
  const poolRef = useRef<SVGTextElement | null>(null);
  const clockRef = useRef<HTMLSpanElement | null>(null);
  const scrubRef = useRef<HTMLInputElement | null>(null);

  const paint = useRef<() => void>(() => {});
  paint.current = () => {
    const now = t.current;
    const out = STATIONS.map(() => 0);
    let pool = 0;
    dots.forEach((d, i) => {
      if (typeof d.from === 'number' && now >= d.start) out[d.from]++;
      if (d.kind === 'back' && now >= d.start + d.dur) pool++;
      const node = dotRefs.current[i];
      if (!node) return;
      const a = (now - d.start) / d.dur;
      if (a <= 0 || a >= 1) {
        node.setAttribute('opacity', '0');
        return;
      }
      const p = pos(d.from, d.to, d.jitter, a, d.kind === 'back');
      node.setAttribute('cx', p.x.toFixed(1));
      node.setAttribute('cy', p.y.toFixed(1));
      node.setAttribute('opacity', '0.9');
    });
    out.forEach((n, i) => {
      const node = outRefs.current[i];
      if (node) node.textContent = `${int(n)} moved`;
    });
    if (poolRef.current) poolRef.current.textContent = int(pool);
    cellRefs.current.forEach((c, h) => {
      if (!c) return;
      const tot = moneyTotals[h];
      c.setAttribute('fill-opacity', h < now ? (tot ? '0.85' : '0.3') : tot ? '0.2' : '0.12');
    });
    if (clockRef.current) clockRef.current.textContent = clockAt(payload.hours, now);
    if (scrubRef.current && document.activeElement !== scrubRef.current) scrubRef.current.value = String(Math.min(24, now));
  };

  const paintLive = (ts: number) => {
    for (const m of liveRef.current) {
      const node = liveRefs.current.get(m.id);
      if (!node) continue;
      const a = (ts - m.at) / LIVE_MS;
      if (a <= 0 || a >= 1) {
        node.setAttribute('opacity', '0');
        continue;
      }
      const p = pos(m.from, m.to, 0, a, m.to === 'pool');
      node.setAttribute('cx', p.x.toFixed(1));
      node.setAttribute('cy', p.y.toFixed(1));
      node.setAttribute('opacity', '1');
    }
  };

  useEffect(() => {
    let raf = 0;
    let last: number | null = null;
    const tick = (ts: number) => {
      if (playingRef.current) {
        if (last !== null) t.current += ((ts - last) / 1000) * (24 / LOOP_SECONDS);
        if (t.current >= 25) t.current = 0; // a short hold at the end, then loop
        last = ts;
        paint.current();
      } else last = null;
      paintLive(ts);
      raf = requestAnimationFrame(tick);
    };
    paint.current();
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dots]);

  const replay = () => {
    t.current = 0;
    setPlaying(true);
    paint.current();
  };
  const seek = (v: number) => {
    t.current = v;
    setPlaying(false);
    paint.current();
  };
  const openHour = (h: number) => {
    setPanel({ kind: 'hour', h });
    seek(h + 0.5);
  };

  const hit = (label: string, open: () => void) => ({
    className: 'twin-hit',
    tabIndex: 0,
    role: 'button',
    'aria-label': label,
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    },
  });

  const selected = panel?.kind === 'station' && typeof panel.at === 'number' ? panel.at : null;
  const btn = `desk-pill inline-flex items-center gap-1.5 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-sm font-medium ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`;

  return (
    <div className="desk-panel p-3 sm:p-4">
      <div className="overflow-x-auto">
        <svg viewBox="0 44 1200 312" className="block h-auto w-full min-w-[880px]" role="group" aria-label="The last 24 hours: rent requests moving through the desks. Each desk, the basin and each hour can be opened.">
          <path d={`M20 ${RY} H1180`} stroke="var(--twin-bed)" strokeWidth={34} strokeLinecap="round" fill="none" />
          <path d={`M60 ${POOL_Y} H1120`} stroke="var(--twin-pool)" strokeWidth={22} strokeLinecap="round" fill="none" />
          <text x={60} y={POOL_Y + 28} fontSize={12.5} fill="var(--twin-muted)">
            Sent back, rejected or recalled
          </text>
          <text ref={poolRef} x={1120} y={POOL_Y + 28} fontSize={13} textAnchor="end" fill="var(--twin-back)" fontWeight={700}>
            0
          </text>
          {selected !== null && <circle cx={sx(selected)} cy={RY} r={15} fill="none" stroke="var(--twin-fwd)" strokeWidth={3} pointerEvents="none" />}
          {STATIONS.map((s, i) => (
            <g key={s.key} pointerEvents="none">
              <line x1={sx(i)} y1={RY - 34} x2={sx(i)} y2={RY + 34} stroke="var(--twin-line)" strokeWidth={2} />
              <circle cx={sx(i)} cy={RY} r={7} fill="var(--twin-surface)" stroke="var(--twin-fwd)" strokeWidth={2.5} />
              <text x={sx(i)} y={RY - 72} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--twin-ink)">
                {s.label}
              </text>
              {s.q.length > 0 && !noQueues && (
                <text x={sx(i)} y={RY - 46} textAnchor="middle" fontSize={20} fontWeight={800} fill="var(--twin-ink)" className="tabular-nums">
                  {int(waiting[i].n)}
                </text>
              )}
              <text ref={(el) => void (outRefs.current[i] = el)} x={sx(i)} y={RY + 58} textAnchor="middle" fontSize={13} fill="var(--twin-muted)" className="tabular-nums">
                0 moved
              </text>
            </g>
          ))}
          <g pointerEvents="none">
            <text x={60} y={MONEY_Y + 4} fontSize={12.5} fill="var(--twin-muted)">
              Money by hour
            </text>
            {moneyTotals.map((tot, h) => (
              <g key={h}>
                <circle
                  ref={(el) => void (cellRefs.current[h] = el)}
                  cx={230 + h * CW + CW / 2}
                  cy={MONEY_Y}
                  r={tot ? Math.min(9, 2.5 + Math.sqrt(tot) * 1.4) : 1.6}
                  fill="var(--twin-money)"
                  fillOpacity={0.15}
                />
                {h % 3 === 0 && (
                  <text x={230 + h * CW + CW / 2} y={MONEY_Y + 20} textAnchor="middle" fontSize={11} fill="var(--twin-muted)">
                    {payload.hours[h]}
                  </text>
                )}
              </g>
            ))}
          </g>
          <g pointerEvents="none">
            {dots.map((d, i) => (
              <circle key={i} ref={(el) => void (dotRefs.current[i] = el)} r={4.2} fill={d.kind === 'back' ? 'var(--twin-back)' : 'var(--twin-fwd)'} opacity={0} />
            ))}
            {liveMoves.map((m) => (
              <circle
                key={`live-${m.id}`}
                ref={(el) => void liveRefs.current.set(m.id, el)}
                r={6}
                fill={m.to === 'pool' ? 'var(--twin-back)' : 'var(--twin-fwd)'}
                stroke="var(--twin-surface)"
                strokeWidth={2}
                opacity={0}
              />
            ))}
          </g>
          <g>
            {STATIONS.map((s, i) => (
              <rect key={s.key} x={sx(i) - DX / 2 + 4} y={62} width={DX - 8} height={162} rx={8} {...hit(`${s.label}: show what happened here`, () => setPanel({ kind: 'station', at: i }))} />
            ))}
            <rect x={60} y={POOL_Y - 16} width={1080} height={34} rx={10} {...hit('Sent back, rejected or recalled: show the moves', () => setPanel({ kind: 'station', at: 'pool' }))} />
            {moneyTotals.map((_, h) => (
              <rect key={h} x={230 + h * CW} y={MONEY_Y - 14} width={CW} height={28} rx={4} {...hit(`Hour from ${payload.hours[h] || h}: show what happened`, () => openHour(h))} />
            ))}
          </g>
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-1 pt-3">
        <div className="min-w-[5.5ch] leading-none">
          <span ref={clockRef} className={`${board ? 'text-4xl' : 'text-3xl'} font-extrabold tabular-nums text-foreground`}>
            --:--
          </span>
          <span className="block pt-1 text-xs text-muted-foreground">EAT</span>
        </div>
        <button type="button" className={btn} onClick={() => setPlaying(!playing)} aria-pressed={!playing}>
          {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className={btn} onClick={replay}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Replay
        </button>
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={24}
          step={0.05}
          defaultValue={t.current}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Hour of the 24-hour window"
          className="min-w-[180px] flex-1"
        />
      </div>
      <div className="flex flex-wrap gap-4 px-1 pt-2 text-xs text-muted-foreground">
        <Key colour="var(--twin-fwd)">Moved forward</Key>
        <Key colour="var(--twin-back)">Sent back, rejected or recalled</Key>
        <Key colour="var(--twin-money)">Money and partner events</Key>
        <span>Above a desk: waiting now. Below: moved on in the window. Tap a desk, the basin or an hour.</span>
      </div>

      {panel && (
        <div className="mt-3 rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-4" role="region" aria-label="River detail">
          {panel.kind === 'hour' ? (
            <HourPanel payload={payload} h={panel.h} onClose={() => setPanel(null)} />
          ) : (
            <StationPanelView
              payload={payload}
              at={panel.at}
              onClose={() => setPanel(null)}
              onShowNode={onShowNode}
              onOpenLane={onOpenLane}
              laneLabel={laneLabel}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Key({ colour, children }: { colour: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: colour }} aria-hidden />
      {children}
    </span>
  );
}

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="mb-2 flex items-start justify-between gap-3">
      <h3 className="m-0 text-base font-semibold text-foreground">{title}</h3>
      <button type="button" onClick={onClose} className={`desk-pill inline-flex items-center gap-1 border border-[var(--desk-line-color)] px-2.5 py-1 text-xs ${CALM} ${FOCUS}`}>
        <X className="h-3 w-3" aria-hidden /> Close
      </button>
    </div>
  );
}

function HourPanel({ payload, h, onClose }: { payload: TwinPayload; h: number; onClose: () => void }) {
  const rows = hourActivity(payload.hourly, h);
  return (
    <>
      <PanelHead title={`The hour from ${payload.hours[h] || h} EAT`} onClose={onClose} />
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">Nothing was recorded in this hour.</p>
      ) : (
        <table className="w-full max-w-md border-collapse text-sm">
          <thead>
            <tr className="text-left text-[13px] text-muted-foreground">
              <th className="py-1 pr-3 font-medium">What happened</th>
              <th className="py-1 text-right font-medium">Count</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-[var(--desk-line-color)]">
                <td className="py-1 pr-3">{r.label}</td>
                <td className="py-1 text-right tabular-nums">{int(r.n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function FlowTable({ title, rows, side }: { title: string; rows: TwinFlow[]; side: 'to' | 'from' }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="pb-1 text-left text-[13px] font-semibold text-foreground">{title}</caption>
        <thead>
          <tr className="text-left text-[13px] text-muted-foreground">
            <th className="py-1 pr-3 font-medium">Move</th>
            <th className="py-1 pr-3 text-right font-medium">Count</th>
            <th className="py-1 pr-3 text-right font-medium">UGX</th>
            <th className="py-1 text-right font-medium">Time (EAT)</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-muted-foreground">
                None in the window.
              </td>
            </tr>
          )}
          {rows.map((f, i) => (
            <tr key={i} className="border-t border-[var(--desk-line-color)]">
              <td className="py-1 pr-3">{side === 'to' ? `To ${stageLabel(f.to)}` : `From ${stageLabel(f.from)}`}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{int(f.n)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{int(f.ugx)}</td>
              <td className="py-1 text-right tabular-nums">{f.no_actor ? `${int(f.no_actor)} with no actor` : `${f.first}${f.last ? `–${f.last}` : ''}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StationPanelView({
  payload,
  at,
  onClose,
  onShowNode,
  onOpenLane,
  laneLabel,
}: {
  payload: TwinPayload;
  at: number | 'pool';
  onClose: () => void;
  onShowNode?: (id: string) => void;
  onOpenLane?: (lane: LaneKey) => void;
  laneLabel?: (lane: LaneKey) => string;
}) {
  const s = stationPanel(payload, at);
  const sum = (rows: TwinFlow[]) => rows.reduce((t, f) => t + f.n, 0);
  const facts: string[] = [];
  if (s.waiting) facts.push(`Waiting now: ${int(s.waiting.n)} (${ugx(s.waiting.ugx)})`);
  facts.push(`${s.isPool ? 'Sent back, rejected or recalled' : 'Moved out'} in the window: ${int(sum(s.out))}`);
  if (s.waiting || s.isPool) facts.push(`${s.isPool ? 'Brought back by agents' : 'Came in'}: ${int(sum(s.inn))}`);
  if (s.overdue !== null) facts.push(`Past the time limit: ${int(s.overdue)}`);
  const nodeName = (id: string) => payload.nodes.find((n) => n.id === id)?.name;
  const firstNode = s.nodes.find((id) => nodeName(id));
  const action = `desk-pill inline-flex items-center border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-sm font-medium ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`;

  return (
    <>
      <PanelHead title={s.title} onClose={onClose} />
      <p className="m-0 mb-3 text-sm text-muted-foreground">{facts.join('. ')}.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <FlowTable title={s.isPool ? 'Sent back, rejected or recalled' : 'Went out'} rows={s.out} side={s.isPool ? 'from' : 'to'} />
        {(s.waiting || s.isPool) && <FlowTable title={s.isPool ? 'Brought back by agents' : 'Came in'} rows={s.inn} side={s.isPool ? 'to' : 'from'} />}
      </div>
      {s.checks.length > 0 && (
        <>
          <h4 className="mb-1 mt-3 text-sm font-semibold text-foreground">Checks at this point</h4>
          <ul className="m-0 list-none space-y-1.5 p-0 text-sm">
            {s.checks.map((c) => (
              <li key={c.key}>
                <span className="twin-pill mr-2" style={{ background: c.ok ? 'var(--twin-verified)' : c.severity === 'gap' ? 'var(--twin-gap)' : 'var(--twin-partial)' }}>
                  {c.ok ? 'Pass' : c.severity === 'gap' ? 'Gap' : 'Watch'}
                </span>
                {copy(c.label)}: {int(c.value)}
                {c.detail ? ` (${copy(c.detail)})` : ''}
                {!c.ok && c.rec && <div className="pl-1 pt-0.5 text-[13px] text-muted-foreground">Recommendation: {copy(c.rec)}{c.owner ? ` Owner: ${c.owner}.` : ''}</div>}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {onShowNode && firstNode && (
          <button type="button" className={action} onClick={() => onShowNode(firstNode)}>
            Show on the map
          </button>
        )}
        {onOpenLane && (
          <button type="button" className={action} onClick={() => onOpenLane(s.lane)}>
            Open the {laneLabel ? laneLabel(s.lane) : s.lane} lane
          </button>
        )}
      </div>
      {s.nodes.some(nodeName) && (
        <p className="m-0 mt-2 text-[13px] text-muted-foreground">
          Related nodes: {s.nodes.filter(nodeName).map((id) => `${id} ${nodeName(id)}`).join(', ')}.
        </p>
      )}
    </>
  );
}

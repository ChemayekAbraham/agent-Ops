import { useMemo, useState } from 'react';
import { CALM, FOCUS } from '../deskTheme';
import {
  DESK_NAME,
  MAP_H,
  MAP_W,
  STATUS_LABEL,
  STATUS_ORDER,
  copy,
  decisionsForNode,
  deskForNode,
  eat,
  gapChains,
  int,
  layoutMap,
  type NodeStatus,
  type TwinNode,
  type TwinCheck,
  type TwinPayload,
} from './twinModel';

/**
 * The company as objects (circles), actions (diamonds around the object they
 * change) and links (lines), coloured by status. Gap nodes pulse. In a lane
 * view that lane is lit and the rest dimmed. Selecting a node shows owner,
 * evidence, note, its checks with recommendations, its links, the actions that
 * change it and the desk where action is taken. The twin has no action buttons.
 *
 * "Gaps only" reads the gaps: links between two gaps are red at full strength,
 * every other link fades, gap actions carry their names, and the side panel
 * groups the gaps into chains of gaps that touch.
 */

export const statusColour = (s: NodeStatus) => `var(--twin-${s === 'not_started' ? 'ns' : s})`;

export function StatusPill({ status }: { status: NodeStatus }) {
  return (
    <span className="twin-pill" style={{ background: statusColour(status) }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

type Filter = 'all' | 'gap' | 'objects';

export function TwinMap({
  payload,
  board,
  lane,
  selected,
  onSelect,
  onOpenDesk,
}: {
  payload: TwinPayload;
  board: boolean;
  /** Lane view: this lane lit, the rest dimmed. Null in the company view. */
  lane: string | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Opens the desk where action is taken; absent on the boardroom display. */
  onOpenDesk?: (desk: string) => void;
}) {
  const layout = useMemo(() => layoutMap(payload.nodes, payload.links), [payload.nodes, payload.links]);
  const checks = useMemo(() => new Map<string, TwinCheck>(payload.checks.map((c) => [c.key, c])), [payload.checks]);
  const [filter, setFilter] = useState<Filter>('all');

  const look = (id: string) => {
    const p = layout.byId.get(id);
    if (!p) return { on: false, inLane: false };
    const inLane = !lane || p.node.lane === lane;
    const on = inLane && (filter === 'all' || (filter === 'gap' && p.node.status === 'gap') || (filter === 'objects' && p.node.kind === 'object'));
    return { on, inLane };
  };
  const chip = (f: Filter, label: string) => (
    <button
      key={f}
      type="button"
      aria-pressed={filter === f}
      onClick={() => setFilter(f)}
      className={`desk-pill border px-3 py-1 text-[13px] ${CALM} ${FOCUS} ${
        filter === f ? 'border-foreground bg-foreground text-background' : 'border-[var(--desk-line-color)] hover:bg-[var(--desk-surface-hover)]'
      }`}
    >
      {label}
    </button>
  );

  const sel = selected ? layout.byId.get(selected)?.node ?? null : null;
  const gaps = payload.nodes.filter((n) => n.status === 'gap' && (!lane || n.lane === lane));
  // In "Gaps only", links between two lit gaps are drawn last, in red, at full strength.
  const edges = layout.edges
    .map((e, i) => ({ e, i, gapPair: filter === 'gap' && look(e.a).on && look(e.b).on }))
    .sort((x, y) => Number(x.gapPair) - Number(y.gapPair));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="desk-panel p-2">
        <div className="flex flex-wrap gap-2 px-2 pb-1 pt-2" role="group" aria-label="Map filters">
          {chip('all', 'Everything')}
          {chip('gap', 'Gaps only')}
          {chip('objects', 'Objects only')}
        </div>
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="block h-auto w-full" role="group" aria-label="Map of objects, actions and links">
          <g>
            {edges.map(({ e, i, gapPair }) => {
              const a = layout.byId.get(e.a)!;
              const b = layout.byId.get(e.b)!;
              const hl = selected !== null && (e.a === selected || e.b === selected);
              const touches = !lane || a.node.lane === lane || b.node.lane === lane;
              const opacity = hl || gapPair ? 1 : filter === 'gap' ? 0.06 : touches ? (filter === 'all' ? 1 : 0.35) : 0.06;
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={gapPair ? 'var(--twin-gap)' : hl ? 'var(--twin-fwd)' : 'var(--twin-line)'}
                  strokeWidth={gapPair ? (e.tether ? 1.8 : 2.4) : hl ? 2.2 : e.tether ? 1 : 1.3}
                  strokeDasharray={e.tether ? '2 3' : undefined}
                  opacity={opacity}
                  data-gap-link={gapPair ? '' : undefined}
                >
                  <title>{`${a.node.name} ${e.label} ${b.node.name}`}</title>
                </line>
              );
            })}
          </g>
          <g>
            {layout.placed.map(({ node, x, y, r }) => {
              const { on, inLane } = look(node.id);
              const isSel = node.id === selected;
              const pick = () => onSelect(isSel ? null : node.id);
              const pulse = node.status === 'gap' && on;
              return (
                <g
                  key={node.id}
                  className="twin-node"
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSel}
                  aria-label={`${node.id} ${node.name}, ${node.kind}, ${STATUS_LABEL[node.status]}`}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      pick();
                    }
                  }}
                  opacity={on || isSel ? 1 : inLane ? 0.22 : 0.08}
                >
                  <title>{`${node.id} ${node.name} (${STATUS_LABEL[node.status]})`}</title>
                  {pulse && (
                    <circle
                      className="twin-pulse"
                      cx={x}
                      cy={y}
                      r={node.kind === 'object' ? r + 2 : 7}
                      fill="none"
                      stroke="var(--twin-gap)"
                      strokeWidth={node.kind === 'object' ? 2 : 1.5}
                      style={{ ['--r0' as string]: `${node.kind === 'object' ? r + 2 : 6}px`, ['--r1' as string]: `${node.kind === 'object' ? r + 13 : 13}px` }}
                    />
                  )}
                  {node.kind === 'object' ? (
                    <>
                      <circle className="twin-shape" cx={x} cy={y} r={r} fill={statusColour(node.status)} stroke={isSel ? 'var(--twin-ink)' : 'var(--twin-surface)'} strokeWidth={isSel ? 3 : 2} />
                      <text x={x} y={y + r + 12} textAnchor="middle" fontSize={board ? 12 : 10.5} fill="var(--twin-ink)">
                        {node.name.length > 20 ? `${node.name.slice(0, 19)}…` : node.name}
                      </text>
                    </>
                  ) : (
                    <rect
                      className="twin-shape"
                      x={x - 4.5}
                      y={y - 4.5}
                      width={9}
                      height={9}
                      rx={1.5}
                      fill={statusColour(node.status)}
                      stroke={isSel ? 'var(--twin-ink)' : 'none'}
                      strokeWidth={isSel ? 2 : 0}
                      transform={`rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})`}
                    />
                  )}
                  {node.kind === 'action' && filter === 'gap' && node.status === 'gap' && on && (
                    <text
                      x={x > MAP_W - 160 ? x - 8 : x + 8}
                      y={y + 3.5}
                      textAnchor={x > MAP_W - 160 ? 'end' : 'start'}
                      fontSize={board ? 11 : 9.5}
                      fill="var(--twin-ink)"
                      stroke="var(--twin-surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                      className="twin-action-name"
                    >
                      {node.name.length > 26 ? `${node.name.slice(0, 25)}…` : node.name}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <div className="flex flex-wrap gap-4 px-2 pb-2 text-xs text-muted-foreground">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <i className={`twin-dot-${s} inline-block h-2.5 w-2.5 rounded-full`} aria-hidden />
              {STATUS_LABEL[s]}
            </span>
          ))}
          <span>Circles are objects; diamonds are the actions that change them.</span>
        </div>
      </div>

      <aside className="desk-panel max-h-[680px] overflow-auto p-4 text-sm" aria-live="polite">
        {sel ? (
          <NodeDetail id={sel.id} payload={payload} checks={checks} onPick={onSelect} onOpenDesk={onOpenDesk} />
        ) : filter === 'gap' ? (
          <ReadingGaps payload={payload} lane={lane} onPick={onSelect} />
        ) : (
          <>
            <h3 className="m-0 text-lg font-semibold text-foreground">Select a node</h3>
            <p className="mt-1 text-muted-foreground">
              {lane ? 'This lane is lit; the rest of the company is dimmed so the links between lanes stay visible. Gaps pulse.' : 'Gaps pulse.'}
            </p>
            <h4 className="mt-4 font-semibold text-foreground">
              {lane ? 'Gaps in this lane' : 'Gaps today'} ({int(gaps.length)})
            </h4>
            <ul className="mt-1 list-none space-y-1 p-0">
              {gaps.map((n) => (
                <li key={n.id}>
                  <button type="button" onClick={() => onSelect(n.id)} className={`rounded p-0 text-left underline-offset-4 hover:underline ${FOCUS}`}>
                    <span className="text-muted-foreground">{n.id}</span> {n.name}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

/** The collapsible key above the map: shapes, colours and the marks used across the twin. */
export function MapKey() {
  const swatch = 'inline-flex w-8 shrink-0 justify-center';
  const row = 'flex items-center gap-2';
  return (
    <details className="desk-panel mb-3 px-4 py-2 text-sm">
      <summary className={`cursor-pointer select-none rounded font-semibold text-foreground ${FOCUS}`}>How to read the map</summary>
      <div className="grid gap-x-8 gap-y-1.5 pb-2 pt-3 text-muted-foreground sm:grid-cols-2">
        <div className={row}>
          <span className={swatch} aria-hidden>
            <svg width="16" height="16"><circle cx="8" cy="8" r="6" fill="var(--twin-ink)" opacity="0.75" /></svg>
          </span>
          Circle: a thing the company keeps (a request, a wallet, a person).
        </div>
        <div className={row}>
          <span className={swatch} aria-hidden>
            <svg width="16" height="16"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="var(--twin-ink)" opacity="0.75" transform="rotate(45 8 8)" /></svg>
          </span>
          Diamond: an action, placed around the thing it changes.
        </div>
        <div className={row}>
          <span className={swatch} aria-hidden>
            <svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke="var(--twin-ink)" strokeWidth="1.5" opacity="0.6" /></svg>
          </span>
          Line: a link between two nodes; dotted ties an action to its thing.
        </div>
        <div className={row}>
          <span className={swatch} aria-hidden>
            <svg width="20" height="20"><circle cx="10" cy="10" r="5" fill="var(--twin-gap)" /><circle cx="10" cy="10" r="8.5" fill="none" stroke="var(--twin-gap)" strokeWidth="1.2" opacity="0.6" /></svg>
          </span>
          Pulsing ring: a gap.
        </div>
        <div className={row}>
          <span className={swatch} aria-hidden>
            <svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke="var(--twin-gap)" strokeWidth="2.4" /></svg>
          </span>
          Red line in Gaps only: two gaps that touch.
        </div>
        <div className={row}>
          <span className={`${swatch} gap-1`} aria-hidden>
            <span className="inline-block h-4 w-3 rounded-sm border border-[var(--desk-line-color)]" style={{ borderLeft: '4px solid hsl(var(--desk-bad))' }} />
            <span className="inline-block h-4 w-3 rounded-sm border border-[var(--desk-line-color)]" style={{ borderLeft: '4px solid hsl(var(--desk-warn))' }} />
          </span>
          Red-edged check: a gap. Amber-edged: a watch item.
        </div>
        <div className={`${row} sm:col-span-2`}>
          <span className="font-medium text-foreground">Status colours:</span>
          {STATUS_ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <i className={`twin-dot-${s} inline-block h-2.5 w-2.5 rounded-full`} aria-hidden />
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
        <div className="sm:col-span-2">
          In the river, the number above each desk is how many are waiting there now; the number below is how many moved on in the window.
        </div>
      </div>
    </details>
  );
}

function ReadingGaps({ payload, lane, onPick }: { payload: TwinPayload; lane: string | null; onPick: (id: string) => void }) {
  const { chains, alone } = useMemo(() => gapChains(payload.nodes, payload.links, lane), [payload.nodes, payload.links, lane]);
  const total = chains.reduce((n, c) => n + c.gaps.length, 0) + alone.length;
  const gapBtn = (n: TwinNode) => (
    <button type="button" onClick={() => onPick(n.id)} className={`rounded p-0 text-left underline-offset-4 hover:underline ${FOCUS}`}>
      <span className="text-muted-foreground">{n.id}</span> {n.name}
      {n.kind === 'action' && <span className="text-muted-foreground"> (action)</span>}
    </button>
  );
  return (
    <div>
      <h3 className="m-0 text-lg font-semibold text-foreground">Reading the gaps</h3>
      <ul className="mt-2 list-none space-y-1 p-0 text-muted-foreground" aria-label="Legend">
        <li className="flex items-center gap-2">
          <svg width="22" height="10" aria-hidden>
            <line x1="1" y1="5" x2="21" y2="5" stroke="var(--twin-gap)" strokeWidth="2.4" />
          </svg>
          Red line: two gaps linked to each other.
        </li>
        <li className="flex items-center gap-2">
          <svg width="22" height="10" aria-hidden>
            <line x1="1" y1="5" x2="21" y2="5" stroke="var(--twin-gap)" strokeWidth="1.8" strokeDasharray="2 3" />
          </svg>
          Dotted red: a gap action and the gap it changes.
        </li>
        <li className="flex items-center gap-2">
          <svg width="22" height="12" aria-hidden>
            <rect x="7" y="2" width="8" height="8" rx="1.5" fill="var(--twin-gap)" transform="rotate(45 11 6)" />
          </svg>
          Diamonds are actions; gap actions are named.
        </li>
        <li>Faded: not a gap, or a link that does not join two gaps.</li>
      </ul>

      <p className="mb-0 mt-3 text-foreground">
        {int(total)} {total === 1 ? 'gap' : 'gaps'}
        {lane ? ' in this lane' : ''}: {int(chains.length)} {chains.length === 1 ? 'chain' : 'chains'} of gaps that touch, {int(alone.length)} on{' '}
        {alone.length === 1 ? 'its' : 'their'} own.
      </p>

      {chains.map((c, ci) => (
        <section key={c.gaps[0].id} className="mt-4" aria-label={`Chain ${ci + 1}`}>
          <h4 className="m-0 font-semibold text-foreground">
            Chain {ci + 1}: {int(c.gaps.length)} gaps
          </h4>
          <ul className="mt-1 list-none space-y-1 p-0">
            {c.gaps.map((n) => (
              <li key={n.id}>{gapBtn(n)}</li>
            ))}
          </ul>
          <p className="mb-0 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">How they are linked</p>
          <ul className="mt-1 list-none space-y-0.5 p-0 text-muted-foreground">
            {c.pairs.map((p) => (
              <li key={`${p.a.id}|${p.b.id}|${p.how}`}>
                {p.a.name} <span style={{ color: 'var(--twin-gap)' }}>{p.how}</span> {p.b.name}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {alone.length > 0 && (
        <section className="mt-4" aria-label="Gaps on their own">
          <h4 className="m-0 font-semibold text-foreground">Gaps on their own ({int(alone.length)})</h4>
          <ul className="mt-1 list-none space-y-1 p-0">
            {alone.map((n) => (
              <li key={n.id}>{gapBtn(n)}</li>
            ))}
          </ul>
        </section>
      )}
      {total === 0 && <p className="mb-0 mt-2 text-muted-foreground">No gaps{lane ? ' in this lane' : ''} in this window.</p>}
    </div>
  );
}

function NodeDetail({
  id,
  payload,
  checks,
  onPick,
  onOpenDesk,
}: {
  id: string;
  payload: TwinPayload;
  checks: Map<string, TwinCheck>;
  onPick: (id: string | null) => void;
  onOpenDesk?: (desk: string) => void;
}) {
  const node = payload.nodes.find((n) => n.id === id)!;
  const name = (x: string) => payload.nodes.find((n) => n.id === x)?.name ?? x;
  const guarded = node.checks.map((k) => checks.get(k)).filter((c): c is TwinCheck => !!c);
  const links = payload.links.filter((l) => l.from === id || l.to === id);
  const actions = payload.nodes.filter((n) => n.on === id);
  const decisions = decisionsForNode(payload, id);
  const desk = deskForNode(node);
  const linkBtn = `inline rounded p-0 text-left underline underline-offset-4 ${FOCUS}`;
  const rows: [string, React.ReactNode][] = [
    ['Owner', node.owner || '—'],
    ['Evidence', node.source || '—'],
    ['Note', copy(node.note) || '—'],
  ];
  if (node.baseline && node.baseline !== node.status) rows.push(['Baseline', `${STATUS_LABEL[node.baseline]} (changed today)`]);
  if (node.on)
    rows.push([
      'Changes',
      <button key="on" type="button" onClick={() => onPick(node.on)} className={linkBtn}>
        {node.on} {name(node.on)}
      </button>,
    ]);

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <h3 className="m-0 text-lg font-semibold leading-tight text-foreground">{node.name}</h3>
        <button type="button" onClick={() => onPick(null)} className={`desk-label shrink-0 rounded underline underline-offset-4 ${FOCUS}`}>
          Close
        </button>
      </div>
      <p className="mb-3 mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {node.id} · {node.kind}
        {node.kind === 'object' && node.family ? ` · ${node.family}` : ''} <StatusPill status={node.status} />
      </p>
      <dl className="m-0 grid grid-cols-[84px_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="m-0 text-foreground">{v}</dd>
          </div>
        ))}
      </dl>

      <h4 className="mb-1 mt-4 font-semibold text-foreground">Checks</h4>
      {guarded.length ? (
        <ul className="m-0 list-none space-y-2 p-0">
          {guarded.map((c) => (
            <li key={c.key}>
              <span className="font-semibold" style={{ color: c.ok ? 'hsl(var(--desk-ok))' : c.severity === 'gap' ? 'hsl(var(--desk-bad))' : 'hsl(var(--desk-warn))' }}>
                {c.ok ? 'Pass' : c.severity === 'gap' ? 'Gap' : 'Watch'}:
              </span>{' '}
              {copy(c.label)} = {int(c.value)}
              {c.detail ? ` (${copy(c.detail)})` : ''}
              {!c.ok && c.rec && (
                <div className="pt-0.5 text-muted-foreground">
                  Recommendation: {copy(c.rec)}
                  {c.owner ? ` Owner: ${c.owner}.` : ''}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted-foreground">No daily check guards this node yet; its status comes from the evidence map.</p>
      )}

      <h4 className="mb-1 mt-4 font-semibold text-foreground">Decisions waiting that affect it</h4>
      {decisions.waiting.length ? (
        <ul className="m-0 list-none space-y-2 p-0">
          {decisions.waiting.map((n) => (
            <li key={n.id} style={n.priority === 1 ? { borderLeft: '3px solid var(--twin-gap)', paddingLeft: 8 } : undefined}>
              <span className="text-muted-foreground">{n.id}.</span> {copy(n.question)}
              {n.priority === 1 && <span className="font-semibold" style={{ color: 'var(--twin-gap)' }}> Answer first.</span>}
              {n.lean && <div className="pt-0.5 text-muted-foreground">Recommendation: {copy(n.lean)}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted-foreground">None waiting.</p>
      )}

      <h4 className="mb-1 mt-4 font-semibold text-foreground">Rulings that apply</h4>
      {decisions.rulings.length ? (
        <ul className="m-0 list-none space-y-2 p-0">
          {decisions.rulings.map((r) => (
            <li key={r.id} style={{ borderLeft: '3px solid var(--twin-verified)', paddingLeft: 8 }}>
              <span className="font-semibold text-foreground">{copy(r.question)}:</span> {copy(r.ruling)}
              <div className="pt-0.5 text-xs text-muted-foreground">
                {[r.source || null, r.decidedAt ? `decided ${eat(r.decidedAt)}` : null].filter(Boolean).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-muted-foreground">No ruling applies yet.</p>
      )}

      {links.length > 0 && (
        <>
          <h4 className="mb-1 mt-4 font-semibold text-foreground">Links</h4>
          <ul className="m-0 list-none space-y-1 p-0">
            {links.map((l) => {
              const other = l.from === id ? l.to : l.from;
              return (
                <li key={l.id}>
                  {l.from === id ? `${node.name} ${l.label} ` : ''}
                  <button type="button" onClick={() => onPick(other)} className={linkBtn}>
                    {name(other)}
                  </button>
                  {l.to === id ? ` ${l.label} ${node.name}` : ''}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {actions.length > 0 && (
        <>
          <h4 className="mb-1 mt-4 font-semibold text-foreground">Actions that change it</h4>
          <ul className="m-0 list-none space-y-1 p-0">
            {actions.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <StatusPill status={a.status} />
                <button type="button" onClick={() => onPick(a.id)} className={`rounded p-0 text-left underline-offset-4 hover:underline ${FOCUS}`}>
                  {a.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {desk && onOpenDesk && (
        <p className="mb-0 mt-4">
          <button type="button" onClick={() => onOpenDesk(desk)} className={`rounded p-0 text-left font-medium text-[hsl(var(--primary))] underline underline-offset-4 ${FOCUS}`}>
            Act on the {DESK_NAME[desk] ?? desk} desk
          </button>
        </p>
      )}
    </div>
  );
}

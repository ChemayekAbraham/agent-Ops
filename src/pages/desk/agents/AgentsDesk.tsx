import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { CALM, FOCUS, LABEL, PANEL, statusText, type Status } from '../deskTheme';
import { readableError } from '../reviewApi';
import { DeskCallButton } from '../deskCall';
import { SkeletonRows } from '../Skeleton';
import { NOT_ASSIGNED, isNotAssigned } from '../deskAccess';
import { Chip, EmptyState, ErrorLine, GradeBadge, LoadingRows, Segmented, atLeast, moneyFull, pctWhole, useBreakpoint } from '../ui';
import { AgentSheet } from './AgentSheet';
import { FILTERS, isBelow, plansText, useAgentPortfolio, type PortfolioFilter, type PortfolioRow, type PortfolioSummary } from './agentPortfolioApi';

/**
 * /desk/agents (E61): every agent's rent plans in one list — what they hold,
 * what is due so far, what they collected — and whether they may bring new
 * requests. A row opens the agent's sheet; 📞 calls them from the company line.
 */

const SEARCH_DELAY_MS = 300;

/** The server's rule without its internal code: "AGENT-ELIG v2 (E61): collected …" → "Collected …". */
export function ruleText(rule: string): string {
  const t = rule.replace(/^AGENT-ELIG[^:]*:\s*/i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const SUMMARY_CHIPS: { key: keyof PortfolioSummary; label: string; tone: Status }[] = [
  { key: 'agents', label: 'agents', tone: 'idle' },
  { key: 'eligible', label: 'eligible', tone: 'ok' },
  { key: 'below_50', label: 'below 50%', tone: 'bad' },
  { key: 'new', label: 'new', tone: 'idle' },
  { key: 'frozen_requests', label: 'requests frozen', tone: 'warn' },
];

export function SummaryChips({ summary, loading }: { summary: PortfolioSummary | undefined; loading: boolean }) {
  return (
    <div data-agent-summary style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} aria-busy={loading || undefined}>
      {SUMMARY_CHIPS.map((c) => (
        <Chip key={c.key} size="sm" tone={c.tone} strong={c.key === 'agents'}>
          <span className="tabular-nums">{loading || !summary ? '—' : summary[c.key].toLocaleString('en')}</span> {c.label}
        </Chip>
      ))}
    </div>
  );
}

function PctCell({ v }: { v: number | null }) {
  return (
    <span data-pct className={`tabular-nums ${isBelow(v) ? `font-semibold ${statusText.bad}` : 'text-foreground'}`}>
      {v === null || v === undefined ? '—' : pctWhole(v)}
    </span>
  );
}

const callTarget = (r: PortfolioRow) => ({ requestId: null, desk: 'agent_ops', subject: 'agent' as const, calleeId: r.agent_id, name: r.name, phone: r.phone });

/** The call button sits inside a tappable row: its press must not also open the sheet. */
function CallCell({ row }: { row: PortfolioRow }) {
  return (
    <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
      <DeskCallButton target={callTarget(row)} />
    </span>
  );
}

const onActivate = (open: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    open();
  }
};

const COLUMNS: { label: string; right?: boolean; title?: string }[] = [
  { label: 'Agent' },
  { label: 'Grade' },
  { label: 'Plans', title: 'Active / completed / not started', right: true },
  { label: 'Plan value', right: true },
  { label: 'Due so far', right: true },
  { label: 'Collected', right: true },
  { label: '%', title: 'Collected against due so far', right: true },
  { label: 'Arrears', title: 'Arrears on active plans', right: true },
  { label: 'Open requests', right: true },
  { label: 'Frozen requests', right: true },
  { label: 'Call', right: true },
];

const cell = 'px-3 py-2.5 whitespace-nowrap';
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en'));

function AgentTable({ rows, loading, onOpen, board }: { rows: PortfolioRow[]; loading: boolean; onOpen: (r: PortfolioRow) => void; board: boolean }) {
  return (
    <div className={`${board ? 'max-h-[60vh]' : 'max-h-[70vh]'} overflow-auto rounded-xl border border-[var(--desk-line-color)]`}>
      <table className={`w-full border-collapse ${board ? 'text-base' : 'text-sm'} tabular-nums`}>
        <thead className="desk-thead">
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.label}
                scope="col"
                title={c.title}
                className={`sticky top-0 z-10 border-b border-[var(--desk-line-color)] px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${c.right ? 'text-right' : 'text-left'}`}
              >
                {c.label}
                {c.label === 'Plans' && <span className={`${LABEL} block font-normal`}>active / done / not started</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && <SkeletonRows cols={COLUMNS.length} rows={8} />}
          {!loading &&
            rows.map((r) => (
              <tr
                key={r.agent_id}
                data-agent={r.agent_id}
                tabIndex={0}
                role="button"
                aria-label={`Open ${r.name ?? 'this agent'}`}
                onClick={() => onOpen(r)}
                onKeyDown={onActivate(() => onOpen(r))}
                className={`cursor-pointer border-b border-[var(--desk-line-soft)] last:border-0 hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
              >
                <td className={`${cell} font-medium text-foreground`} style={{ whiteSpace: 'normal', minWidth: '10rem' }}>
                  {r.name ?? '—'}
                </td>
                <td className={cell}>
                  <GradeBadge grade={r.grade} />
                </td>
                <td className={`${cell} text-right text-foreground`}>{plansText(r)}</td>
                <td className={`${cell} text-right text-foreground`}>{moneyFull(r.plan_value)}</td>
                <td className={`${cell} text-right text-foreground`}>{moneyFull(r.due_so_far)}</td>
                <td className={`${cell} text-right text-foreground`}>{moneyFull(r.collected)}</td>
                <td className={`${cell} text-right`}>
                  <PctCell v={r.pct} />
                </td>
                <td className={`${cell} text-right ${Number(r.arrears_active) > 0 ? statusText.warn : 'text-foreground'}`}>{moneyFull(r.arrears_active)}</td>
                <td className={`${cell} text-right text-foreground`}>{num(r.open_requests)}</td>
                <td className={`${cell} text-right ${Number(r.frozen_requests) > 0 ? `font-semibold ${statusText.bad}` : 'text-foreground'}`}>{num(r.frozen_requests)}</td>
                <td className={`${cell} text-right`}>
                  <CallCell row={r} />
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function Fig({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <span className={LABEL}>{label}</span>
      <span className="tabular-nums text-foreground" style={{ whiteSpace: 'nowrap' }}>
        {children}
      </span>
    </span>
  );
}

/** Below md: one card per agent, the same figures stacked. */
function AgentCards({ rows, loading, onOpen }: { rows: PortfolioRow[]; loading: boolean; onOpen: (r: PortfolioRow) => void }) {
  if (loading) return <LoadingRows rows={5} height={112} label="Loading agents" />;
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0 }}>
      {rows.map((r) => (
        <li
          key={r.agent_id}
          data-agent={r.agent_id}
          tabIndex={0}
          role="button"
          aria-label={`Open ${r.name ?? 'this agent'}`}
          onClick={() => onOpen(r)}
          onKeyDown={onActivate(() => onOpen(r))}
          className={`desk-tile cursor-pointer text-sm ${CALM} ${FOCUS}`}
          style={{ listStyle: 'none', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <GradeBadge grade={r.grade} />
              <span className="font-medium text-foreground" style={{ overflowWrap: 'anywhere' }}>
                {r.name ?? '—'}
              </span>
            </span>
            <CallCell row={r} />
          </span>
          <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
            <Fig label="Plans">{plansText(r)}</Fig>
            <Fig label="Collected %">
              <PctCell v={r.pct} />
            </Fig>
            <Fig label="Plan value">{moneyFull(r.plan_value)}</Fig>
            <Fig label="Due so far">{moneyFull(r.due_so_far)}</Fig>
            <Fig label="Collected">{moneyFull(r.collected)}</Fig>
            <Fig label="Arrears">{moneyFull(r.arrears_active)}</Fig>
          </span>
          {(Number(r.open_requests) > 0 || Number(r.frozen_requests) > 0) && (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Number(r.open_requests) > 0 && <Chip>{num(r.open_requests)} open</Chip>}
              {Number(r.frozen_requests) > 0 && (
                <Chip tone="bad" strong>
                  {num(r.frozen_requests)} frozen
                </Chip>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AgentsDesk({ board }: { board: boolean }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PortfolioFilter>('all');
  const [open, setOpen] = useState<PortfolioRow | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const term = useDebounced(search, SEARCH_DELAY_MS);
  const q = useAgentPortfolio(term, filter);
  const bp = useBreakpoint();
  const cards = !atLeast(bp, 'md');
  const rows = q.data?.rows ?? [];
  const firstLoad = q.isLoading && !q.data;

  return (
    <div className={`space-y-5 ${board ? 'h-full overflow-auto' : ''}`} data-desk-agents>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground" style={{ margin: 0 }}>
          Which agents may bring new requests, and how their tenants are repaying.
        </p>
        <SummaryChips summary={q.data?.summary} loading={firstLoad} />
      </div>

      <section className={`${PANEL} p-4 sm:p-5`} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <label className="relative block w-full sm:w-72" style={{ position: 'relative' }}>
            <span className="sr-only">Search agents by name or phone</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or phone"
              className={`desk-pill h-9 w-full border border-[var(--desk-line-color)] bg-[var(--desk-surface)] pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
            />
          </label>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <Segmented<PortfolioFilter> options={FILTERS} value={filter} onChange={(v) => setFilter(v ?? 'all')} ariaLabel="Show agents" />
          </div>
          {q.isFetching && !firstLoad && <span className={LABEL}>Updating…</span>}
        </div>

        {q.error ? (
          isNotAssigned(q.error) ? (
            <ErrorLine>{NOT_ASSIGNED}</ErrorLine>
          ) : (
            <ErrorLine>The agents could not load: {readableError(q.error)}</ErrorLine>
          )
        ) : !firstLoad && rows.length === 0 ? (
          <EmptyState board={board}>{term.trim() ? `No agent matches “${term.trim()}”.` : 'No agents in this view.'}</EmptyState>
        ) : cards ? (
          <AgentCards rows={rows} loading={firstLoad} onOpen={setOpen} />
        ) : (
          <AgentTable rows={rows} loading={firstLoad} onOpen={setOpen} board={board} />
        )}

        {q.data?.rule && <p className={LABEL} style={{ margin: 0 }}>Rule: {ruleText(q.data.rule)}</p>}
      </section>

      {open && (
        <AgentSheet
          target={{ kind: 'agent', agentId: open.agent_id, name: open.name, phone: open.phone, grade: open.grade }}
          onClose={close}
        />
      )}
    </div>
  );
}

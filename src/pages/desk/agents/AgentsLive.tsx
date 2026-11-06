import { useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { Fold } from '../DeskFrame';
import { GradeBadge } from '../agentGrade';
import { readableError } from '../reviewApi';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { CALM, FOCUS, LABEL, statusGlass, statusText } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { eatTime } from '../ontology/ontologyApi';
import {
  AGENT_WINDOWS,
  agentMatches,
  intakeTone,
  isFlaggedWithOpen,
  openPills,
  pctText,
  rowsForDesk,
  sortAgents,
  submittedIn,
  summaryText,
  todayLineText,
  useAgentsLive,
  windowLabel,
  type AgentLiveRow,
  type AgentsWindow,
} from './agentsApi';

/**
 * "Agents live" on Agent Ops, and the same list as "Incoming from agents" on
 * Service Centre (only agents with something waiting there). Collapsed until
 * opened, so a closed section never queries.
 */

const TITLE: Record<string, string> = { 'agent-ops': 'Agents live', 'service-centre': 'Incoming from agents' };

export const EMPTY_TEXT: Record<string, string> = {
  'agent-ops': 'No agent has submitted a request in this window.',
  'service-centre': 'No agent has a request waiting at the Service Centre.',
};

export const INTAKE_CLASS = { bad: statusText.bad, plain: 'text-foreground', idle: 'text-muted-foreground' } as const;

const ugx = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function pill(active: boolean) {
  return `desk-pill border px-3 py-1 text-xs font-medium ${CALM} ${FOCUS} ${
    active
      ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.18)] text-foreground'
      : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground'
  }`;
}

/** A press anywhere on the row opens the grade popover, unless it landed on a control. */
function openGradeFromRow(e: MouseEvent<HTMLTableRowElement>) {
  const target = e.target as HTMLElement;
  if (target.closest('button, a, input, [role="dialog"]')) return;
  e.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.click();
}

export function AgentRow({ r, w }: { r: AgentLiveRow; w: AgentsWindow }) {
  const flagged = isFlaggedWithOpen(r);
  const pills = openPills(r);
  return (
    <tr className="desk-row cursor-pointer border-t border-[var(--desk-line-color)] align-top" onClick={openGradeFromRow}>
      <td className="px-2 py-1.5">
        <span className="block text-foreground">{r.agent ?? '—'}</span>
        {r.phone && <span className="block font-mono text-xs text-muted-foreground">{r.phone}</span>}
        {(r.flags ?? []).length > 0 && (
          <span className={`block text-xs ${flagged ? statusText.warn : 'text-muted-foreground'}`}>{(r.flags ?? []).join(' · ')}</span>
        )}
      </td>
      <td className="px-2 py-1.5">
        <GradeBadge agentId={r.agent_id} grade={r.grade} weekAgo={r.grade_week_ago} />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{submittedIn(r, w).toLocaleString('en')}</td>
      <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{r.last_submitted_at ? eatTime(r.last_submitted_at) : '—'}</td>
      <td className="px-2 py-1.5">
        {pills.length === 0 ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {pills.map((p) => (
              <span key={p.key} title={`${p.n} open at ${p.name}`} className={`desk-pill border px-1.5 py-0 text-[11px] tabular-nums ${statusGlass.idle}`}>
                {p.short} {p.n}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-foreground">
        {Number(r.funded_30d ?? 0).toLocaleString('en')}
        {r.funded_30d_ugx ? <span className="block text-xs text-muted-foreground">UGX {ugx.format(Number(r.funded_30d_ugx))}</span> : null}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums ${Number(r.bounced_30d ?? 0) > 0 ? statusText.warn : 'text-foreground'}`}>
        {Number(r.bounced_30d ?? 0).toLocaleString('en')}
      </td>
      <td className={`px-2 py-1.5 text-right tabular-nums ${INTAKE_CLASS[intakeTone(r.intake_complete_pct)]}`} data-tone={intakeTone(r.intake_complete_pct)}>
        {pctText(r.intake_complete_pct)}
      </td>
      <td className="px-2 py-1.5 text-foreground">{r.service_centre_person ?? '—'}</td>
    </tr>
  );
}

const HEAD: { label: string; right?: boolean }[] = [
  { label: 'Agent' },
  { label: 'Grade' },
  { label: 'Submitted', right: true },
  { label: 'Last submitted' },
  { label: 'Open by stage' },
  { label: 'Funded 30d', right: true },
  { label: 'Bounced 30d', right: true },
  { label: 'Intake complete', right: true },
  { label: 'SC person' },
];

export function AgentsTable({ rows, w, deskId }: { rows: AgentLiveRow[]; w: AgentsWindow; deskId: string }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => sortAgents(rows, w).filter((r) => agentMatches(r, q)), [rows, w, q]);
  return (
    <div className="space-y-2">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search agent, phone or SC person"
        aria-label="Search agents"
        className={`w-full max-w-sm rounded border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-1.5 text-sm text-foreground ${FOCUS}`}
      />
      {/* Scrolls sideways on narrow screens only; on wide ones nothing clips the grade popover under its badge. */}
      <div className="overflow-x-auto lg:overflow-visible">
        <table className="w-full text-left text-sm">
          <thead className="desk-thead">
            <tr>
              {HEAD.map((h) => (
                <th key={h.label} className={`${LABEL} whitespace-nowrap px-2 py-1.5 font-medium ${h.right ? 'text-right' : ''}`}>
                  {h.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <AgentRow key={r.agent_id} r={r} w={w} />
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">{q ? 'No agent matches.' : EMPTY_TEXT[deskId] ?? EMPTY_TEXT['agent-ops']}</p>
        )}
      </div>
    </div>
  );
}

function AgentsBody({ deskId }: { deskId: string }) {
  const [w, setW] = useState<AgentsWindow>(7);
  const q = useAgentsLive(w);
  const rows = rowsForDesk(q.data?.rows, deskId);
  const scWaiting = rows.reduce((s, r) => s + Number(r.open?.service_centre ?? 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Window" className="flex gap-1.5">
          {AGENT_WINDOWS.map((x) => (
            <button key={String(x)} type="button" aria-pressed={w === x} onClick={() => setW(x)} className={pill(w === x)}>
              {windowLabel(x)}
            </button>
          ))}
        </div>
        {q.data?.generated_at && <span className={LABEL}>Updated {eatTime(q.data.generated_at)}</span>}
      </div>

      {q.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : q.error ? (
        <p className={`text-sm ${statusText.bad}`}>
          {isMissingDbObject(q.error) ? 'Agents live is not available yet.' : `Could not load agents: ${readableError(q.error)}`}
        </p>
      ) : (
        <>
          <p className="text-sm text-foreground">
            {deskId === 'service-centre'
              ? `${rows.length.toLocaleString('en')} agents with requests waiting here · ${scWaiting.toLocaleString('en')} requests`
              : summaryText(q.data?.summary, w)}
          </p>
          <AgentsTable rows={rows} w={w} deskId={deskId} />
        </>
      )}
    </div>
  );
}

/** Mounted once per framed desk; renders on Agent Ops and Service Centre only. */
export function AgentsLiveFold({ deskId, board }: { deskId: string; board: boolean }) {
  const title = TITLE[deskId];
  if (!title) return null;
  return (
    <Fold
      title={title}
      board={board}
      hint={deskId === 'service-centre' ? 'Agents with a request waiting at the Service Centre' : 'Who is submitting, how complete, and where it sits'}
    >
      <AgentsBody deskId={deskId} />
    </Fold>
  );
}

/** Command centre: one line under the money line, linking to Agent Ops. Hidden while it cannot load. */
export function AgentsTodayLine({ board }: { board: boolean }) {
  const q = useAgentsLive('today');
  if (q.error) {
    if (isMissingDbObject(q.error)) logMissingOnce('desk_agents_live', q.error);
    return null;
  }
  if (!q.data) return null;
  return (
    <p className={`${board ? 'text-base' : 'text-sm'}`}>
      <Link to="/desk/agent-ops" className={`rounded text-foreground underline decoration-[hsl(var(--desk-lavender))] underline-offset-4 ${FOCUS}`}>
        {todayLineText(q.data.summary)}
      </Link>
    </p>
  );
}

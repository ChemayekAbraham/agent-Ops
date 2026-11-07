import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import { LABEL, statusText } from './deskTheme';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { Chip, EmptyState, ErrorLine, Fold, LoadingRows, Segmented, DataList, moneyCard, moneyFull, type DataColumn } from './ui';
import { readableError, rpc } from './reviewApi';

/**
 * Agent ranking on Agent Ops: which agents may collect on a new plan
 * (`agent_eligibility_board`). Eligible = collected 50%+ of what was due, or a
 * new agent within the open-request limit.
 */

export type RankingRow = {
  agent_id: string;
  agent: string | null;
  phone: string | null;
  eligible: boolean;
  /** Whole percentage, 0-100. */
  pct: number | null;
  pct_week_ago: number | null;
  due: number | null;
  collected: number | null;
  plans: number | null;
  new_agent: boolean;
  open_requests: number | null;
  open: { service_centre?: number | null; agent_ops?: number | null; ops?: number | null; coo?: number | null; funders_board?: number | null } | null;
  grade: string | null;
};

export type RankingSummary = { eligible_collectors: number | null; below_50: number | null; new_ok: number | null; new_over_limit: number | null };

export type RankingFilter = 'all' | 'eligible' | 'below_50' | 'new';

export const RANKING_FILTERS: { key: RankingFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'eligible', label: 'Eligible' },
  { key: 'below_50', label: 'Below 50%' },
  { key: 'new', label: 'New' },
];

/** The filters, as the summary chips count them. */
export function matchesFilter(r: RankingRow, f: RankingFilter): boolean {
  if (f === 'eligible') return r.eligible;
  if (f === 'below_50') return !r.new_agent && r.pct !== null && Number(r.pct) < 50;
  if (f === 'new') return r.new_agent;
  return true;
}

/** Up/down against a week ago, or null with nothing to compare. */
export function pctTrend(now: number | null, weekAgo: number | null): 'up' | 'down' | 'same' | null {
  if (now === null || weekAgo === null || now === undefined || weekAgo === undefined) return null;
  const a = Math.round(Number(now));
  const b = Math.round(Number(weekAgo));
  return a > b ? 'up' : a < b ? 'down' : 'same';
}

const OPEN_STAGES: { key: keyof NonNullable<RankingRow['open']>; short: string; name: string }[] = [
  { key: 'service_centre', short: 'SC', name: 'Service Centre' },
  { key: 'agent_ops', short: 'AO', name: 'Agent Ops' },
  { key: 'ops', short: 'Ops', name: 'Tenant/Landlord Ops' },
  { key: 'coo', short: 'COO', name: 'COO' },
  { key: 'funders_board', short: 'Funders', name: "the funders' board" },
];

function useEligibilityBoard(enabled: boolean) {
  return useQuery({
    queryKey: ['desk-feed', 'agent-eligibility'],
    enabled,
    queryFn: async (): Promise<{ summary: RankingSummary; rows: RankingRow[] }> => {
      const { data, error } = await rpc('agent_eligibility_board', {});
      if (error) throw error;
      const d = (data ?? {}) as { summary?: RankingSummary; rows?: RankingRow[] };
      return {
        summary: d.summary ?? { eligible_collectors: null, below_50: null, new_ok: null, new_over_limit: null },
        rows: Array.isArray(d.rows) ? d.rows : [],
      };
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: 1,
  });
}

const ugx = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

type Ranked = { r: RankingRow; rank: number };

/** "70%", red under 50% for an agent past the new-agent window, with the week's arrow. */
function PctCell({ r }: { r: RankingRow }) {
  const trend = pctTrend(r.pct, r.pct_week_ago);
  const below = !r.new_agent && r.pct !== null && Number(r.pct) < 50;
  return (
    <span className={`whitespace-nowrap tabular-nums ${below ? statusText.bad : 'text-foreground'}`}>
      {r.pct === null ? '—' : `${Math.round(Number(r.pct))}%`}
      {trend === 'up' && <ArrowUp className={`ml-0.5 inline h-3.5 w-3.5 ${statusText.ok}`} aria-label={`up from ${Math.round(Number(r.pct_week_ago))}% a week ago`} />}
      {trend === 'down' && <ArrowDown className={`ml-0.5 inline h-3.5 w-3.5 ${statusText.bad}`} aria-label={`down from ${Math.round(Number(r.pct_week_ago))}% a week ago`} />}
    </span>
  );
}

function StagePills({ r }: { r: RankingRow }) {
  const open = OPEN_STAGES.filter((st) => Number(r.open?.[st.key] ?? 0) > 0);
  if (open.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {open.map((st) => (
        <Chip key={st.key} title={`${r.open?.[st.key]} open at ${st.name}`} className="tabular-nums">
          {st.short} {fmt('int', r.open?.[st.key])}
        </Chip>
      ))}
    </span>
  );
}

/**
 * One definition, two shapes (ui/DataList): a table from md, cards below.
 *   priority 1  name (with grade and call) and % collected
 *   priority 2  collected / due and plans
 *   priority 3  open requests by stage, under "More" on a card
 */
export const RANKING_COLUMNS: DataColumn<Ranked>[] = [
  {
    key: 'agent',
    label: 'Agent',
    priority: 1,
    text: ({ r, rank }) => `${rank}. ${r.agent ?? ''}`,
    render: ({ r, rank }) => (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <span className="tabular-nums text-muted-foreground">{rank}.</span>
        <span className="text-foreground">{r.agent ?? '—'}</span>
        <GradeBadge agentId={r.agent_id} grade={r.grade} weekAgo={null} />
        <DeskCallButton target={{ requestId: null, desk: 'agent_ops', subject: 'agent', calleeId: r.agent_id, name: r.agent, phone: r.phone }} />
        {r.new_agent && <span className="text-xs text-muted-foreground">New agent · {fmt('int', r.open_requests)} open</span>}
      </span>
    ),
  },
  { key: 'pct', label: 'Collected', priority: 1, align: 'right', text: ({ r }) => (r.pct === null ? '' : `${Math.round(Number(r.pct))}%`), render: ({ r }) => <PctCell r={r} /> },
  {
    key: 'money',
    label: 'Collected / due',
    priority: 2,
    align: 'right',
    text: ({ r }) => `${moneyFull(r.collected ?? 0)} / ${moneyFull(r.due ?? 0)}`,
    render: ({ r }) => (
      <span className="whitespace-nowrap tabular-nums" title={`${moneyFull(r.collected ?? 0)} of ${moneyFull(r.due ?? 0)}`}>
        {moneyCard(r.collected ?? 0)} / {moneyCard(r.due ?? 0)}
      </span>
    ),
  },
  { key: 'plans', label: 'Plans', priority: 2, align: 'right', text: ({ r }) => `${r.plans ?? ''} plans`, render: ({ r }) => <span className="tabular-nums">{fmt('int', r.plans)} plans</span> },
  { key: 'open', label: 'Open by stage', priority: 3, text: () => '', render: ({ r }) => <StagePills r={r} /> },
];

function RankingBody() {
  const q = useEligibilityBoard(true);
  const [filter, setFilter] = useState<RankingFilter>('all');
  // Rank is the position in the server's full order, kept when a filter hides rows.
  const ranked = useMemo(() => (q.data?.rows ?? []).map((r, i) => ({ r, rank: i + 1 })), [q.data]);
  const shown = ranked.filter(({ r }) => matchesFilter(r, filter));

  if (q.isLoading) return <LoadingRows rows={4} height={32} label="Loading the agent ranking" />;
  if (q.error) return <ErrorLine>{readableError(q.error)}</ErrorLine>;
  const s = q.data?.summary;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Chip size="sm" tone="ok">{fmt('int', s?.eligible_collectors)} eligible collectors</Chip>
        <Chip size="sm" tone="bad">{fmt('int', s?.below_50)} below 50%</Chip>
        <Chip size="sm" tone="idle">{fmt('int', s?.new_ok)} new, within limit</Chip>
        <Chip size="sm" tone="warn">{fmt('int', s?.new_over_limit)} new, over limit</Chip>
      </div>
      <Segmented<RankingFilter>
        ariaLabel="Filter agents"
        options={RANKING_FILTERS.map((f) => ({ value: f.key, label: f.label }))}
        value={filter}
        onChange={(f) => f !== null && setFilter(f)}
      />

      <DataList<Ranked>
        label="agents"
        columns={RANKING_COLUMNS}
        rows={shown}
        rowKey={(x) => x.r.agent_id}
        emptyText="No agents in this view."
      />
    </div>
  );
}

/** Above "Agents live" on Agent Ops. */
export function AgentRankingFold({ board }: { board: boolean }) {
  return (
    <Fold title="Agent ranking" board={board} hint="Who may collect on a new plan — 50%+ collected, or new and within the limit">
      <RankingBody />
    </Fold>
  );
}

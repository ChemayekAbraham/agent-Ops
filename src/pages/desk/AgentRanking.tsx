import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import { LABEL, statusText } from './deskTheme';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { Chip, EmptyState, ErrorLine, Fold, LoadingRows, Segmented } from './ui';
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

      {shown.length === 0 ? (
        <EmptyState>No agents in this view.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className={`${LABEL} text-left`}>
                <th className="px-2 py-1.5 text-right font-normal">#</th>
                <th className="px-2 py-1.5 font-normal">Agent</th>
                <th className="px-2 py-1.5 text-right font-normal">Collected</th>
                <th className="px-2 py-1.5 text-right font-normal">Collected / due (UGX)</th>
                <th className="px-2 py-1.5 text-right font-normal">Plans</th>
                <th className="px-2 py-1.5 font-normal">Open by stage</th>
                <th className="px-2 py-1.5 font-normal">Grade</th>
                <th className="px-2 py-1.5 font-normal" aria-label="Call" />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ r, rank }) => {
                const trend = pctTrend(r.pct, r.pct_week_ago);
                const below = !r.new_agent && r.pct !== null && Number(r.pct) < 50;
                return (
                  <tr key={r.agent_id} className="border-t border-[var(--desk-line-color)] align-top">
                    <td className={`${LABEL} px-2 py-1.5 text-right tabular-nums`}>{rank}</td>
                    <td className="px-2 py-1.5">
                      <span className="block text-foreground">{r.agent ?? '—'}</span>
                      {r.new_agent && <span className="text-xs text-muted-foreground">New agent · {fmt('int', r.open_requests)} open</span>}
                    </td>
                    <td className={`whitespace-nowrap px-2 py-1.5 text-right tabular-nums ${below ? statusText.bad : 'text-foreground'}`}>
                      {r.pct === null ? '—' : `${Math.round(Number(r.pct))}%`}
                      {trend === 'up' && <ArrowUp className={`ml-0.5 inline h-3.5 w-3.5 ${statusText.ok}`} aria-label={`up from ${Math.round(Number(r.pct_week_ago))}% a week ago`} />}
                      {trend === 'down' && <ArrowDown className={`ml-0.5 inline h-3.5 w-3.5 ${statusText.bad}`} aria-label={`down from ${Math.round(Number(r.pct_week_ago))}% a week ago`} />}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-foreground">
                      {ugx.format(Number(r.collected ?? 0))} / {ugx.format(Number(r.due ?? 0))}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{fmt('int', r.plans)}</td>
                    <td className="px-2 py-1.5">
                      <span className="flex flex-wrap gap-1" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {OPEN_STAGES.filter((st) => Number(r.open?.[st.key] ?? 0) > 0).map((st) => (
                          <Chip key={st.key} title={`${r.open?.[st.key]} open at ${st.name}`} className="tabular-nums">
                            {st.short} {fmt('int', r.open?.[st.key])}
                          </Chip>
                        ))}
                        {OPEN_STAGES.every((st) => !Number(r.open?.[st.key] ?? 0)) && <span className="text-xs text-muted-foreground">—</span>}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <GradeBadge agentId={r.agent_id} grade={r.grade} weekAgo={null} />
                    </td>
                    <td className="px-2 py-1.5">
                      <DeskCallButton target={{ requestId: null, desk: 'agent_ops', subject: 'agent', calleeId: r.agent_id, name: r.agent, phone: r.phone }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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

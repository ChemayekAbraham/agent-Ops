import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type AgentOpsGranularity = 'daily' | 'weekly' | 'monthly';

export interface AgentOpsSnapshot {
  id: string;
  granularity: string;
  period_start: string;
  period_end: string;
  opening_agents: number;
  new_agents: number;
  removed_agents: number;
  closing_agents: number;
  active_agents_30d: number;
  qualified_at_open: number;
  converted_in_period: number;
  provisional: boolean;
}

export interface AgentOpsReport {
  id: string;
  granularity: string;
  period_start: string;
  period_end: string;
  snapshot_id: string;
  prior_snapshot_id: string | null;
  target_net_agents: number | null;
  status: string;
}

export interface AgentOpsReportWindowData {
  report: AgentOpsReport;
  snapshot: AgentOpsSnapshot;
  priorSnapshot: AgentOpsSnapshot | null;
  periodLabel: string;
}

export function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kampala',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function periodStartFor(granularity: AgentOpsGranularity, today = kampalaToday()): string {
  const date = parseIsoDate(today);
  if (granularity === 'monthly') {
    return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  }
  if (granularity === 'weekly') {
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  }
  return isoDate(date);
}

function formatDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function periodLabel(report: AgentOpsReport): string {
  const start = formatDate(report.period_start);
  return report.period_end === report.period_start
    ? start
    : `${start} to ${formatDate(report.period_end)}`;
}

export function computeGrowthRate(snapshot: AgentOpsSnapshot | null): number | null {
  if (!snapshot || snapshot.opening_agents === 0) return null;
  const netChange = snapshot.new_agents - snapshot.removed_agents;
  return (netChange / snapshot.opening_agents) * 100;
}

export function computeGrowthVariancePp(
  current: AgentOpsSnapshot | null,
  prior: AgentOpsSnapshot | null,
): number | null {
  const currentRate = computeGrowthRate(current);
  const priorRate = computeGrowthRate(prior);
  if (currentRate === null || priorRate === null) return null;
  return currentRate - priorRate;
}

export function useAgentOpsReportWindow(granularity: AgentOpsGranularity) {
  const periodStart = periodStartFor(granularity);

  return useQuery({
    queryKey: ['agent-ops-report-window', granularity, periodStart],
    queryFn: async (): Promise<AgentOpsReportWindowData> => {
      const { data: reportId, error: openError } = await supabase.rpc('agent_ops_open_report', {
        p_granularity: granularity,
        p_period_start: periodStart,
      });
      if (openError) throw openError;
      if (!reportId) throw new Error('The Agent Operations report could not be opened.');

      const { data: reportData, error: reportError } = await supabase
        .from('agent_ops_reports')
        .select('id, granularity, period_start, period_end, snapshot_id, prior_snapshot_id, target_net_agents, status')
        .eq('id', reportId)
        .single();
      if (reportError) throw reportError;

      const report = reportData as AgentOpsReport;
      const snapshotIds = [report.snapshot_id, report.prior_snapshot_id].filter(Boolean);
      const { data: snapshots, error: snapshotsError } = await supabase
        .from('agent_ops_period_snapshots')
        .select('id, granularity, period_start, period_end, opening_agents, new_agents, removed_agents, closing_agents, active_agents_30d, qualified_at_open, converted_in_period, provisional')
        .in('id', snapshotIds);
      if (snapshotsError) throw snapshotsError;

      const rows = (snapshots ?? []) as AgentOpsSnapshot[];
      const snapshot = rows.find((row) => row.id === report.snapshot_id);
      if (!snapshot) throw new Error('The Agent Operations snapshot is unavailable.');

      return {
        report,
        snapshot,
        priorSnapshot: rows.find((row) => row.id === report.prior_snapshot_id) ?? null,
        periodLabel: periodLabel(report),
      };
    },
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

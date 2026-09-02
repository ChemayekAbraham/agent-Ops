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
  stage_onboarded: number;
  stage_training: number;
  stage_qualified: number;
  centres_opening: number;
  centres_opened: number;
  centres_closed: number;
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
  submitted_at?: string | null;
  submitted_by?: string | null;
}

export type AgentOpsZone = 'growth' | 'pipeline';

export interface AgentOpsReportNote {
  id: string;
  zone: string;
  reason_note: string;
}

export interface AgentOpsReportAction {
  id: string;
  zone: string;
  item_text: string;
  owner_staff_id: string | null;
  owner_label: string | null;
  due_date: string | null;
  outcome: string | null;
  outcome_note: string | null;
  carried_from_action_id: string | null;
  created_at: string;
}

export interface AgentOpsAddendum {
  id: string;
  zone: string;
  addendum_text: string;
  created_at: string;
  created_by: string;
  author_name: string | null;
}

export interface AgentOpsPriorAction extends AgentOpsReportAction {
  priorPeriodLabel: string;
  flaggedToReviewer: boolean;
}

export interface AgentOpsStaffOption {
  staffId: string;
  label: string;
}

export interface AgentOpsReportWindowData {
  ready: true;
  periodStart: string;
  report: AgentOpsReport;
  snapshot: AgentOpsSnapshot;
  priorSnapshot: AgentOpsSnapshot | null;
  periodLabel: string;
  notes: Record<AgentOpsZone, AgentOpsReportNote | null>;
  actions: Record<AgentOpsZone, AgentOpsReportAction[]>;
  addenda: Record<AgentOpsZone, AgentOpsAddendum[]>;
  priorNotes: Record<AgentOpsZone, string | null>;
  priorPeriodLabel: string | null;
  priorActions: AgentOpsPriorAction[];
  staffOptions: AgentOpsStaffOption[];
  submittedByName: string | null;
  submittedAt: string | null;
}

/** No snapshot has been computed yet for the selected period. */
export interface AgentOpsReportWindowMissing {
  ready: false;
  reason: 'no_snapshot';
  granularity: AgentOpsGranularity;
  periodStart: string;
}

export type AgentOpsReportWindowResult = AgentOpsReportWindowData | AgentOpsReportWindowMissing;


const MISS_OUTCOMES = new Set(['partly_done', 'not_done', 'partly', 'missed']);

/**
 * Rejected if byte-identical to the same zone's note on the prior report of the
 * same granularity. Compared after trimming only — the text itself is untouched.
 */
export function isIdenticalToPriorNote(draft: string, priorNote: string | null): boolean {
  if (!priorNote) return false;
  return draft.trim() === priorNote.trim();
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

/**
 * Zone B conversion rate. Guarded: a zero (or missing) qualified-at-open base
 * yields null rather than a division by zero.
 */
export function computeConversionRate(snapshot: AgentOpsSnapshot | null): number | null {
  if (!snapshot || snapshot.qualified_at_open === 0) return null;
  return (snapshot.converted_in_period / snapshot.qualified_at_open) * 100;
}

export function centresClosing(snapshot: AgentOpsSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.centres_opening + snapshot.centres_opened - snapshot.centres_closed;
}

export function useAgentOpsReportWindow(granularity: AgentOpsGranularity) {
  const periodStart = periodStartFor(granularity);

  return useQuery({
    queryKey: ['agent-ops-report-window', granularity, periodStart],
    queryFn: async (): Promise<AgentOpsReportWindowResult> => {
      const missing: AgentOpsReportWindowMissing = {
        ready: false,
        reason: 'no_snapshot',
        granularity,
        periodStart,
      };

      const { data: reportId, error: openError } = await supabase.rpc('agent_ops_open_report', {
        p_granularity: granularity,
        p_period_start: periodStart,
      });
      // A period with no computed snapshot is an expected, recoverable state —
      // it renders "not yet computed", never an error card.
      if (openError) {
        if (/snapshot/i.test(openError.message ?? '')) return missing;
        throw openError;
      }
      if (!reportId) return missing;

      const { data: reportData, error: reportError } = await supabase
        .from('agent_ops_reports')
        .select('id, granularity, period_start, period_end, snapshot_id, prior_snapshot_id, target_net_agents, status, submitted_at, submitted_by')
        .eq('id', reportId)
        .single();
      if (reportError) throw reportError;

      const report = reportData as AgentOpsReport;
      const snapshotIds = [report.snapshot_id, report.prior_snapshot_id].filter(Boolean);
      const { data: snapshots, error: snapshotsError } = await supabase
        .from('agent_ops_period_snapshots')
        .select('id, granularity, period_start, period_end, opening_agents, new_agents, removed_agents, closing_agents, active_agents_30d, qualified_at_open, converted_in_period, stage_onboarded, stage_training, stage_qualified, centres_opening, centres_opened, centres_closed, provisional')
        .in('id', snapshotIds);
      if (snapshotsError) throw snapshotsError;

      const rows = (snapshots ?? []) as AgentOpsSnapshot[];
      const snapshot = rows.find((row) => row.id === report.snapshot_id);
      if (!snapshot) return missing;


      const [notesRes, actionsRes, addendaRes, priorReportRes, staffRes, submitterRes] = await Promise.all([
        supabase.from('agent_ops_report_notes').select('id, zone, reason_note').eq('report_id', report.id),
        supabase
          .from('agent_ops_report_actions')
          .select('id, zone, item_text, owner_staff_id, owner_label, due_date, outcome, outcome_note, carried_from_action_id, created_at')
          .eq('report_id', report.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('agent_ops_report_addenda')
          .select('id, zone, addendum_text, created_at, created_by')
          .eq('report_id', report.id)
          .order('created_at', { ascending: true }),
        supabase
          .from('agent_ops_reports')
          .select('id, period_start, period_end, granularity, snapshot_id, prior_snapshot_id, target_net_agents, status')
          .eq('granularity', granularity)
          .lt('period_start', report.period_start)
          .order('period_start', { ascending: false })
          .limit(1),
        supabase.from('hr_staff').select('id, user_id, active').eq('active', true).limit(500),
        report.submitted_by
          ? supabase.from('profiles').select('id, full_name').eq('id', report.submitted_by).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      const noteRows = (notesRes.data ?? []) as AgentOpsReportNote[];
      const actionRows = (actionsRes.data ?? []) as AgentOpsReportAction[];
      const addendumRows = (addendaRes.data ?? []) as Omit<AgentOpsAddendum, 'author_name'>[];
      const priorReport = ((priorReportRes.data ?? [])[0] ?? null) as AgentOpsReport | null;
      const staffRows = (staffRes.data ?? []) as { id: string; user_id: string | null }[];

      const authorIds = Array.from(new Set(addendumRows.map((row) => row.created_by)));
      const staffUserIds = staffRows.map((row) => row.user_id).filter((value): value is string => Boolean(value));
      const nameIds = Array.from(new Set([...authorIds, ...staffUserIds]));
      const { data: nameRows } = nameIds.length
        ? await supabase.from('profiles').select('id, full_name').in('id', nameIds)
        : { data: [] as { id: string; full_name: string | null }[] };
      const names = new Map<string, string | null>(
        ((nameRows ?? []) as { id: string; full_name: string | null }[]).map((row) => [row.id, row.full_name]),
      );

      let priorNotes: Record<AgentOpsZone, string | null> = { growth: null, pipeline: null };
      let priorActions: AgentOpsPriorAction[] = [];
      let priorLabel: string | null = null;

      if (priorReport) {
        priorLabel = periodLabel(priorReport);
        const [priorNotesRes, priorActionsRes] = await Promise.all([
          supabase.from('agent_ops_report_notes').select('id, zone, reason_note').eq('report_id', priorReport.id),
          supabase
            .from('agent_ops_report_actions')
            .select('id, zone, item_text, owner_staff_id, owner_label, due_date, outcome, outcome_note, carried_from_action_id, created_at')
            .eq('report_id', priorReport.id)
            .order('created_at', { ascending: true }),
        ]);
        for (const row of (priorNotesRes.data ?? []) as AgentOpsReportNote[]) {
          if (row.zone === 'growth' || row.zone === 'pipeline') priorNotes[row.zone] = row.reason_note;
        }
        const rowsPrior = (priorActionsRes.data ?? []) as AgentOpsReportAction[];
        const parentIds = rowsPrior
          .map((row) => row.carried_from_action_id)
          .filter((value): value is string => Boolean(value));
        const { data: parentRows } = parentIds.length
          ? await supabase.from('agent_ops_report_actions').select('id, outcome').in('id', parentIds)
          : { data: [] as { id: string; outcome: string | null }[] };
        const parentOutcomes = new Map<string, string | null>(
          ((parentRows ?? []) as { id: string; outcome: string | null }[]).map((row) => [row.id, row.outcome]),
        );
        priorActions = rowsPrior.map((row) => {
          const ownMiss = row.outcome ? MISS_OUTCOMES.has(row.outcome) : false;
          const parentOutcome = row.carried_from_action_id ? parentOutcomes.get(row.carried_from_action_id) ?? null : null;
          const parentMiss = parentOutcome ? MISS_OUTCOMES.has(parentOutcome) : false;
          return { ...row, priorPeriodLabel: priorLabel as string, flaggedToReviewer: ownMiss && parentMiss };
        });
      }

      const byZone = <T extends { zone: string }>(rows: T[]) => ({
        growth: rows.filter((row) => row.zone === 'growth'),
        pipeline: rows.filter((row) => row.zone === 'pipeline'),
      });

      const zonedActions = byZone(actionRows);
      const zonedAddenda = byZone(addendumRows);

      return {
        ready: true,
        periodStart,
        report,

        snapshot,
        priorSnapshot: rows.find((row) => row.id === report.prior_snapshot_id) ?? null,
        periodLabel: periodLabel(report),
        notes: {
          growth: noteRows.find((row) => row.zone === 'growth') ?? null,
          pipeline: noteRows.find((row) => row.zone === 'pipeline') ?? null,
        },
        actions: zonedActions,
        addenda: {
          growth: zonedAddenda.growth.map((row) => ({ ...row, author_name: names.get(row.created_by) ?? null })),
          pipeline: zonedAddenda.pipeline.map((row) => ({ ...row, author_name: names.get(row.created_by) ?? null })),
        },
        priorNotes,
        priorPeriodLabel: priorLabel,
        priorActions,
        staffOptions: staffRows
          .map((row) => ({ staffId: row.id, label: (row.user_id ? names.get(row.user_id) : null) ?? 'Staff member' }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        submittedByName: (submitterRes.data as { full_name: string | null } | null)?.full_name ?? null,
        submittedAt: report.submitted_at ?? null,
      };
    },

    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

import { fmt } from './format';
import { useDeskFeeds, useStageFlow, type Row } from './useDeskFeed';
import { useStageTrend } from './deskBriefApi';
import { Trend, clearText, stageStatus } from './StageFlow';
import { statusDot, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';

/**
 * One line under the desk header: where requests wait, end to end, with this
 * desk's stage lit and the stage before it marked "coming to you". Read-only.
 *
 * Waiting counts come from the `pipeline` feed (its `ord`: '0b' Service Centre
 * new … '7' Landlord paid). Days to clear, red/amber/green and the 24-hour
 * trend come from the river's own stage flow and helpers, which number the
 * same stages one higher ('0' Submitted, '1' Service Centre, '2' Agent Ops …
 * '8' Landlord paid) — confirmed against desk_stage_flow 4 Nov.
 */

export type StripStage = {
  /** `ord` on the pipeline feed. */
  ord: string;
  /** `ord` on the stage flow and the trend feed. */
  flowOrd: string;
  /** The desk that works this stage, or null for Landlord paid. */
  desk: string | null;
  label: string;
  retired?: boolean;
};

export const STRIP_STAGES: StripStage[] = [
  { ord: '0b', flowOrd: '1', desk: 'service-centre', label: 'SC new' },
  { ord: '1', flowOrd: '2', desk: 'agent-ops', label: 'Agent Ops' },
  { ord: '2', flowOrd: '3', desk: 'tenant-ops', label: 'Tenant Ops' },
  { ord: '3', flowOrd: '4', desk: 'landlord-ops', label: 'Landlord Ops' },
  { ord: '4', flowOrd: '5', desk: 'partner-ops', label: 'Partner Ops', retired: true },
  { ord: '5', flowOrd: '6', desk: 'coo', label: 'COO' },
  { ord: '6', flowOrd: '7', desk: 'cfo', label: 'Funders' },
  { ord: '7', flowOrd: '8', desk: null, label: 'Landlord paid' },
];

/**
 * Which stage is this desk's, and which feeds it. Retired stages are skipped
 * when looking back: Partner Ops forwards to the COO, so the COO's "coming to
 * you" is Landlord Ops.
 */
export function stripMarks(deskId: string): { mine: string | null; before: string | null } {
  const i = STRIP_STAGES.findIndex((s) => s.desk === deskId);
  if (i < 0) return { mine: null, before: null };
  const mine = STRIP_STAGES[i];
  if (mine.retired) return { mine: mine.ord, before: null };
  for (let j = i - 1; j >= 0; j--) {
    if (!STRIP_STAGES[j].retired) return { mine: mine.ord, before: STRIP_STAGES[j].ord };
  }
  return { mine: mine.ord, before: null };
}

const byOrd = (rows: Row[], ord: string) => rows.find((r) => String(r.ord) === ord);

export function PipelineStrip({ deskId, board }: { deskId: string; board: boolean }) {
  // Same query keys as the desks and the command centre, so nothing is fetched twice.
  const pipeline = useDeskFeeds(['pipeline']).pipeline;
  const flow = useStageFlow();
  const trend = useStageTrend(true);
  const { mine, before } = stripMarks(deskId);
  const text = board ? 'text-sm' : 'text-xs';

  if (pipeline.loading) {
    return <Skeleton className="h-9 w-full" />;
  }
  // The strip is a guide, not a figure anyone acts on: on an error it goes.
  if (pipeline.error) return null;

  return (
    <nav aria-label="Where requests wait" className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol className="flex w-max min-w-full items-stretch gap-1.5">
        {STRIP_STAGES.map((s, i) => {
          const p = byOrd(pipeline.rows, s.ord);
          const f = byOrd(flow.rows, s.flowOrd);
          const isMine = s.ord === mine;
          const isBefore = s.ord === before;
          const arrow = i < STRIP_STAGES.length - 1 ? <span className={`${text} self-center text-muted-foreground`} aria-hidden>→</span> : null;

          if (s.retired) {
            return (
              <li key={s.ord} className="flex shrink-0 items-center gap-1.5">
                <span
                  className={`desk-pill whitespace-nowrap border border-dashed border-[var(--desk-line-color)] px-2 py-0.5 text-[11px] text-muted-foreground ${
                    isMine ? 'border-[hsl(var(--primary)/0.6)]' : ''
                  }`}
                  title="Partner Ops is retired; requests forward to the COO"
                >
                  {s.label} · retired — forwards to COO
                  {p && Number(p.n) > 0 ? ` · ${fmt('int', p.n)} left` : ''}
                </span>
                {arrow}
              </li>
            );
          }

          const state = f ? stageStatus(f) : 'idle';
          return (
            <li key={s.ord} className="flex shrink-0 items-center gap-1.5">
              <div
                aria-current={isMine ? 'step' : undefined}
                className={`desk-pill flex items-center gap-2 whitespace-nowrap border px-3 py-1 ${text} ${
                  isMine
                    ? 'border-[hsl(var(--primary)/0.7)] bg-[hsl(var(--primary)/0.2)] text-foreground'
                    : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
                }`}
              >
                {s.desk !== null && <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot[state]}`} aria-hidden />}
                <span className={isMine ? 'font-semibold' : 'font-medium text-foreground'}>{s.label}</span>
                {isMine && <span className="text-[11px] text-[hsl(var(--desk-lavender))]">you</span>}
                {isBefore && <span className="text-[11px] text-[hsl(var(--desk-lavender))]">coming to you</span>}
                <span className="tabular-nums text-foreground">{p ? fmt('int', p.n) : '—'}</span>
                <span className="sr-only"> waiting,</span>
                {s.desk !== null && (
                  <span className={`tabular-nums ${statusText[state]}`} title="Days to clear">
                    {clearText(f)}
                    {f && !Number.isNaN(Number(f.days_to_clear)) && f.days_to_clear !== null ? 'd' : ''}
                    <span className="sr-only"> days to clear</span>
                  </span>
                )}
                <Trend t={trend.byOrd.get(String(f?.ord ?? s.flowOrd))} board={board} />
              </div>
              {arrow}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

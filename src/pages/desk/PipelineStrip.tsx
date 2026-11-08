import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { fmt } from './format';
import { useDeskFeeds, useStageFlow, type Row } from './useDeskFeed';
import { useStageTrend } from './deskBriefApi';
import { Trend, clearText, stageStatus } from './StageFlow';
import { StripStep } from './ui/StripStep';
import { CALM, FOCUS, statusDot, statusText } from './deskTheme';
import { Sheet, atLeast, useBreakpoint, useFadeEdges } from './ui';
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
  /**
   * A desk beside the flow rather than a stage requests wait in: shown with
   * its note and no count (Partner Ops sells the funders' board).
   */
  companion?: string;
};

export const STRIP_STAGES: StripStage[] = [
  { ord: '0b', flowOrd: '1', desk: 'service-centre', label: 'SC new' },
  { ord: '1', flowOrd: '2', desk: 'agent-ops', label: 'Agent Ops' },
  { ord: '2', flowOrd: '3', desk: 'tenant-ops', label: 'Tenant Ops' },
  { ord: '3', flowOrd: '4', desk: 'landlord-ops', label: 'Landlord Ops' },
  { ord: '5', flowOrd: '6', desk: 'coo', label: 'COO' },
  { ord: '6', flowOrd: '7', desk: 'cfo', label: 'Funders' },
  { ord: '4', flowOrd: '5', desk: 'partner-ops', label: 'Partner Ops', companion: 'selling the funders board' },
  { ord: '7', flowOrd: '8', desk: null, label: 'Landlord paid' },
];

/**
 * Which stage is this desk's, and which feeds it. Companion steps are skipped
 * when looking back, so the COO's "coming to you" is Landlord Ops and Partner
 * Ops' is the Funders board it sells.
 */
export function stripMarks(deskId: string): { mine: string | null; before: string | null } {
  const i = STRIP_STAGES.findIndex((s) => s.desk === deskId);
  if (i < 0) return { mine: null, before: null };
  const mine = STRIP_STAGES[i];
  for (let j = i - 1; j >= 0; j--) {
    if (!STRIP_STAGES[j].companion) return { mine: mine.ord, before: STRIP_STAGES[j].ord };
  }
  return { mine: mine.ord, before: null };
}

const byOrd = (rows: Row[], ord: string) => rows.find((r) => String(r.ord) === ord);

export function PipelineStrip({ deskId, board, forceCompact }: { deskId: string; board: boolean; forceCompact?: boolean }) {
  // Same query keys as the desks and the command centre, so nothing is fetched twice.
  const pipeline = useDeskFeeds(['pipeline']).pipeline;
  const flow = useStageFlow();
  const trend = useStageTrend(true);
  const bp = useBreakpoint();
  const compact = forceCompact ?? !atLeast(bp, 'md');
  const [open, setOpen] = useState(false);
  const { ref, fade } = useFadeEdges<HTMLElement>(compact ? null : '[aria-current="step"]', [pipeline.rows.length]);
  const { mine, before } = stripMarks(deskId);
  const text = board ? 'text-sm' : 'text-xs';

  if (pipeline.loading) {
    return <Skeleton className={compact ? 'h-11 w-40' : 'h-9 w-full'} />;
  }
  // The strip is a guide, not a figure anyone acts on: on an error it goes.
  if (pipeline.error) return null;

  // Below md: one chip that opens the stages in a sheet.
  if (compact) {
    const mineStage = STRIP_STAGES.find((st) => st.ord === mine);
    const mineCount = mineStage ? byOrd(pipeline.rows, mineStage.ord) : undefined;
    return (
      <>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={`desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-sm text-foreground ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)]`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44, padding: '6px 14px', borderRadius: 999, borderWidth: 1, borderStyle: 'solid', whiteSpace: 'nowrap', maxWidth: '100%' }}
          data-pipeline-chip
        >
          Pipeline
          {mineStage && !mineStage.companion && mineCount && (
            <span className="text-muted-foreground">
              · {mineStage.label} <span className="tabular-nums text-foreground">{fmt('int', mineCount.n)}</span>
            </span>
          )}
          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
        </button>
        {open && (
          <Sheet title="Where requests wait" onClose={() => setOpen(false)}>
            <ol style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: 0, padding: 0, listStyle: 'none' }} data-pipeline-sheet>
              {STRIP_STAGES.map((st) => {
                const p = byOrd(pipeline.rows, st.ord);
                const f = byOrd(flow.rows, st.flowOrd);
                const isMine = st.ord === mine;
                const state = f ? stageStatus(f) : 'idle';
                return (
                  <li
                    key={st.ord}
                    aria-current={isMine ? 'step' : undefined}
                    className={`rounded-xl border ${isMine ? 'border-[hsl(var(--primary)/0.6)] bg-[hsl(var(--primary)/0.1)]' : 'border-[var(--desk-line-soft)]'} text-sm`}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', minHeight: 48, borderWidth: 1, borderStyle: 'solid', borderRadius: 12 }}
                  >
                    {st.desk !== null && !st.companion && <span className={`h-2 w-2 shrink-0 rounded-full ${statusDot[state]}`} style={{ width: 8, height: 8, borderRadius: 999, flexShrink: 0 }} aria-hidden />}
                    <span className={`${isMine ? 'font-semibold' : 'font-medium'} text-foreground`} style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {st.label}
                      {st.companion && <span className="text-muted-foreground"> · {st.companion}</span>}
                      {isMine && <span className="text-[hsl(var(--desk-lavender))]"> · you</span>}
                    </span>
                    {!st.companion && <span className="tabular-nums text-foreground">{p ? fmt('int', p.n) : '—'}<span className="sr-only"> waiting</span></span>}
                    {st.desk !== null && !st.companion && (
                      <span className={`tabular-nums ${statusText[state]}`} title="Days to clear">
                        {clearText(f)}
                        {f && !Number.isNaN(Number(f.days_to_clear)) && f.days_to_clear !== null ? ' d' : ''}
                        <span className="sr-only"> to clear</span>
                      </span>
                    )}
                    {!st.companion && <Trend t={trend.byOrd.get(String(f?.ord ?? st.flowOrd))} board={false} />}
                  </li>
                );
              })}
            </ol>
          </Sheet>
        )}
      </>
    );
  }

  return (
    <nav
      ref={ref}
      aria-label="Where requests wait"
      data-fade={fade}
      className="desk-scroll-row -mx-1 overflow-x-auto px-1 pb-1"
      style={{ position: 'relative', overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}
    >
      <ol className="flex w-max min-w-full items-stretch gap-1.5">
        {STRIP_STAGES.map((s, i) => {
          const p = byOrd(pipeline.rows, s.ord);
          const f = byOrd(flow.rows, s.flowOrd);
          const isMine = s.ord === mine;
          const isBefore = s.ord === before;
          const arrow = i < STRIP_STAGES.length - 1 ? <span className={`${text} self-center text-muted-foreground`} aria-hidden>→</span> : null;

          if (s.companion) {
            return (
              <li key={s.ord} className="flex shrink-0 items-center gap-1.5" data-companion={s.desk ?? undefined}>
                <StripStep active={isMine} board={board}>
                  <span className={isMine ? 'font-semibold' : 'font-medium text-foreground'}>{s.label}</span>
                  <span className="text-muted-foreground">· {s.companion}</span>
                  {isMine && <span className="text-[11px] text-[hsl(var(--desk-lavender))]">you</span>}
                </StripStep>
                {arrow}
              </li>
            );
          }

          const state = f ? stageStatus(f) : 'idle';
          return (
            <li key={s.ord} className="flex shrink-0 items-center gap-1.5">
              <StripStep active={isMine} board={board}>
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
              </StripStep>
              {arrow}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

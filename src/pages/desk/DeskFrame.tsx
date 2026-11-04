import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { fmt } from './format';
import { useStageFlow } from './useDeskFeed';
import { useDeskDaily } from './reviewApi';
import { CALM, FOCUS, LABEL, statusGlass } from './deskTheme';
import { Skeleton } from './Skeleton';
import { STRIP_STAGES } from './PipelineStrip';
import { WAIT_DESK_OF, WaitingRows, hoursLeft, useWaitingList } from './waitOn';

/**
 * The frame every stage desk shares when it is live:
 *
 *   strip → Ready for your push → Waiting on… → Done today → Classic view
 *
 * The last three start collapsed. Classic view holds every table the desk had
 * before the frame, unchanged, so nothing anyone relied on has gone.
 */

/** The desks that get the frame. */
export const FRAMED_DESKS = new Set(['service-centre', 'agent-ops', 'tenant-ops', 'landlord-ops', 'coo', 'cfo']);

/** The table that is "Ready for your push" on each framed desk. */
export const READY_TABLE: Record<string, string> = {
  'service-centre': 'sc-queue',
  'agent-ops': 'agent-ops-queue',
  'tenant-ops': 'tenant-ops-queue',
  'landlord-ops': 'landlord-ops-queue',
  coo: 'coo-queue',
  cfo: 'cfo-queue',
};

/** A section that opens on a press. Children mount only when open, so a closed section costs nothing. */
export function Fold({
  title,
  badge,
  hint,
  board,
  children,
}: {
  title: string;
  badge?: ReactNode;
  hint?: string;
  board: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-3 border-t border-[var(--desk-line-color)] pt-3">
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`flex w-full flex-wrap items-center gap-2 rounded-lg text-left ${CALM} ${FOCUS}`}
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
          <span>{title}</span>
          {badge}
          {hint && <span className={`${LABEL} font-normal`}>{hint}</span>}
        </button>
      </h2>
      {open && <div className="space-y-5">{children}</div>}
    </section>
  );
}

function CountPill({ n, tone = 'idle' }: { n: number | null; tone?: 'idle' | 'bad' | 'warn' | 'ok' }) {
  return (
    <span className={`desk-pill border px-2.5 py-0.5 text-xs tabular-nums ${statusGlass[tone]}`}>
      {n === null ? '—' : fmt('int', n)}
    </span>
  );
}

/** "Waiting on…" — hidden altogether while the waiting RPCs are not applied. */
export function WaitingOnFold({ deskId, board }: { deskId: string; board: boolean }) {
  const desk = WAIT_DESK_OF[deskId] ?? null;
  const list = useWaitingList(desk);
  if (!desk || list.missing) return null;
  const timeUp = list.items.filter((w) => {
    const h = hoursLeft(w.expiresAt);
    return h !== null && h <= 0;
  }).length;
  return (
    <Fold
      title="Waiting on…"
      board={board}
      badge={
        <>
          <CountPill n={list.loading ? null : list.items.length} />
          {timeUp > 0 && (
            <span className={`desk-pill border px-2.5 py-0.5 text-xs font-semibold ${statusGlass.bad}`}>{fmt('int', timeUp)} time up</span>
          )}
        </>
      }
      hint="Requests parked here while someone outside the desk acts"
    >
      <WaitingRows desk={desk} list={list} board={board} />
    </Fold>
  );
}

type DailyRow = { stage: string; reviews: number | null; passed: number | null; sent_back: number | null; rejected: number | null; calls_logged: number | null };

function DoneDetail({ deskId }: { deskId: string }) {
  const q = useDeskDaily(true);
  const stage = WAIT_DESK_OF[deskId];
  if (q.isLoading) return <Skeleton className="h-5 w-64" />;
  const row = ((q.data ?? []) as unknown as DailyRow[]).find((r) => r.stage === stage);
  if (!row) return <p className="text-sm text-muted-foreground">No reviews recorded at this desk today.</p>;
  return (
    <p className="text-sm text-foreground">
      {fmt('int', row.reviews)} reviews recorded today · {fmt('int', row.passed)} passed · {fmt('int', row.sent_back)} sent back ·{' '}
      {fmt('int', row.rejected)} rejected · {fmt('int', row.calls_logged)} calls logged
    </p>
  );
}

/** "Done today": the river's own cleared-today figure for this desk's stage, with the review breakdown inside. */
export function DoneTodayFold({ deskId, board }: { deskId: string; board: boolean }) {
  const flow = useStageFlow();
  const stage = STRIP_STAGES.find((s) => s.desk === deskId);
  const row = stage ? flow.rows.find((r) => String(r.ord) === stage.flowOrd) : undefined;
  const n = flow.loading || !row ? null : Number(row.done_24h ?? 0);
  return (
    <Fold title="Done today" board={board} badge={<CountPill n={n} tone={n ? 'ok' : 'idle'} />} hint="Cleared from this desk in the last 24 hours">
      <DoneDetail deskId={deskId} />
    </Fold>
  );
}

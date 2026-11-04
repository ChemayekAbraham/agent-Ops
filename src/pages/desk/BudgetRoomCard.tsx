import { Link } from 'react-router-dom';
import { fmt } from './format';
import { useMorningBrief } from './deskBriefApi';
import { CALM, FIGURE, FOCUS, LABEL, PANEL, statusEdge, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';

/**
 * How much the COO can approve right now.
 *
 * The room comes from the same funding plan the "Fund by score" tab ranks by,
 * so the figure here and the batch there can never disagree.
 *
 * A room of zero has two very different meanings. Spent out is an ordinary
 * end-of-day state; no CFO budget set at all means nothing can be approved
 * until the CFO acts, and the card says exactly that. The two are told apart
 * by the daily budget figure the command centre already loads — `room_ugx`
 * alone cannot distinguish them.
 */
export function BudgetRoomCard({
  board,
  enabled,
  /** True when the CFO has set today's daily budget. Null while it is still loading. */
  budgetSetToday,
}: {
  board: boolean;
  enabled: boolean;
  budgetSetToday: boolean | null;
}) {
  const q = useMorningBrief(enabled);

  if (!enabled || q.error) return null;

  const room = q.data?.budget_room ?? null;
  const roomUgx = room?.room_ugx ?? null;
  const canApprove = room?.can_approve ?? null;
  const canApproveUgx = room?.can_approve_ugx ?? null;

  // No budget set is the blocking case, and it outranks "room is zero".
  const blocked = budgetSetToday === false || roomUgx === null || roomUgx === 0;
  const noBudget = budgetSetToday === false;

  return (
    <section
      className={`${PANEL} space-y-2 p-4 sm:p-5 ${noBudget ? `border-2 ${statusEdge.bad}` : ''}`}
      aria-label="Budget room"
    >
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>Budget room</h2>

      {q.isLoading ? (
        <Skeleton className="h-9 w-48" />
      ) : noBudget ? (
        <p className={`${board ? 'text-lg' : 'text-base'} font-medium ${statusText.bad}`}>
          No CFO budget set for today — approvals are blocked
        </p>
      ) : blocked ? (
        <p className={`${board ? 'text-lg' : 'text-base'} font-medium ${statusText.warn}`}>
          Today&rsquo;s budget is fully used — nothing more can be approved today
        </p>
      ) : (
        <>
          <p className={`${board ? 'text-xl' : 'text-base'} leading-snug text-foreground`}>
            You can approve <span className={`${FIGURE} ${board ? 'text-2xl' : 'text-xl'}`}>{fmt('int', canApprove ?? 0)}</span>{' '}
            {canApprove === 1 ? 'request' : 'requests'} (UGX {fmt('ugxfull', canApproveUgx ?? 0)}) now — highest score first
          </p>
          <p className={LABEL}>Room left today: UGX {fmt('ugxfull', roomUgx)}</p>
        </>
      )}

      {!q.isLoading && room?.rule && !noBudget && <p className={LABEL}>{room.rule}</p>}

      <Link
        to="/desk/coo?tab=fund"
        className={`inline-block rounded text-xs font-medium text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${CALM} ${FOCUS} hover:text-foreground`}
      >
        Open “Fund by score” on the COO desk
      </Link>
    </section>
  );
}

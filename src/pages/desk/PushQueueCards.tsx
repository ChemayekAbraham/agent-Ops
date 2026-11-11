import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmt } from './format';
import { useMorningBrief } from './deskBriefApi';
import { CALM, FIGURE, FOCUS, LABEL, PANEL } from './deskTheme';
import { Skeleton } from './Skeleton';
import { AwaitingReleaseCard } from './AwaitingRelease';
import { SelfAppliedCard } from './SelfAppliedQueue';
import { IncompleteCard } from './incomplete';

/**
 * What replaced the Budget room card when budgets were retired on 5 Nov:
 * the COO's push queue, the funders' board, what funders selected that waits
 * for release (E71, its own RPC), and money funded but not yet paid to the
 * landlord. All three come from `desk_morning_brief`; its `budget_room`
 * key is left for old screens and is not read here.
 */

/** "113 waiting for your push · UGX 52.8M". */
export function pushQueueLine(q: { n: number | null; ugx: number | null } | null | undefined): string {
  return `${fmt('int', q?.n ?? 0)} waiting for your push · ${fmt('ugx', q?.ugx ?? 0)}`;
}

/** "1 listed · UGX 300k · 0 held". UGX is written out in full below a million. */
export function fundersLine(f: { n: number | null; ugx: number | null; held: number | null } | null | undefined): string {
  const ugx = f?.ugx ?? 0;
  const money = ugx < 1_000_000 ? `UGX ${Math.round(ugx / 1000)}k` : fmt('ugx', ugx);
  return `${fmt('int', f?.n ?? 0)} listed · ${money} · ${fmt('int', f?.held ?? 0)} held`;
}

function Card({ id, title, board, children }: { id?: string; title: string; board: boolean; children: ReactNode }) {
  return (
    <section id={id} className={`${PANEL} scroll-mt-4 space-y-2 p-4 sm:p-5`} aria-label={title}>
      <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>{title}</h2>
      {children}
    </section>
  );
}

const LINK = `inline-block rounded text-xs font-medium text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${CALM} ${FOCUS} hover:text-foreground`;

/**
 * The cards, two across on a tablet and three on wide screens. `onCooDesk` hides the "Open COO desk" button on
 * the COO desk itself, where it would only reload the page.
 */
export function PushQueueCards({ board, enabled, onCooDesk }: { board: boolean; enabled: boolean; onCooDesk?: boolean }) {
  const q = useMorningBrief(enabled);
  if (!enabled || q.error) return null;
  const figure = `${FIGURE} ${board ? 'text-2xl' : 'text-xl'}`;
  const text = board ? 'text-lg' : 'text-base';
  const b = q.data;

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
      <Card id="coo-push-queue" title="COO push queue" board={board}>
        {q.isLoading ? (
          <Skeleton className="h-8 w-56" />
        ) : (
          <p className={`${text} leading-snug text-foreground`}>
            <span className={figure}>{fmt('int', b?.coo_queue?.n ?? 0)}</span> waiting for your push ·{' '}
            {fmt('ugx', b?.coo_queue?.ugx ?? 0)}
          </p>
        )}
        {!onCooDesk && (
          <Link
            to="/desk/coo"
            className={`desk-pill inline-block border border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.15)] px-3 py-1 text-xs font-medium text-foreground ${CALM} ${FOCUS} hover:bg-[hsl(var(--primary)/0.25)]`}
          >
            Open COO desk
          </Link>
        )}
      </Card>

      <Card id="funders-board" title="Funders board" board={board}>
        {q.isLoading ? <Skeleton className="h-8 w-56" /> : <p className={`${text} leading-snug text-foreground`}>{fundersLine(b?.funders_board)}</p>}
        <Link to="/desk/funders" className={LINK}>
          Open the Funders Dashboard
        </Link>
      </Card>

      {/* E71: selected by a funder, money not yet released. Beside the funders board. */}
      <AwaitingReleaseCard board={board} />

      {/* E73: tenants who applied without an agent, waiting for Agent Ops to assign one. */}
      <SelfAppliedCard board={board} />

      {/* E82: requests past Agent Ops that still miss something; the COO push waits for them. */}
      <IncompleteCard board={board} />

      <Card id="funded-not-paid" title="Funded, not yet paid" board={board}>
        {q.isLoading ? (
          <Skeleton className="h-8 w-56" />
        ) : (
          <p className={`${text} leading-snug text-foreground`}>
            <span className={figure}>{fmt('int', b?.funded_not_paid?.n ?? 0)}</span> requests ·{' '}
            {fmt('ugx', b?.funded_not_paid?.ugx ?? 0)}
          </p>
        )}
        <p className={LABEL}>Funded money is finished only when the landlord is paid and the payment is evidenced.</p>
      </Card>
    </div>
  );
}

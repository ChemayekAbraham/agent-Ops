import { useEffect, useState } from 'react';
import { fmt } from '../format';
import { CALM, FOCUS, statusText } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { ErrorLine, stackLayout } from '../ui';
import { MONEY_FLOW_DAYS, moneyFlowLines, useMoneyFlow } from '../moneyFlow';
import { useIncompleteQueue } from '../incomplete';
import { ReleasesPanel } from './ReleasesPanel';
import type { Release } from './releasesApi';

/**
 * Under the Funders Dashboard's top tiles (desk `cfo`, also the boardroom
 * wall): the funders' money after release, in the Command Centre's words and
 * tones (Op 5's useMoneyFlow and moneyFlowLines, funded_money_flow, every
 * 30 s), and the "Incomplete requests: N" line (pipeline_incomplete_queue).
 *
 * Each money line is a button: it lists the releases at that stage, and a
 * release opens the plan drawer. "With agents, landlord not paid" is how the
 * COO reaches Recall: the money is still with the agent, so funded_recall
 * accepts it. A skeleton while loading and the server's words on a failure,
 * never a zero it was not told. On the wall view the lines are TV size.
 */

export const INCOMPLETE_REFRESH_MS = 30_000;

const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
const notAuthorized = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /not authori[sz]ed|is for Agent Ops|This view is for/i.test(String(x?.message ?? ''));
};

/** "Incomplete requests: 4", red while any is missing something. */
export function IncompleteLine({ board }: { board: boolean }) {
  const q = useIncompleteQueue();
  const { refetch } = q;
  // The hook polls every 60 s; this screen wants 30 s, as the money lines do.
  useEffect(() => {
    const t = window.setInterval(() => void refetch(), INCOMPLETE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refetch]);
  if (q.error && notAuthorized(q.error)) return null;
  const size = board ? 'text-xl' : 'text-xs';
  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading the incomplete requests" data-incomplete-line="loading">
        <Skeleton className={board ? 'h-6 w-72' : 'h-3.5 w-48'} />
      </div>
    );
  }
  if (q.error) return <ErrorLine>{asIs(q.error)}</ErrorLine>;
  if (!q.data) return null;
  const n = q.data.count;
  return (
    <span data-incomplete-line={n} data-tone={n > 0 ? 'bad' : 'ok'} className={`${size} ${n > 0 ? statusText.bad : statusText.ok}`} style={{ display: 'block' }}>
      Incomplete requests: {fmt('int', n)}
    </span>
  );
}

/** Which releases each line lists; `released` is all of them. */
export const LINE_LIST: Record<string, { title: string; stages: string[] | null }> = {
  released: { title: 'Released to agents', stages: null },
  with_agent: { title: 'With agents, landlord not paid', stages: ['with_agent'] },
  part_paid: { title: 'Part paid to landlords', stages: ['part_paid'] },
  // E93: the server's LIVE count includes the sold ones (landlord paid, OTP confirmed).
  live: { title: 'LIVE (landlord paid)', stages: ['live', 'sold', 'paid_to_landlord', 'plan_live'] },
};

function MoneyLines({ board }: { board: boolean }) {
  const q = useMoneyFlow();
  const [open, setOpen] = useState<string | null>(null);
  if (q.error && notAuthorized(q.error)) return null;
  const f = q.data;
  const size = board ? 'text-xl leading-snug' : 'text-xs';

  if (q.isLoading) {
    return (
      <div style={stackLayout(4)} role="status" aria-label="Loading the money after release">
        <Skeleton className={board ? 'h-6 w-80' : 'h-3.5 w-64'} />
        <Skeleton className={board ? 'h-6 w-96' : 'h-3.5 w-80'} />
        <Skeleton className={board ? 'h-6 w-72' : 'h-3.5 w-56'} />
      </div>
    );
  }
  if (q.error) return <ErrorLine>{asIs(q.error)}</ErrorLine>;
  if (!f) return null;

  const list = open ? LINE_LIST[open] : null;
  const items = (f.items.filter((i) => !!i.rent_request_id) as Release[]).filter((i) => !list?.stages || list.stages.includes(String(i.stage)));
  const total =
    open === 'released' ? f.released.count : open === 'with_agent' ? f.with_agent.count : open === 'part_paid' ? f.part_paid.count : open === 'live' ? f.live.count : 0;

  return (
    <div style={stackLayout(2)} data-money-lines>
      {moneyFlowLines(f).map((l) => (
        <button
          key={l.key}
          type="button"
          onClick={() => setOpen(l.key)}
          data-flow-line={l.key}
          data-tone={l.tone}
          title="See these releases"
          className={`${size} ${l.tone === 'idle' ? 'text-muted-foreground' : statusText[l.tone]} w-fit max-w-full rounded text-left underline-offset-4 hover:underline ${CALM} ${FOCUS}`}
          style={{ display: 'block', overflowWrap: 'anywhere' }}
        >
          {l.text}
        </button>
      ))}
      {list && (
        <ReleasesPanel
          title={list.title}
          items={items}
          note={`Last ${MONEY_FLOW_DAYS} days${items.length < total ? ` · latest ${items.length} of ${fmt('int', total)} shown` : ''}`}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

export function FundersMoneyLines({ board }: { board: boolean }) {
  return (
    <section aria-label="Funder money and incomplete requests" data-funders-money-lines className={board ? 'space-y-2' : 'space-y-1'}>
      <IncompleteLine board={board} />
      <MoneyLines board={board} />
    </section>
  );
}

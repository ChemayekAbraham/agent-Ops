import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { readableError } from '../reviewApi';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { isDenied } from '../accountability/accountabilityApi';
import { Card, EmptyState, ErrorLine, LoadingRows, Sheet, stackLayout } from '../ui';
import { TagChip } from '../fundersBoard/DemotedPanel';
import {
  FB_KEYS,
  countFull,
  fetchCounter,
  fetchCounterListItems,
  kampalaDay,
  ugxFull,
  type CounterListKind,
  type FbCounter,
} from '@/lib/fundersBoard';

/**
 * /desk/cfo: "Houses on the funders board" (E58 FB-COUNT). The number funders
 * see, and how it got there: the 9 Nov baseline, plus the COO's pushes, plus
 * restores, minus demotions. Pushed / restored / removed open the items behind
 * them. Every figure is the server's; nothing is added up here.
 */

export function useFundersBoardCounter(enabled = true) {
  return useQuery({
    queryKey: FB_KEYS.counter,
    enabled,
    queryFn: async (): Promise<FbCounter | null> => {
      try {
        return await fetchCounter();
      } catch (e) {
        if (isMissingDbObject(e)) {
          logMissingOnce('funders_board_counter', e);
          return null;
        }
        throw e;
      }
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
    // A refusal is an answer: hide at once, never retry it.
    retry: (n, e) => !isDenied(e) && n < 1,
  });
}

const LIST_TITLE: Record<CounterListKind, string> = {
  pushed: 'Added by COO pushes',
  restored: 'Restored to the funders board',
  removed: 'Demoted off the funders board',
};

function Figure({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div style={{ ...stackLayout(2), minWidth: 0 }}>
      <span className={LABEL}>{label}</span>
      <span className={`${big ? 'text-3xl sm:text-4xl font-bold' : 'text-lg font-semibold'} tabular-nums text-foreground`} style={{ overflowWrap: 'anywhere' }}>
        {value}
      </span>
    </div>
  );
}

/** One line of the breakdown; tappable when it opens a list. */
function Line({ sign, label, n, ugx, onOpen, strong }: { sign: string; label: string; n: number; ugx: number; onOpen?: () => void; strong?: boolean }) {
  const body: ReactNode = (
    <>
      <span className="tabular-nums text-muted-foreground" style={{ width: 16, flexShrink: 0, textAlign: 'center' }} aria-hidden>
        {sign}
      </span>
      <span className={`${strong ? 'font-semibold' : ''} text-foreground`} style={{ flex: 1, minWidth: 0 }}>
        {label}
      </span>
      <span className="tabular-nums text-foreground" style={{ whiteSpace: 'nowrap' }}>
        {countFull(n)}
      </span>
      <span className="tabular-nums text-muted-foreground" style={{ whiteSpace: 'nowrap', minWidth: '9.5rem', textAlign: 'right' }}>
        {ugxFull(ugx)}
      </span>
      <span style={{ width: 16, flexShrink: 0 }} aria-hidden>
        {onOpen && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </span>
    </>
  );
  const row = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 4px' } as const;
  return (
    <li className="border-t border-[var(--desk-line-color)] first:border-t-0 text-sm" style={{ listStyle: 'none' }}>
      {onOpen ? (
        <button type="button" onClick={onOpen} className={`rounded-lg text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`} style={row} aria-label={`${label}: ${countFull(n)}, ${ugxFull(ugx)}. Show the list`}>
          {body}
        </button>
      ) : (
        <div style={row}>{body}</div>
      )}
    </li>
  );
}

function CounterList({ kind, onClose }: { kind: CounterListKind; onClose: () => void }) {
  const q = useQuery({ queryKey: FB_KEYS.counterList(kind), queryFn: () => fetchCounterListItems(kind), staleTime: 20_000, retry: 1 });
  return (
    <Sheet title={LIST_TITLE[kind]} onClose={onClose}>
      {q.isLoading ? (
        <LoadingRows rows={4} height={56} label="Loading the list" />
      ) : q.error ? (
        <ErrorLine>The list could not load: {readableError(q.error)}</ErrorLine>
      ) : !q.data || q.data.length === 0 ? (
        <EmptyState>Nothing here yet.</EmptyState>
      ) : (
        <ul style={{ margin: 0, padding: 0 }} aria-label={LIST_TITLE[kind]}>
          {q.data.map((r) => (
            <li key={r.event_id} className="border-t border-[var(--desk-line-color)] first:border-t-0" style={{ ...stackLayout(4), listStyle: 'none', padding: '10px 0' }} data-counter-row>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <TagChip tag={r.tag_label === 'Verified' ? 'verified' : 'empty_house'} label={r.tag_label} />
                <span className="text-sm font-semibold text-foreground" style={{ overflowWrap: 'anywhere' }}>
                  {r.title}
                </span>
                {r.place && <span className={LABEL}>{r.place}</span>}
                <span className="text-sm font-semibold tabular-nums text-foreground" style={{ marginLeft: 'auto' }}>
                  {ugxFull(r.amount)}
                </span>
              </div>
              <p className={LABEL} style={{ margin: 0 }}>
                <span className="font-mono">{r.short_id}</span> · {kampalaDay(r.at)}
                {r.by_name && ` · ${[r.by_name, r.staff_ref].filter(Boolean).join(' · ')}`}
                {r.note && ` — ${r.note}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

export function FundersBoardCounterCard({ board }: { board: boolean }) {
  const q = useFundersBoardCounter();
  const [open, setOpen] = useState<CounterListKind | null>(null);
  if (q.data === null) return null;
  if (q.error && isDenied(q.error)) return null;
  const c = q.data;

  return (
    <Card
      board={board}
      title="Houses on the funders board"
      ariaLabel="Houses on the funders board"
      busy={q.isFetching}
      hint={c ? `As funders see it${c.last_change_at ? ` · last change ${kampalaDay(c.last_change_at)}` : ''}` : undefined}
    >
      {q.isLoading ? (
        <LoadingRows rows={2} height={64} label="Loading the funders board counter" />
      ) : q.error ? (
        <ErrorLine>The counter could not load: {readableError(q.error)}</ErrorLine>
      ) : c ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 12rem), 1fr))', gap: 16 }}>
            <Figure big label="Houses waiting" value={countFull(c.houses_waiting)} />
            <Figure big label="Amount needed" value={ugxFull(c.amount_needed_ugx)} />
            <Figure big label="Average monthly rent" value={ugxFull(c.avg_monthly_rent)} />
          </div>
          <ul style={{ margin: 0, padding: 0 }} aria-label="How the number moved">
            <Line sign="" label={`Frozen ${c.frozen_at ? kampalaDay(c.frozen_at) : '9 Nov'}`} n={c.baseline_houses} ugx={c.baseline_amount_ugx} />
            <Line sign="+" label="COO pushes" n={c.added_by_push} ugx={c.added_by_push_ugx} onOpen={() => setOpen('pushed')} />
            <Line sign="+" label="Restored" n={c.restored} ugx={c.restored_ugx} onOpen={() => setOpen('restored')} />
            <Line sign="−" label="Demoted" n={c.removed} ugx={c.removed_ugx} onOpen={() => setOpen('removed')} />
            <Line sign="=" label="Houses waiting" n={c.houses_waiting} ugx={c.amount_needed_ugx} strong />
          </ul>
          <ul style={{ margin: 0, padding: 0 }} aria-label="Alongside">
            <Line sign="·" label="Awaiting COO level" n={c.awaiting_level} ugx={c.awaiting_level_ugx} />
            <Line sign="·" label="Verified live now" n={c.verified_on_board} ugx={c.verified_on_board_ugx} />
          </ul>
          {!c.switch_on && <p className={LABEL} style={{ margin: 0 }}>Funders still see the old figures: the counter switch is off.</p>}
        </>
      ) : null}
      {open && <CounterList kind={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

import { useState } from 'react';
import { AlertTriangle, BadgeCheck, Home } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FOCUS, LABEL } from '../deskTheme';
import { readableError } from '../reviewApi';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { isDenied } from '../accountability/accountabilityApi';
import { Card, Chip, DecisionButton, EmptyState, ErrorLine, Fold, LoadingRows, stackLayout } from '../ui';
import {
  FB_KEYS,
  countFull,
  decideLevel,
  demotedByText,
  demotionReason,
  fetchCooDemoted,
  kampalaDay,
  ugxFull,
  type CooDemoted,
  type FbDemotion,
  type FbLevel,
} from '@/lib/fundersBoard';

/**
 * COO desk, top: "Demoted from the funders board" (E58 FB-LEVEL). Everything
 * the COO or CEO took off the funders board waits here until someone chooses
 * its level; `coo_demoted_board(30)` also lists what was decided in 30 days.
 * Hidden for a viewer the server refuses, and when the RPC is not there.
 */

export const DEMOTED_DAYS = 30;

export function useCooDemoted(enabled = true) {
  return useQuery({
    queryKey: FB_KEYS.cooDemoted(DEMOTED_DAYS),
    enabled,
    queryFn: async (): Promise<CooDemoted | null> => {
      try {
        return await fetchCooDemoted(DEMOTED_DAYS);
      } catch (e) {
        if (isMissingDbObject(e)) {
          logMissingOnce('coo_demoted_board', e);
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

/** "Verified" (green, check) for a COO-approved tenant; "Empty house" (neutral) for a house listing. */
export function TagChip({ tag, label }: { tag: 'verified' | 'empty_house'; label: string }) {
  return tag === 'verified' ? (
    <Chip size="sm" tone="ok" strong>
      <BadgeCheck className="h-3.5 w-3.5" aria-hidden style={{ marginRight: 4, display: 'inline' }} />
      {label}
    </Chip>
  ) : (
    <Chip size="sm" tone="idle">
      <Home className="h-3.5 w-3.5" aria-hidden style={{ marginRight: 4, display: 'inline' }} />
      {label}
    </Chip>
  );
}

const days = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${n === 1 ? 'day' : 'days'}`);

function Photo({ src, alt }: { src: string | null; alt: string }) {
  const box = { width: 64, height: 64, borderRadius: 10, flexShrink: 0, objectFit: 'cover' as const };
  return src ? (
    <img src={src} alt={alt} loading="lazy" style={box} className="border border-[var(--desk-line-color)]" />
  ) : (
    <div aria-hidden style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="border border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground">
      <Home className="h-5 w-5" />
    </div>
  );
}

function Summary({ d }: { d: FbDemotion }) {
  return (
    <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
      <Photo src={d.photo} alt={`${d.title}${d.place ? `, ${d.place}` : ''}`} />
      <div style={{ ...stackLayout(4), minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <TagChip tag={d.tag} label={d.tag_label} />
          <span className="text-sm font-semibold text-foreground" style={{ overflowWrap: 'anywhere' }}>
            {d.title}
          </span>
          {d.place && <span className={LABEL}>{d.place}</span>}
          <span className="text-sm font-semibold tabular-nums text-foreground" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {ugxFull(d.amount)}
          </span>
        </div>
        <p className="text-sm text-foreground" style={{ margin: 0 }} data-reason>
          {demotionReason(d)}
        </p>
        <p className={LABEL} style={{ margin: 0 }}>
          <span className="font-mono">{d.short_id}</span> · Demoted by {demotedByText(d)} · {kampalaDay(d.demoted_at)}
        </p>
      </div>
    </div>
  );
}

function AwaitingRow({ d, levels, canDecide }: { d: FbDemotion; levels: FbLevel[]; canDecide: boolean }) {
  const qc = useQueryClient();
  const [level, setLevel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = levels.find((l) => l.code === level);

  const apply = async () => {
    if (!level) return;
    setBusy(true);
    setError(null);
    try {
      await decideLevel(d.id, level, note);
      // The panel, the graded queue and the counter all move with a decision.
      await qc.invalidateQueries({ queryKey: ['desk-feed'] });
      await qc.invalidateQueries({ queryKey: FB_KEYS.headline });
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="border-t border-[var(--desk-line-color)] first:border-t-0" style={{ ...stackLayout(8), listStyle: 'none', padding: '12px 0' }} data-demotion={d.id}>
      <Summary d={d} />
      <div className="text-sm" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        <span className="text-foreground">
          <span className="font-semibold tabular-nums">{days(d.days_waiting)}</span> <span className="text-muted-foreground">waiting</span>
        </span>
        <span className="text-muted-foreground">
          Now: <span className="text-foreground">{d.current ?? '—'}</span>
        </span>
      </div>
      {d.moved_by_system && (
        <p className="text-sm" style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }} data-moved-by-system>
          <Chip size="sm" tone="warn" strong>
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden style={{ marginRight: 4, display: 'inline' }} />
            Moved by the system
          </Chip>
          <span className="text-muted-foreground">It left the COO queue before a level was chosen; applying a level records it as superseded.</span>
        </p>
      )}
      {canDecide && (
        <div style={{ ...stackLayout(6) }} data-level-controls>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <label className="sr-only" htmlFor={`lvl-${d.id}`}>
              Level for {d.title}
            </label>
            <select
              id={`lvl-${d.id}`}
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              disabled={busy}
              className={`desk-pill h-9 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
            >
              <option value="">Choose a level…</option>
              {levels.map((l) => (
                <option key={l.code} value={l.code} title={l.hint ?? undefined}>
                  {l.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              placeholder="Note (optional)"
              aria-label={`Note for ${d.title}`}
              className={`desk-pill h-9 min-w-0 flex-1 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
              style={{ minWidth: 160 }}
            />
            <DecisionButton variant="primary" size="md" disabled={!level || busy} onClick={apply}>
              {busy ? 'Applying…' : 'Apply'}
            </DecisionButton>
          </div>
          {chosen?.hint && (
            <p className={LABEL} style={{ margin: 0 }} data-level-hint>
              {chosen.hint}
            </p>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
        </div>
      )}
    </li>
  );
}

function DecidedRow({ d }: { d: FbDemotion }) {
  return (
    <li className="border-t border-[var(--desk-line-color)] first:border-t-0" style={{ ...stackLayout(6), listStyle: 'none', padding: '10px 0' }} data-decided={d.id}>
      <Summary d={d} />
      <p className="text-sm text-muted-foreground" style={{ margin: 0 }}>
        <span className="font-semibold text-foreground">{d.level_label ?? (d.state === 'superseded' ? 'Superseded' : d.state)}</span>
        {d.level_by_name && ` · by ${[d.level_by_name, d.level_staff_ref].filter(Boolean).join(' · ')}`}
        {d.level_at && ` · ${kampalaDay(d.level_at)}`}
        {d.level_note && ` — ${d.level_note}`}
      </p>
    </li>
  );
}

export function DemotedPanel({ board }: { board: boolean }) {
  const q = useCooDemoted();
  if (q.data === null) return null;
  if (q.error && isDenied(q.error)) return null;
  const b = q.data;

  return (
    <Card
      board={board}
      ariaLabel="Demoted from the funders board"
      busy={q.isFetching}
      title="Demoted from the funders board"
      hint={
        b
          ? `${countFull(b.counts.awaiting)} waiting for a level · ${ugxFull(b.counts.awaiting_ugx)}`
          : undefined
      }
    >
      {q.isLoading ? (
        <LoadingRows rows={2} height={72} label="Loading demoted houses" />
      ) : q.error ? (
        <ErrorLine>The demoted list could not load: {readableError(q.error)}</ErrorLine>
      ) : b ? (
        <>
          {b.awaiting.length === 0 ? (
            <EmptyState board={board}>Nothing demoted is waiting for a level.</EmptyState>
          ) : (
            <ul style={{ margin: 0, padding: 0 }} aria-label="Waiting for a level">
              {b.awaiting.map((d) => (
                <AwaitingRow key={d.id} d={d} levels={b.levels[d.kind]} canDecide={b.can_decide} />
              ))}
            </ul>
          )}
          {!b.can_decide && b.awaiting.length > 0 && (
            <p className={LABEL} style={{ margin: 0 }}>
              Only the COO or the CEO, signed in with an active staff ID, can choose the level.
            </p>
          )}
          <Fold title={`Decided (${DEMOTED_DAYS} days)`} count={b.decided.length} board={board}>
            {b.decided.length === 0 ? (
              <EmptyState board={board}>Nothing decided in the last {DEMOTED_DAYS} days.</EmptyState>
            ) : (
              <ul style={{ margin: 0, padding: 0 }} aria-label="Decided">
                {b.decided.map((d) => (
                  <DecidedRow key={d.id} d={d} />
                ))}
              </ul>
            )}
          </Fold>
        </>
      ) : null}
    </Card>
  );
}

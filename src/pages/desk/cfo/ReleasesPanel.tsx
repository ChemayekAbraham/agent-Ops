import { useCallback, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CALM, FOCUS, LABEL, type Status } from '../deskTheme';
import { STAGE_WORDS } from '../moneyFlow';
import { waitedText } from '../AwaitingRelease';
import { Chip, EmptyState, Sheet, moneyFull } from '../ui';
import { FundersPlanDrawer } from './FundersPlanDrawer';
import { refText, useBoardFacts } from './planDrawerApi';
import { rowFromRelease, type Release } from './releasesApi';

/**
 * Releases of funder money to agents (funded_money_flow items), as a list; a
 * tap opens the plan drawer, where Recall shows while the money is still with
 * the agent. While the drawer is open the list steps aside, and comes back when
 * the drawer closes.
 */
export function ReleasesPanel({
  title,
  items,
  note,
  onClose,
}: {
  title: string;
  items: Release[];
  /** e.g. "Last 30 days · latest 50 shown". */
  note?: string | null;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Release | null>(null);
  const facts = useBoardFacts();
  const closeDrawer = useCallback(() => setPicked(null), []);

  if (picked) {
    return <FundersPlanDrawer row={rowFromRelease(picked)} facts={facts.data?.get(picked.rent_request_id) ?? null} release={picked} onClose={closeDrawer} />;
  }

  return (
    <Sheet title={title} onClose={onClose}>
      {note && (
        <p className={LABEL} style={{ margin: 0 }} data-releases-note>
          {note}
        </p>
      )}
      {items.length === 0 ? (
        <EmptyState>Nothing here right now.</EmptyState>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label={title} data-releases-list>
          {items.map((it, i) => {
            const st = STAGE_WORDS[it.stage] ?? { text: String(it.stage).replace(/_/g, ' '), tone: 'idle' as Status };
            const paid = Number(it.paid_out ?? 0);
            return (
              <li key={`${it.rent_request_id}-${i}`} className="border-t border-[var(--desk-line-color)] first:border-t-0">
                <button
                  type="button"
                  onClick={() => setPicked(it)}
                  data-release={it.rent_request_id}
                  aria-label={`Open the plan for ${it.tenant ?? refText(it.rent_request_id)}`}
                  className={`w-full rounded-lg text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
                  style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', alignItems: 'center', gap: '4px 8px', padding: '10px 4px' }}
                >
                  <span className="font-medium text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {it.tenant ?? '—'} <span className="font-mono text-xs text-muted-foreground">{refText(it.rent_request_id)}</span>
                  </span>
                  <span className="tabular-nums text-foreground" style={{ whiteSpace: 'nowrap' }}>
                    {moneyFull(it.amount)}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    <Chip tone={st.tone}>{st.text}</Chip>
                    <span className={LABEL} style={{ overflowWrap: 'anywhere' }}>
                      Agent {it.agent ?? '—'} · Landlord {it.landlord ?? '—'}
                      {paid > 0 ? ` · paid out ${moneyFull(paid)}` : ''} · released {waitedText(it.hours_since_release)} ago
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}

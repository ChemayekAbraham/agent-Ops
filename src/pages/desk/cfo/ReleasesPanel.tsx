import { useCallback, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { when } from '../deskHistory';
import { Chip, EmptyState, Segmented, Sheet, atLeast, moneyFull, useBreakpoint } from '../ui';
import { FundersPlanDrawer } from './FundersPlanDrawer';
import { SidePanel } from './HeadlineListPanel';
import { refText, useBoardFacts } from './planDrawerApi';
import { RELEASE_SORTS, rowFromRelease, sortReleases, stageOf, type Release, type ReleaseSort } from './releasesApi';

/**
 * A details list of funder selections (funded_money_flow items): Rent requests
 * sold, Selected waiting, and the money lines. Each row leads with the tenant's
 * name; under it, small, the agent, landlord and funder; then the Ref, amount,
 * stage and dates. Newest selection first, with a toggle for oldest first or by
 * amount. A tap opens the plan drawer (Recall shows there while the money is
 * still with the agent); the list steps aside while the drawer is open.
 * A side panel from md, a bottom sheet on a phone.
 */

function Dates({ it }: { it: Release }) {
  const parts = [
    it.selected_at ? `Selected ${when(it.selected_at)}` : null,
    it.released_at ? `Released ${when(it.released_at)}` : null,
    it.otp_verified_at ? `OTP ${when(it.otp_verified_at)}` : null,
    it.landlord_paid_at ? `Landlord paid ${when(it.landlord_paid_at)}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <span className="text-[11px] text-muted-foreground" style={{ display: 'block' }} data-release-dates>
      {parts.join(' · ')}
    </span>
  );
}

function Row({ it, onOpen }: { it: Release; onOpen: () => void }) {
  const st = stageOf(it.stage);
  const paid = Number(it.paid_out ?? 0);
  return (
    <li className="border-t border-[var(--desk-line-soft)] first:border-t-0">
      <button
        type="button"
        onClick={onOpen}
        data-release={it.rent_request_id}
        aria-label={`Open the plan for ${it.tenant ?? refText(it.rent_request_id)}`}
        className={`w-full rounded-lg text-left hover:bg-[var(--desk-surface-hover)] ${CALM} ${FOCUS}`}
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', alignItems: 'start', gap: 8, padding: '10px 4px' }}
      >
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="text-sm font-semibold text-foreground" style={{ overflowWrap: 'anywhere' }} data-release-tenant>
            {it.tenant ?? '—'}
          </span>
          <span className="text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>
            Agent: <span className="text-foreground">{it.agent ?? '—'}</span>
          </span>
          <span className="text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>
            Landlord: <span className="text-foreground">{it.landlord ?? '—'}</span>
          </span>
          <span className="text-xs text-muted-foreground" style={{ overflowWrap: 'anywhere' }}>
            Funder: <span className="text-foreground">{it.funder ?? '—'}</span>
          </span>
          <span className="text-[11px] text-muted-foreground" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px', marginTop: 2 }}>
            <span className="font-mono">{it.ref ? `Ref ${it.ref}` : refText(it.rent_request_id)}</span>
            <span className="tabular-nums">{moneyFull(it.amount)}</span>
            <Chip tone={st.tone} size="xs">
              {st.text}
            </Chip>
            {paid > 0 && it.stage !== 'sold' ? <span className="tabular-nums">paid out {moneyFull(paid)}</span> : null}
          </span>
          <Dates it={it} />
        </span>
        <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" aria-hidden />
      </button>
    </li>
  );
}

export function ReleasesPanel({
  title,
  items,
  note,
  onClose,
}: {
  title: string;
  items: Release[];
  /** e.g. "Today · landlord paid, OTP confirmed". */
  note?: string | null;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Release | null>(null);
  const [sort, setSort] = useState<ReleaseSort>('newest');
  const facts = useBoardFacts();
  const md = atLeast(useBreakpoint(), 'md');
  const closeDrawer = useCallback(() => setPicked(null), []);
  const sorted = useMemo(() => sortReleases(items, sort), [items, sort]);

  if (picked) {
    return <FundersPlanDrawer row={rowFromRelease(picked)} facts={facts.data?.get(picked.rent_request_id) ?? null} release={picked} onClose={closeDrawer} />;
  }

  const body = (
    <>
      {note && (
        <p className={LABEL} style={{ margin: 0 }} data-releases-note>
          {note}
        </p>
      )}
      {items.length > 1 && (
        <Segmented ariaLabel="Order" size="sm" options={RELEASE_SORTS} value={sort} onChange={(s) => s !== null && setSort(s)} />
      )}
      {items.length === 0 ? (
        <EmptyState>Nothing here right now.</EmptyState>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} aria-label={title} data-releases-list>
          {sorted.map((it, i) => (
            <Row key={`${it.rent_request_id}-${i}`} it={it} onOpen={() => setPicked(it)} />
          ))}
        </ul>
      )}
    </>
  );

  return md ? (
    <SidePanel title={title} onClose={onClose}>
      {body}
    </SidePanel>
  ) : (
    <Sheet title={title} onClose={onClose}>
      {body}
    </Sheet>
  );
}

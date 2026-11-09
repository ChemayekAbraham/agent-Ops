import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { CALM, FOCUS, LABEL } from '../deskTheme';
import { readableError } from '../reviewApi';
import { EmptyState, ErrorLine, LoadingRows, Sheet, atLeast, moneyCard, moneyFull, stackLayout, useBreakpoint } from '../ui';
import type { Period } from './cfoApi';
import { HEADLINE_KINDS, dayText, periodLabel, useFundersHeadlineList, type HeadlineKind, type HeadlineListRow } from './headlineListApi';

/**
 * The list behind one Funders Dashboard headline tile: a bottom sheet on a
 * phone (the kit Sheet), a side panel from md. Header: what it is, the period,
 * the count and the UGX — all from `funders_headline_list`.
 */

const count = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function Phone({ n }: { n: string | null }) {
  if (!n) return null;
  return (
    <a href={`tel:${n.replace(/\s+/g, '')}`} className={`rounded tabular-nums text-[hsl(var(--desk-lavender))] underline underline-offset-4 ${FOCUS}`}>
      {n}
    </a>
  );
}

function Row({ r, kind }: { r: HeadlineListRow; kind: HeadlineKind }) {
  return (
    <li className="border-t border-[var(--desk-line-soft)]" style={{ ...stackLayout(4), listStyle: 'none', paddingTop: 12, paddingBottom: 12, minWidth: 0 }} data-headline-row={r.id}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flexWrap: 'wrap' }}>
        <span className={`${LABEL} font-mono`} title={r.id}>
          {r.req}
        </span>
        <span className="text-sm font-semibold text-foreground" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          {r.tenant}
        </span>
        {r.tenant_location && <span className={LABEL}>{r.tenant_location}</span>}
      </div>
      <div className="text-sm text-foreground" style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span className="font-semibold tabular-nums" title={r.rent === null ? undefined : moneyFull(r.rent)}>
          {r.rent === null ? '—' : moneyCard(r.rent)}
        </span>
        <span className="text-muted-foreground">Posted {dayText(r.posted_at)}</span>
        {r.status_label && (
          <span className="desk-pill border border-[var(--desk-line-color)] text-xs text-muted-foreground" style={{ padding: '1px 8px' }} data-status={r.status ?? undefined}>
            {r.status_label}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }}>
        Agent <span className="text-foreground">{r.agent ?? '—'}</span> · Landlord <span className="text-foreground">{r.landlord ?? '—'}</span>
        {r.landlord_phone && (
          <>
            {' '}
            <Phone n={r.landlord_phone} />
          </>
        )}
      </p>
      {kind === 'sold' && (
        <p className="text-sm text-muted-foreground" style={{ margin: 0, overflowWrap: 'anywhere' }} data-sold-line>
          Partner <span className="text-foreground">{r.partner ?? '—'}</span>
          {r.partner_phone && (
            <>
              {' '}
              <Phone n={r.partner_phone} />
            </>
          )}{' '}
          · Money released <span className="text-foreground">{dayText(r.released_at)}</span>
        </p>
      )}
    </li>
  );
}

/** From md: a panel on the right, full height, the same close rules as the kit Sheet. */
function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} data-headline-panel="side" style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'flex-end' }}>
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="bg-[hsl(var(--desk-blocked)/0.5)]" style={{ position: 'absolute', inset: 0 }} />
      <div
        ref={panel}
        className="desk-panel border-l border-[var(--desk-line-color)] bg-[hsl(var(--background))] shadow-2xl"
        style={{ ...stackLayout(12), position: 'relative', width: '100%', maxWidth: 560, height: '100%', overflow: 'auto', borderRadius: 0, padding: 'var(--desk-card-pad, 20px)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <h2 className="text-base font-semibold text-foreground" style={{ margin: 0 }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`desk-pill border border-[var(--desk-line-color)] text-muted-foreground ${CALM} ${FOCUS} hover:text-foreground`}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 8, borderRadius: 999 }}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function HeadlineListPanel({ kind, period, onClose }: { kind: HeadlineKind; period: Period; onClose: () => void }) {
  const q = useFundersHeadlineList(period, kind);
  const md = atLeast(useBreakpoint(), 'md');
  const title = HEADLINE_KINDS.find((k) => k.kind === kind)?.title ?? kind;
  const list = q.data;

  const body = (
    <>
      <p className="text-sm text-muted-foreground" style={{ margin: 0 }} data-headline-summary>
        {periodLabel(list?.period ?? period)}
        {list && (
          <>
            {' · '}
            <span className="font-semibold text-foreground tabular-nums">
              {count.format(list.count)} {list.count === 1 ? 'request' : 'requests'}
            </span>
            {' · '}
            <span className="font-semibold text-foreground tabular-nums" title={moneyFull(list.ugx)}>
              {moneyCard(list.ugx)}
            </span>
          </>
        )}
      </p>
      {q.isLoading ? (
        <LoadingRows rows={4} height={72} label={`Loading ${title.toLowerCase()}`} />
      ) : q.error ? (
        <ErrorLine>The list could not load: {readableError(q.error)}</ErrorLine>
      ) : !list || list.rows.length === 0 ? (
        <EmptyState>Nothing in this period</EmptyState>
      ) : (
        <ul style={{ margin: 0, padding: 0, minWidth: 0 }} aria-label={title}>
          {list.rows.map((r) => (
            <Row key={r.id} r={r} kind={kind} />
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

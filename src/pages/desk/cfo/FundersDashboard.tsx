import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImageOff, MapPin } from 'lucide-react';
import { FOCUS, LABEL, PANEL, statusText } from '../deskTheme';
import { clockTime } from '../deskPrefs';
import {
  Chip,
  DecisionButton,
  ErrorLine,
  GradeBadge,
  LoadingRows,
  Segmented,
  Tile,
  TileRow,
  atLeast,
  daysShort,
  moneyCard,
  useBreakpoint,
} from '../ui';
import { DataList, OneLine, type DataColumn } from '../ui/DataList';
import { stackLayout } from '../ui/layout';
import { readableError } from '../reviewApi';
import { FUNDERS_KEY, PERIODS, fundOne, useFundersDashboard, type FundersRow, type Period } from './cfoApi';
import { canFundRow, fundedSplitText, fundersLead, heldLabel, isWelileDue, rating, sortRows, ugx, type Rank } from './fundersView';

/** The listing's main photo: the first of the house photos the funders see. */
export function mainPhoto(r: Pick<FundersRow, 'photos'>): string | null {
  const first = Array.isArray(r.photos) ? r.photos.find((u) => typeof u === 'string' && u.length > 0) : undefined;
  return typeof first === 'string' ? first : null;
}

const photoCount = (r: FundersRow) => (Array.isArray(r.photos) ? r.photos.length : 0);

/** `xs` inside a table row (the kit's size for data rows), `sm` on a card. */
function StatusChips({ r, size = 'sm' }: { r: FundersRow; size?: 'xs' | 'sm' }) {
  const held = heldLabel(r);
  if (!isWelileDue(r) && !held) return null;
  return (
    <span className="flex flex-wrap gap-1" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {isWelileDue(r) && (
        <Chip tone="bad" size={size} strong>
          Welile to fund
        </Chip>
      )}
      {held && (
        <Chip tone="warn" size={size}>
          {held}
        </Chip>
      )}
    </span>
  );
}

function GpsPhotos({ r }: { r: FundersRow }) {
  const photos = photoCount(r);
  return (
    <span className="whitespace-nowrap text-xs">
      {r.gps ? (
        <a
          href={`https://www.google.com/maps?q=${r.gps.lat},${r.gps.lng}`}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-0.5 text-[hsl(var(--primary))] underline-offset-2 hover:underline ${FOCUS}`}
        >
          <MapPin className="h-3.5 w-3.5" aria-hidden /> Map
        </a>
      ) : (
        <span className="text-muted-foreground">No GPS</span>
      )}
      <span className="text-muted-foreground">
        {' '}
        · {photos} photo{photos === 1 ? '' : 's'}
      </span>
    </span>
  );
}

export const ratingsText = (r: Pick<FundersRow, 'ratings'>) =>
  `${rating(r.ratings?.agent_ops)} / ${rating(r.ratings?.tenant_ops)} / ${rating(r.ratings?.landlord_ops)}`;

function Ratings({ r }: { r: FundersRow }) {
  return (
    <span className="whitespace-nowrap text-xs text-muted-foreground" title="Agent / Tenant / Landlord ratings">
      {ratingsText(r)}
    </span>
  );
}

/** Below md: one listing as a card — photo, who, where, how much, and the one action. */
function FundersCard({ r, fund, busy, board }: { r: FundersRow; fund: (() => void) | null; busy: boolean; board: boolean }) {
  const photo = mainPhoto(r);
  return (
    <article className="desk-tile" style={{ ...stackLayout(8), padding: 12 }} data-funders-card={r.id}>
      <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
        {photo ? (
          <img
            src={photo}
            alt={`House photo for ${r.tenant ?? 'this request'}`}
            loading="lazy"
            decoding="async"
            width={64}
            height={64}
            className="bg-[var(--desk-surface)]"
            style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 12, flexShrink: 0 }}
          />
        ) : (
          <span
            role="img"
            aria-label="No photo"
            className="bg-[var(--desk-surface)] text-muted-foreground"
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 64, height: 64, borderRadius: 12, flexShrink: 0 }}
          >
            <ImageOff className="h-5 w-5" aria-hidden />
          </span>
        )}
        <div style={{ ...stackLayout(2), minWidth: 0, flex: '1 1 auto' }}>
          <h4 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {r.tenant ?? '—'}
          </h4>
          {r.tenant_location && (
            <p
              className="text-sm text-muted-foreground"
              title={r.tenant_location}
              style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {r.tenant_location}
            </p>
          )}
          <p className={LABEL} style={{ margin: 0, overflowWrap: 'anywhere' }}>
            Agent {r.agent ?? '—'} · Landlord {r.landlord ?? '—'}
          </p>
        </div>
      </div>
      <div className="text-sm" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px' }}>
        <span className="font-semibold tabular-nums text-foreground" title={ugx(r.rent)} aria-label={ugx(r.rent)}>
          {moneyCard(r.rent)}
        </span>
        <GradeBadge grade={r.grade} />
        <span className="tabular-nums text-muted-foreground">{daysShort(r.days_on_board)} on board</span>
        <StatusChips r={r} />
      </div>
      <div className={LABEL} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 12px' }}>
        <GpsPhotos r={r} />
        <span title="Agent / Tenant / Landlord ratings">Ratings {ratingsText(r)}</span>
      </div>
      {fund && (
        <DecisionButton variant="primary" size="md" disabled={busy} onClick={fund} style={{ width: '100%' }}>
          Fund with Welile money
        </DecisionButton>
      )}
    </article>
  );
}

type Outcome = { id: string; ok: boolean; text: string };

function ConfirmFund({
  row,
  busy,
  outcome,
  onConfirm,
  onClose,
}: {
  row: FundersRow;
  busy: boolean;
  outcome: Outcome | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const amount = row.funding_amount ?? row.rent;
  const done = !!outcome;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-6" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="funders-confirm-title"
        className={`${PANEL} w-full max-w-md space-y-3 bg-[hsl(var(--background))] p-4 sm:p-5`}
      >
        <h2 id="funders-confirm-title" className="text-lg font-semibold text-foreground">
          Fund with Welile money
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Request</dt>
          <dd className="font-mono text-foreground">{row.req ?? row.id.slice(0, 8)}</dd>
          <dt className="text-muted-foreground">Tenant</dt>
          <dd className="text-foreground">{row.tenant ?? '—'}</dd>
          <dt className="text-muted-foreground">Landlord</dt>
          <dd className="text-foreground">{row.landlord ?? '—'}</dd>
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="tabular-nums text-foreground">{ugx(amount)}</dd>
        </dl>
        {!done && (
          <p className="text-xs text-muted-foreground">
            This funds the agent&rsquo;s landlord float from Welile&rsquo;s money now. The request leaves the funders&rsquo;
            board.
          </p>
        )}
        {outcome && (
          <p role={outcome.ok ? 'status' : 'alert'} className={`text-sm ${outcome.ok ? statusText.ok : statusText.bad}`}>
            {outcome.text}
          </p>
        )}
        <div className="flex justify-end gap-2" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <DecisionButton size="md" onClick={onClose} disabled={busy}>
            {done ? 'Close' : 'Cancel'}
          </DecisionButton>
          {!done && (
            <DecisionButton size="md" variant="primary" onClick={onConfirm} disabled={busy}>
              {busy ? 'Funding…' : `Fund ${ugx(amount)}`}
            </DecisionButton>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The Funders Dashboard (desk id `cfo`): what funders can take today, what
 * they hold, what was funded, and — where the CFO is allowed — a way to fund a
 * request with Welile money, one at a time.
 */
export function FundersDashboard({
  board,
  period: periodProp,
  onPeriodChange,
}: {
  board: boolean;
  /** When given, the period is owned by the page (the toggle sits above the headline row). */
  period?: Period;
  onPeriodChange?: (p: Period) => void;
}) {
  const qc = useQueryClient();
  const [ownPeriod, setOwnPeriod] = useState<Period>('today');
  const controlled = periodProp !== undefined;
  const period = controlled ? periodProp : ownPeriod;
  const setPeriod = (p: Period) => (onPeriodChange ? onPeriodChange(p) : setOwnPeriod(p));
  const [rank, setRank] = useState<Rank>('grade');
  const [target, setTarget] = useState<FundersRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const q = useFundersDashboard(period);
  const d = q.data;
  const rows = useMemo(() => sortRows(d?.rows ?? [], rank), [d?.rows, rank]);
  const updatedMs = d?.generated_at ? Date.parse(d.generated_at) : q.dataUpdatedAt;

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fundOne(target.id);
      setOutcome(
        res.ok
          ? { id: target.id, ok: true, text: 'Funded. The agent will complete the payout to the landlord.' }
          : { id: target.id, ok: false, text: res.reason ?? 'Funding failed' },
      );
    } catch (e) {
      setOutcome({ id: target.id, ok: false, text: readableError(e) });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: FUNDERS_KEY });
      qc.invalidateQueries({ queryKey: ['desk-feed'] });
      qc.invalidateQueries({ queryKey: ['rent-disbursement-queue'] });
      qc.invalidateQueries({ queryKey: ['treasury-cash-snapshot'] });
      qc.invalidateQueries({ queryKey: ['cfo-overview'] });
    }
  };

  const close = () => {
    if (busy) return;
    setTarget(null);
    setOutcome(null);
  };

  const avg = d?.funded.avg_days_coo_to_funded;
  // On a phone the explainer and the refresh time go under the list, so the first listing is in view.
  const wide = atLeast(useBreakpoint(), 'md');
  const updatedLine = (
    <span className="text-xs text-muted-foreground">
      Updated {clockTime(Number.isFinite(updatedMs) ? updatedMs : 0)}
      {q.isFetching && !q.isLoading ? ' · refreshing' : ''}
    </span>
  );
  const explainer = (
    <p className="max-w-3xl text-xs leading-snug text-muted-foreground" style={{ margin: 0 }}>
      Rent Plans approved by the COO, graded on the three ops reviews. Funded or claimed requests leave this list on their own.
    </p>
  );
  const canFund = d?.can_fund_welile === true;
  const fundFor = (r: FundersRow) =>
    canFundRow(r, canFund)
      ? () => {
          setOutcome(null);
          setTarget(r);
        }
      : null;

  /*
   * The table keeps Request · Tenant · Agent · Grade · Days · Rent · Status
   * (and Fund for approvers); Landlord, GPS · photos and the three ratings sit
   * in priority 3, so on a narrower list they open in the row's details. The
   * list decides by its own width (ui/DataList).
   */
  const anyFundable = canFund && rows.some((r) => canFundRow(r, canFund));
  const columns: DataColumn<FundersRow>[] = [
    {
      key: 'req',
      label: 'Request',
      // For approvers the Fund column needs the room: Request opens in the row's details instead,
      // so Agent, Grade and Days stay visible at ~950 px.
      priority: anyFundable ? 3 : 2,
      kind: 'code',
      render: (r) => <span className="font-mono text-xs text-muted-foreground">{r.req ?? r.id.slice(0, 8)}</span>,
      text: (r) => r.req ?? r.id.slice(0, 8),
    },
    {
      key: 'tenant',
      label: 'Tenant',
      priority: 1,
      kind: 'name',
      render: (r) => (
        <>
          <OneLine className="text-foreground" title={r.tenant}>{r.tenant ?? '—'}</OneLine>
          {r.tenant_location && (
            <OneLine className="text-xs text-muted-foreground" title={r.tenant_location}>
              {r.tenant_location}
            </OneLine>
          )}
        </>
      ),
      text: (r) => [r.tenant, r.tenant_location].filter(Boolean).join(' · '),
    },
    { key: 'agent', label: 'Agent', priority: 2, kind: 'name', render: (r) => r.agent ?? '—' },
    { key: 'grade', label: 'Grade', priority: 2, kind: 'number', render: (r) => <GradeBadge grade={r.grade} />, text: (r) => r.grade ?? '' },
    { key: 'days', label: 'Days', priority: 2, kind: 'number', align: 'right', render: (r) => (r.days_on_board === null ? '—' : String(r.days_on_board)) },
    { key: 'rent', label: 'Rent (UGX)', priority: 1, kind: 'money', align: 'right', render: (r) => (r.rent === null ? '—' : Math.round(r.rent).toLocaleString('en')) },
    {
      key: 'status',
      label: 'Status',
      priority: 1,
      kind: 'chips',
      render: (r) => <StatusChips r={r} size="xs" />,
      text: (r) => [isWelileDue(r) ? 'Welile to fund' : '', heldLabel(r) ?? ''].filter(Boolean).join(' · '),
    },
    ...(anyFundable
      ? [
          {
            key: 'action',
            label: 'Action',
            priority: 1 as const,
            kind: 'action' as const,
            minWidth: 84,
            align: 'right' as const,
            render: (r: FundersRow) => {
              const fund = fundFor(r);
              // "Fund" in the table; the whole action in the tooltip, the accessible name and the confirm sheet.
              return fund ? (
                <DecisionButton
                  variant="primary"
                  disabled={busy || !!target}
                  onClick={fund}
                  title="Fund with Welile money"
                  aria-label={`Fund with Welile money: ${r.tenant ?? r.req ?? 'this request'}`}
                >
                  Fund
                </DecisionButton>
              ) : null;
            },
            text: () => '',
          },
        ]
      : []),
    {
      key: 'landlord',
      label: 'Landlord',
      priority: 3,
      kind: 'name',
      render: (r) => (
        <>
          <OneLine className="text-foreground" title={r.landlord}>{r.landlord ?? '—'}</OneLine>
          {r.landlord_phone && <OneLine className="text-xs text-muted-foreground">{r.landlord_phone}</OneLine>}
        </>
      ),
      text: (r) => [r.landlord, r.landlord_phone].filter(Boolean).join(' · '),
    },
    { key: 'gps', label: 'GPS · photos', priority: 3, kind: 'chips', render: (r) => <GpsPhotos r={r} />, text: () => '' },
    { key: 'ratings', label: 'Ratings · Agent / Tenant / Landlord', priority: 3, kind: 'text', render: (r) => <Ratings r={r} />, text: (r) => ratingsText(r) },
  ];

  return (
    <div className="space-y-4">
      {d && (
        <p className={`${board ? 'text-2xl' : 'text-lg sm:text-xl'} max-w-4xl leading-snug text-foreground`} style={{ margin: 0 }} data-funders-lead>
          {fundersLead(d)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!controlled && <Segmented
          ariaLabel="Period for the funded figures"
          size="md"
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          value={period}
          onChange={(p) => p !== null && setPeriod(p)}
        />}
        {wide && updatedLine}
      </div>

      {q.isLoading ? (
        <LoadingRows rows={1} height={112} label="Loading the funders' figures" />
      ) : d ? (
        <TileRow>
          <Tile board={board} label="Fund today" value={ugx(d.fund_today.ugx)} sub={`${d.fund_today.n} on the board, not held`} />
          <Tile board={board} label="Held by funders now" value={ugx(d.held_by_funders.ugx)} sub={`${d.held_by_funders.n} held`} />
          <Tile
            board={board}
            label={`Funded · ${PERIODS.find((p) => p.value === period)?.label ?? period}`}
            value={ugx(d.funded.ugx)}
            sub={fundedSplitText(d.funded)}
          />
          <Tile
            board={board}
            label="Avg days COO → funded"
            value={avg === null || avg === undefined ? '—' : (Math.round(avg * 10) / 10).toFixed(1)}
          />
        </TileRow>
      ) : null}

      {q.error && d && <ErrorLine>{readableError(q.error)}</ErrorLine>}

      <section className={`${PANEL} space-y-3 p-3 sm:p-5`} aria-labelledby="funders-list-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h3 id="funders-list-title" className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>
              On the funders&rsquo; board
            </h3>
            {wide && explainer}
          </div>
          <Segmented
            ariaLabel="Sort"
            size="md"
            options={[
              { value: 'grade' as Rank, label: 'Best grade first' },
              { value: 'oldest' as Rank, label: 'Oldest first' },
            ]}
            value={rank}
            onChange={(r) => r !== null && setRank(r)}
          />
        </div>

        <DataList<FundersRow>
          label="listings"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.error && !d ? readableError(q.error) : undefined}
          emptyText="Nothing is on the funders’ board right now."
          board={board}
          rowAttrs={(r) => ({ 'data-welile-due': isWelileDue(r) ? '' : undefined })}
          card={(r) => <FundersCard r={r} fund={fundFor(r)} busy={busy || !!target} board={board} />}
        />
        {!wide && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {explainer}
            {updatedLine}
          </div>
        )}
      </section>

      {target && <ConfirmFund row={target} busy={busy} outcome={outcome} onConfirm={confirm} onClose={close} />}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { CALM, FOCUS, PANEL, statusText } from '../deskTheme';
import { clockTime } from '../deskPrefs';
import { Chip, DecisionButton, EmptyState, ErrorLine, GradeBadge, LoadingRows, Segmented, Tile, TileRow } from '../ui';
import { readableError } from '../reviewApi';
import { FUNDERS_KEY, PERIODS, fundOne, useFundersDashboard, type FundersRow, type Period } from './cfoApi';
import { canFundRow, heldLabel, rating, sortRows, ugx, type Rank } from './fundersView';

const HEAD: { label: string; right?: boolean }[] = [
  { label: 'Request' },
  { label: 'Tenant' },
  { label: 'Agent' },
  { label: 'Landlord' },
  { label: 'Grade · Agent / Tenant / Landlord' },
  { label: 'Days on board', right: true },
  { label: 'Rent (UGX)', right: true },
  { label: 'GPS · photos' },
  { label: '' },
  { label: '' },
];

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
export function FundersDashboard({ board }: { board: boolean }) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<Period>('today');
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          ariaLabel="Period for the funded figures"
          size="md"
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          value={period}
          onChange={(p) => p !== null && setPeriod(p)}
        />
        <span className="text-xs text-muted-foreground">
          Updated {clockTime(Number.isFinite(updatedMs) ? updatedMs : 0)}
          {q.isFetching && !q.isLoading ? ' · refreshing' : ''}
        </span>
      </div>

      {q.isLoading ? (
        <LoadingRows rows={1} height={112} label="Loading the funders' figures" />
      ) : d ? (
        <TileRow max={4} phone={1}>
          <Tile board={board} label="Fund today" value={ugx(d.fund_today.ugx)} sub={`${d.fund_today.n} on the board, not held`} />
          <Tile board={board} label="Held by funders now" value={ugx(d.held_by_funders.ugx)} sub={`${d.held_by_funders.n} held`} />
          <Tile
            board={board}
            label={`Funded · ${PERIODS.find((p) => p.value === period)?.label ?? period}`}
            value={ugx(d.funded.ugx)}
            sub={`${d.funded.n} requests · Funders ${d.funded.by_funders.n} · Welile ${d.funded.by_welile.n}`}
          />
          <Tile
            board={board}
            label="Avg days COO → funded"
            value={avg === null || avg === undefined ? '—' : (Math.round(avg * 10) / 10).toFixed(1)}
          />
        </TileRow>
      ) : null}

      {q.error && <ErrorLine>{readableError(q.error)}</ErrorLine>}

      <section className={`${PANEL} space-y-3 p-4 sm:p-5`} aria-labelledby="funders-list-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h3 id="funders-list-title" className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>
              On the funders&rsquo; board
            </h3>
            <p className="max-w-3xl text-xs leading-snug text-muted-foreground">
              Rent Plans approved by the COO, graded on the three ops reviews. Funded or claimed requests leave this list on
              their own.
            </p>
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

        {q.isLoading && <LoadingRows rows={4} height={32} label="Loading the funders' board" />}
        {!q.isLoading && !q.error && rows.length === 0 && <EmptyState>Nothing is on the funders&rsquo; board right now.</EmptyState>}

        {rows.length > 0 && (
          <div className="max-h-[40rem] overflow-auto rounded-xl border border-[var(--desk-line-color)]">
            <table className="w-full border-collapse text-sm tabular-nums">
              <thead className="desk-thead">
                <tr>
                  {HEAD.map((h, i) => (
                    <th
                      key={i}
                      scope="col"
                      className={`sticky top-0 z-10 whitespace-nowrap border-b border-[var(--desk-line-color)] px-3 py-2 font-medium text-muted-foreground ${
                        h.right ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h.label || <span className="sr-only">{i === 8 ? 'Held' : 'Action'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const photos = Array.isArray(r.photos) ? r.photos.length : 0;
                  const held = heldLabel(r);
                  const cell = 'px-3 py-2 align-top';
                  return (
                    <tr key={r.id} className={`desk-row border-b border-[var(--desk-line-soft)] last:border-0 ${CALM}`}>
                      <td className={`${cell} font-mono text-xs text-muted-foreground`}>{r.req ?? r.id.slice(0, 8)}</td>
                      <td className={cell}>
                        <div className="text-foreground">{r.tenant ?? '—'}</div>
                        {r.tenant_location && <div className="text-xs text-muted-foreground">{r.tenant_location}</div>}
                      </td>
                      <td className={`${cell} text-foreground`}>{r.agent ?? '—'}</td>
                      <td className={cell}>
                        <div className="text-foreground">{r.landlord ?? '—'}</div>
                        {r.landlord_phone && <div className="text-xs text-muted-foreground">{r.landlord_phone}</div>}
                      </td>
                      <td className={`${cell} whitespace-nowrap`}>
                        <GradeBadge grade={r.grade} />
                        <span className="ml-2 text-xs text-muted-foreground" title="Agent / Tenant / Landlord ratings">
                          {rating(r.ratings?.agent_ops)} / {rating(r.ratings?.tenant_ops)} / {rating(r.ratings?.landlord_ops)}
                        </span>
                      </td>
                      <td className={`${cell} text-right text-foreground`}>{r.days_on_board ?? '—'}</td>
                      <td className={`${cell} text-right text-foreground`}>
                        {r.rent === null ? '—' : Math.round(r.rent).toLocaleString('en')}
                      </td>
                      <td className={`${cell} whitespace-nowrap text-xs`}>
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
                      </td>
                      <td className={cell}>
                        {held && (
                          <Chip tone="warn" size="sm">
                            {held}
                          </Chip>
                        )}
                      </td>
                      <td className={`${cell} text-right`}>
                        {canFundRow(r, d?.can_fund_welile === true) && (
                          <DecisionButton
                            variant="primary"
                            disabled={busy || !!target}
                            onClick={() => {
                              setOutcome(null);
                              setTarget(r);
                            }}
                          >
                            Fund with Welile money
                          </DecisionButton>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {target && <ConfirmFund row={target} busy={busy} outcome={outcome} onConfirm={confirm} onClose={close} />}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import { CALM, FOCUS, LABEL, statusText } from '../deskTheme';
import { DeskCallButton } from '../deskCall';
import { eatTime } from '../ontology/ontologyApi';
import { Card, Chip, DecisionButton, EmptyState, ErrorLine, LoadingRows, Segmented, Tile, TileRow } from '../ui';
import { readableError } from '../reviewApi';
import {
  DEFAULT_PERIOD,
  FOLLOW_UP_MIN,
  PARTNER_KEY,
  PARTNER_PERIODS,
  REJECT_REASON_MIN,
  approvePortfolio,
  decisionChip,
  lastFollowUpText,
  noteFollowUp,
  partnerTiles,
  rankOfficers,
  rejectPortfolio,
  soldBy,
  targetFunders,
  targetProgress,
  ugxC,
  usePartnerOpsBoard,
  type Listing,
  type Officer,
  type PartnerPeriod,
  type PendingPortfolio,
} from './partnerApi';

const full = (v: number | null | undefined) => `UGX ${Math.round(Number(v ?? 0)).toLocaleString('en')}`;
const int = (v: number | null | undefined) => Math.round(Number(v ?? 0)).toLocaleString('en');

/* ───────────── approve / reject a funder portfolio ───────────── */

function PortfolioSheet({ p, action, onClose }: { p: PendingPortfolio; action: 'approve' | 'reject'; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const reasonOk = reason.trim().length >= REJECT_REASON_MIN;

  const go = async () => {
    setBusy(true);
    setError(null);
    const r = action === 'approve' ? await approvePortfolio(p.portfolio_id) : await rejectPortfolio(p.portfolio_id, reason);
    setBusy(false);
    if (!r.ok) {
      setError(r.message ?? 'Something went wrong.');
      return;
    }
    setDone(action === 'approve' ? 'Approved. The funder’s portfolio is live.' : 'Rejected. The funder will see your reason.');
    qc.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  const title = action === 'approve' ? 'Approve this portfolio' : 'Reject this portfolio';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div className="desk-root relative w-full max-w-md rounded-t-3xl border border-[var(--desk-line-color)] shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Funder</dt>
          <dd className="text-foreground">{p.funder ?? '—'}{p.funder_phone ? <span className="text-muted-foreground"> · {p.funder_phone}</span> : null}</dd>
          <dt className="text-muted-foreground">Officer</dt>
          <dd className="text-foreground">{p.officer ?? '—'}</dd>
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="tabular-nums text-foreground">{full(p.amount)}{p.months ? ` · ${int(p.months)} months` : ''}</dd>
          <dt className="text-muted-foreground">Paid by</dt>
          <dd className="text-foreground">{p.payment_method ?? '—'}</dd>
        </dl>
        <footer className="space-y-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          {action === 'reject' && !done && (
            <label className="block space-y-1">
              <span className={LABEL}>Reason ({REJECT_REASON_MIN}+ characters)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
              />
            </label>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
          {done && <p className={`text-sm ${statusText.ok}`} role="status">{done}</p>}
          <div className="flex flex-wrap gap-2" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {done ? (
              <DecisionButton size="md" onClick={onClose}>Done</DecisionButton>
            ) : (
              <>
                <DecisionButton
                  size="md"
                  variant={action === 'approve' ? 'primary' : 'danger'}
                  disabled={busy || (action === 'reject' && !reasonOk)}
                  onClick={go}
                >
                  {busy ? 'Working…' : action === 'approve' ? `Approve ${full(p.amount)}` : 'Reject'}
                </DecisionButton>
                <DecisionButton size="md" disabled={busy} onClick={onClose}>Back</DecisionButton>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function PendingPortfolios({ rows, board }: { rows: PendingPortfolio[]; board: boolean }) {
  const [open, setOpen] = useState<{ p: PendingPortfolio; action: 'approve' | 'reject' } | null>(null);
  if (rows.length === 0) return null;
  return (
    <Card title="Approve funder portfolios" hint={`${rows.length} waiting`} board={board}>
      <ul>
        {rows.map((p) => (
          <li
            key={p.portfolio_id}
            data-portfolio={p.portfolio_id}
            className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-[var(--desk-line-color)] py-2 first:border-t-0 ${board ? 'text-base' : 'text-sm'}`}
          >
            <span className="font-medium text-foreground">{p.funder ?? '—'}</span>
            {p.code && <span className={`${LABEL} font-mono`}>{p.code}</span>}
            <span className="text-muted-foreground">via {p.officer ?? 'no officer'}</span>
            <span className="tabular-nums text-foreground">{full(p.amount)}</span>
            {p.months ? <span className="tabular-nums text-muted-foreground">{int(p.months)} months</span> : null}
            <Chip tone={Number(p.hours_waiting ?? 0) >= 24 ? 'warn' : 'idle'} className="tabular-nums">
              {int(p.hours_waiting)} h waiting
            </Chip>
            {p.receipt_file_url ? (
              <a href={p.receipt_file_url} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1 text-xs text-[hsl(var(--primary))] underline-offset-2 hover:underline ${FOCUS}`}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Receipt
              </a>
            ) : (
              <span className={`text-xs ${statusText.warn}`}>No receipt</span>
            )}
            <span className="ml-auto inline-flex items-center gap-1.5" style={{ display: 'inline-flex', gap: 6 }}>
              <DecisionButton variant="primary" onClick={() => setOpen({ p, action: 'approve' })}>Approve</DecisionButton>
              <DecisionButton onClick={() => setOpen({ p, action: 'reject' })}>Reject…</DecisionButton>
            </span>
          </li>
        ))}
      </ul>
      {open && <PortfolioSheet p={open.p} action={open.action} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/* ───────────── listings ───────────── */

function FollowUpNote({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ok = note.trim().length >= FOLLOW_UP_MIN;
  const save = async () => {
    setBusy(true);
    const r = await noteFollowUp(listing.id, note);
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Follow-up noted.' } : { ok: false, text: r.message ?? 'Something went wrong.' });
    if (r.ok) qc.invalidateQueries({ queryKey: ['desk-feed'] });
  };
  return (
    <div className="w-full space-y-1.5" data-follow-up={listing.id}>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        aria-label={`Follow-up note for ${listing.tenant ?? 'this request'}`}
        placeholder="Who you spoke to and what happens next"
        className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
      />
      {msg && (msg.ok ? <p className={`text-xs ${statusText.ok}`} role="status">{msg.text}</p> : <ErrorLine>{msg.text}</ErrorLine>)}
      <div className="flex gap-2" style={{ display: 'flex', gap: 8 }}>
        <DecisionButton variant="primary" disabled={!ok || busy || msg?.ok === true} onClick={save}>
          {busy ? 'Saving…' : 'Save the note'}
        </DecisionButton>
        <DecisionButton disabled={busy} onClick={onClose}>{msg?.ok ? 'Close' : 'Cancel'}</DecisionButton>
      </div>
    </div>
  );
}

function ListingRow({ l, board }: { l: Listing; board: boolean }) {
  const [noting, setNoting] = useState(false);
  const chip = decisionChip(l.decision);
  const frozen = l.decision === 'frozen';
  return (
    <li
      data-decision={l.decision}
      className={`space-y-1 border-t border-[var(--desk-line-color)] py-2.5 first:border-t-0 ${frozen ? 'opacity-60' : ''}`}
    >
      <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 ${board ? 'text-base' : 'text-sm'}`}>
        <span className="font-medium text-foreground">{l.tenant ?? '—'}</span>
        <span className={`${LABEL} font-mono`}>{l.req ?? l.id.slice(0, 8)}</span>
        <span className="text-muted-foreground">{l.agent ?? 'No agent'}</span>
        <Chip tone={chip.tone} strong={chip.strong}>{chip.label}</Chip>
        <span className="tabular-nums text-foreground">{full(l.rent)}</span>
        <span className="tabular-nums text-muted-foreground">{int(l.days_on_board)} d on board</span>
        {l.decision === 'follow_up' && (
          <span className="ml-auto inline-flex items-center gap-1.5" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={LABEL}>Call agent</span>
            <DeskCallButton target={{ requestId: l.id, desk: 'partner_ops', subject: 'agent', calleeId: l.agent_id, name: l.agent, phone: l.agent_phone }} />
            {!noting && <DecisionButton onClick={() => setNoting(true)}>Note follow-up</DecisionButton>}
          </span>
        )}
      </div>
      {l.why && <p className={`${LABEL} max-w-4xl`}>{l.why}</p>}
      {lastFollowUpText(l.last_followup, eatTime) && (
        <p className={`${LABEL} max-w-4xl`} data-last-followup={l.id}>
          {lastFollowUpText(l.last_followup, eatTime)}
        </p>
      )}
      {noting && <FollowUpNote listing={l} onClose={() => setNoting(false)} />}
    </li>
  );
}

/* ───────────── officers ───────────── */

function OfficersTable({ rows, board }: { rows: Officer[]; board: boolean }) {
  const ranked = useMemo(() => rankOfficers(rows), [rows]);
  if (ranked.length === 0) return <EmptyState board={board}>No field officers yet.</EmptyState>;
  const th = `${LABEL} whitespace-nowrap px-2 py-1.5 font-medium`;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="desk-thead">
          <tr>
            <th className={`${th} text-right`}>#</th>
            <th className={th}>Officer</th>
            <th className={th}><span className="sr-only">Call</span></th>
            <th className={`${th} text-right`}>Invites</th>
            <th className={`${th} text-right`}>Sign-ups</th>
            <th className={`${th} text-right`}>Funders</th>
            <th className={`${th} text-right`}>Funded</th>
            <th className={`${th} text-right`}>Contacts</th>
            <th className={th}>Monthly target</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((o, i) => {
            const p = targetProgress(o);
            return (
              <tr key={o.agent_id} data-officer={o.agent_id} className="desk-row border-t border-[var(--desk-line-color)] align-top">
                <td className={`${LABEL} px-2 py-1.5 text-right tabular-nums`}>{i + 1}</td>
                <td className="px-2 py-1.5 text-foreground">{o.officer ?? '—'}</td>
                <td className="px-2 py-1.5">
                  <DeskCallButton target={{ requestId: null, desk: 'partner_ops', subject: 'agent', calleeId: o.agent_id, name: o.officer, phone: o.phone }} />
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{int(o.invites)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{int(o.signups)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{int(o.funders)}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-foreground">
                  {int(o.funded)} <span className="text-muted-foreground">/ {ugxC(o.funded_ugx)}</span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-foreground">{int(o.contacts)}</td>
                <td className="min-w-[10rem] px-2 py-1.5">
                  {p === null ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    <span className="block space-y-1">
                      <span className="block text-xs tabular-nums text-foreground">
                        {int(targetFunders(o))} of {int(o.monthly_target)} funders · {p}%
                      </span>
                      <span
                        className="block h-1.5 w-full overflow-hidden rounded-full bg-[var(--desk-surface)]"
                        role="progressbar"
                        aria-valuenow={p}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${o.officer ?? 'Officer'}: ${p}% of the monthly target`}
                        style={{ display: 'block', height: 6, borderRadius: 999, overflow: 'hidden' }}
                      >
                        <span className="block h-full rounded-full bg-[hsl(var(--primary))]" style={{ display: 'block', height: '100%', width: `${p}%` }} />
                      </span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────── the desk ───────────── */

export function PartnerOpsBoard({ board }: { board: boolean }) {
  const [period, setPeriod] = useState<PartnerPeriod>(DEFAULT_PERIOD);
  const q = usePartnerOpsBoard(period);
  const b = q.data;

  return (
    <div className="space-y-5">
      <Segmented<PartnerPeriod>
        ariaLabel="Period"
        size="md"
        options={PARTNER_PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        value={period}
        onChange={(p) => p !== null && setPeriod(p)}
      />

      {q.isLoading ? (
        <LoadingRows rows={3} height={96} label="Loading the Partner Ops board" />
      ) : q.error ? (
        <ErrorLine>The Partner Ops board could not load: {readableError(q.error)}</ErrorLine>
      ) : b ? (
        <>
          <TileRow max={4}>
            {partnerTiles(b).map((t) => (
              <Tile key={t.key} label={t.label} value={t.value} sub={t.sub} tone={t.tone} board={board} />
            ))}
          </TileRow>

          <PendingPortfolios rows={b.pending_portfolios} board={board} />

          <Card title="Listings" hint="What funders can take, and what needs a push" board={board}>
            {b.listings.length === 0 ? (
              <EmptyState board={board}>Nothing is listed for funders right now.</EmptyState>
            ) : (
              <ul>
                {b.listings.map((l) => (
                  <ListingRow key={l.id} l={l} board={board} />
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Field officers"
            hint={`${int(b.funnel.invites)} invites · ${int(b.funnel.signups)} sign-ups · ${int(b.funnel.funded)} funded (${ugxC(b.funnel.funded_ugx)})`}
            board={board}
          >
            <OfficersTable rows={b.officers} board={board} />
          </Card>

          <Card title="Sold in the last 24 h" board={board}>
            {b.sold_24h.length === 0 ? (
              <EmptyState board={board}>Nothing sold in the last 24 hours.</EmptyState>
            ) : (
              <ul>
                {b.sold_24h.map((s) => (
                  <li key={s.id} className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[var(--desk-line-color)] py-2 first:border-t-0 ${board ? 'text-base' : 'text-sm'}`}>
                    <span className="font-medium text-foreground">{s.tenant ?? '—'}</span>
                    <span className={`${LABEL} font-mono`}>{s.req ?? s.id.slice(0, 8)}</span>
                    <Chip tone={s.by === 'welile' ? 'warn' : 'ok'}>{soldBy(s.by)}</Chip>
                    <span className="tabular-nums text-foreground">{full(s.rent)}</span>
                    <span className="tabular-nums text-muted-foreground">sold in {int(s.days_to_sell)} d</span>
                    {s.funded_at && <span className={`${LABEL} ml-auto tabular-nums`}>{eatTime(s.funded_at)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}

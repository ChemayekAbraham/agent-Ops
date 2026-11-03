import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Mail, Zap, Wallet, CheckCircle2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  deriveWalletStatus,
  fmtUgx,
  isUnparsedRow,
  isWelileOutboundEcho,
  type GmailTx,
  type WalletStatusInput,
  type WalletStatusTone,
} from '@/lib/emailTransactionsLogic';

const PAGE_SIZE = 25;

const TONE_CLASS: Record<WalletStatusTone, string> = {
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  red: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  blue: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  violet: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  grey: 'bg-muted text-muted-foreground',
};

const DOT_CLASS: Record<WalletStatusTone, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
  blue: 'bg-sky-500',
  violet: 'bg-violet-500',
  grey: 'bg-muted-foreground/50',
};

type HistoryEntry = WalletStatusInput['history'][number] & { routed_by_name?: string | null };
type CreditedEntry = WalletStatusInput['credited'][number];
type MarkEntry = { mark: 'credited' | 'uncredited'; created_at?: string; marked_by_name?: string | null };

export interface EmailTransactionsTableViewProps {
  rows: GmailTx[];
  selectedIds: Set<string>;
  setSelectedIds: (next: Set<string>) => void;
  routingHistory: Record<string, HistoryEntry[]>;
  creditedDeposits: Record<string, CreditedEntry[]>;
  manualMarks: Record<string, MarkEntry>;
  ledgerCredits: Record<string, unknown[]>;
  justRoutedIds: Set<string>;
  /** Each action opens the panel's existing confirmation, never acts directly. */
  onSendToWallet: (row: GmailTx) => void;
  onChargeWallet: (row: GmailTx) => void;
  onMarkResolved: (row: GmailTx) => void;
  onViewHistory: (row: GmailTx) => void;
}

function Pill({ tone, children }: { tone: WalletStatusTone; children: ReactNode }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${TONE_CLASS[tone]}`}>
      {children}
    </span>
  );
}

function when(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

function directionPill(r: GmailTx): { label: string; tone: WalletStatusTone } {
  if (r.direction === 'in') return { label: 'Money in', tone: 'green' };
  if (r.direction === 'out' || r.direction === 'charge') return { label: 'Money out', tone: 'blue' };
  return { label: 'Fee', tone: 'grey' };
}

function senderOf(r: GmailTx) {
  return (r.counterparty_name || r.counterparty || r.from_name || r.from_email || 'Unknown sender').trim();
}

/**
 * Table + detail-panel layout for the Email Transactions panel. Purely a view:
 * every action is handed back to the panel, which opens its existing
 * confirmation / history surfaces, so no money moves from here.
 */
export function EmailTransactionsTableView({
  rows, selectedIds, setSelectedIds, routingHistory, creditedDeposits, manualMarks, ledgerCredits,
  justRoutedIds, onSendToWallet, onChargeWallet, onMarkResolved, onViewHistory,
}: EmailTransactionsTableViewProps) {
  const [page, setPage] = useState(1);
  const [activeId, setActiveId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [rows, safePage],
  );

  const inputFor = (r: GmailTx): WalletStatusInput => ({
    history: routingHistory[r.id] ?? [],
    credited: creditedDeposits[r.id] ?? [],
    manualMark: manualMarks[r.id] ?? null,
    ledgerHit: (ledgerCredits[r.id] ?? []).length > 0,
    justRouted: justRoutedIds.has(r.id),
  });
  const statusOf = (r: GmailTx) => deriveWalletStatus(r, inputFor(r));

  const active = pageRows.find((r) => r.id === activeId) ?? rows.find((r) => r.id === activeId) ?? pageRows[0] ?? null;

  const allOnPageSelected = pageRows.length > 0 && pageRows.every((r) => selectedIds.has(r.id));
  const toggleOne = (id: string, on: boolean) => {
    const next = new Set(selectedIds);
    if (on) next.add(id); else next.delete(id);
    setSelectedIds(next);
  };
  const toggleAllOnPage = (on: boolean) => {
    const next = new Set(selectedIds);
    for (const r of pageRows) { if (on) next.add(r.id); else next.delete(r.id); }
    setSelectedIds(next);
  };

  if (rows.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No emails match the current filters.
      </div>
    );
  }

  const readPill = (r: GmailTx) =>
    isUnparsedRow(r)
      ? <Pill tone="red">Could not read</Pill>
      : <Pill tone="green">Read OK</Pill>;

  return (
    <div className="flex flex-wrap items-start gap-4 p-3 sm:p-4">
      <div className="min-w-0 flex-[999_1_640px] overflow-hidden rounded-2xl border bg-card">
        {/* Desktop / tablet table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[780px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-4 py-3 font-semibold">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={(v) => toggleAllOnPage(v === true)}
                    aria-label="Select all rows on this page"
                  />
                </th>
                <th className="px-2 py-3 font-semibold">Received</th>
                <th className="px-2 py-3 font-semibold">Sender</th>
                <th className="px-2 py-3 text-right font-semibold">Amount</th>
                <th className="px-2 py-3 font-semibold">Type</th>
                <th className="px-2 py-3 font-semibold">Transaction ID</th>
                <th className="px-2 py-3 font-semibold">Email read</th>
                <th className="px-4 py-3 font-semibold">Wallet status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => {
                const dir = directionPill(r);
                const status = statusOf(r);
                const isActive = active?.id === r.id;
                return (
                  <tr
                    key={r.id}
                    onClick={() => setActiveId(r.id)}
                    aria-selected={isActive}
                    className={`cursor-pointer border-t transition-colors hover:bg-muted/50 ${
                      isActive ? 'bg-primary/5 shadow-[inset_3px_0_0_hsl(var(--primary))]' : ''
                    }`}
                  >
                    <td className="px-4 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(r.id)}
                        onCheckedChange={(v) => toggleOne(r.id, v === true)}
                        aria-label={`Select email from ${senderOf(r)}`}
                      />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3.5 text-muted-foreground">{when(r.internal_date)}</td>
                    <td className="max-w-[220px] px-2 py-3.5">
                      <button
                        type="button"
                        onClick={() => setActiveId(r.id)}
                        className="block max-w-full truncate text-left font-semibold hover:underline"
                      >
                        {senderOf(r)}
                      </button>
                      {r.counterparty && r.counterparty !== senderOf(r) && (
                        <div className="truncate text-xs text-muted-foreground">{r.counterparty}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-3.5 text-right font-bold tabular-nums">{fmtUgx(r.amount)}</td>
                    <td className="px-2 py-3.5"><Pill tone={dir.tone}>{dir.label}</Pill></td>
                    <td className="px-2 py-3.5 font-mono text-xs">{r.transaction_id || '—'}</td>
                    <td className="px-2 py-3.5">{readPill(r)}</td>
                    <td className="px-4 py-3.5">
                      {status ? <Pill tone={status.tone}>{status.label}</Pill> : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Phone: one card per email */}
        <div className="space-y-3 p-3 md:hidden">
          {pageRows.map((r) => {
            const dir = directionPill(r);
            const status = statusOf(r);
            const isActive = active?.id === r.id;
            return (
              <div
                key={r.id}
                className={`space-y-2.5 rounded-2xl border p-3.5 ${isActive ? 'border-primary/50 bg-primary/5' : 'bg-card'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => setActiveId(r.id)} className="min-w-0 text-left">
                    <div className="text-lg font-bold tabular-nums">{fmtUgx(r.amount)}</div>
                    <div className="truncate text-sm text-muted-foreground">{senderOf(r)} · {when(r.internal_date)}</div>
                  </button>
                  <Checkbox
                    checked={selectedIds.has(r.id)}
                    onCheckedChange={(v) => toggleOne(r.id, v === true)}
                    aria-label={`Select email from ${senderOf(r)}`}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={dir.tone}>{dir.label}</Pill>
                  {readPill(r)}
                  {status && <Pill tone={status.tone}>{status.label}</Pill>}
                </div>
                {r.transaction_id && <div className="font-mono text-xs text-muted-foreground">{r.transaction_id}</div>}
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
          <span>
            Showing {((safePage - 1) * PAGE_SIZE + 1).toLocaleString()}–
            {Math.min(safePage * PAGE_SIZE, rows.length).toLocaleString()} of {rows.length.toLocaleString()} emails
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next</Button>
          </div>
        </div>
      </div>

      {active && (
        <DetailPanel
          row={active}
          input={inputFor(active)}
          status={statusOf(active)}
          onSendToWallet={onSendToWallet}
          onChargeWallet={onChargeWallet}
          onMarkResolved={onMarkResolved}
          onViewHistory={onViewHistory}
        />
      )}
    </div>
  );
}

function DetailPanel({
  row, input, status, onSendToWallet, onChargeWallet, onMarkResolved, onViewHistory,
}: {
  row: GmailTx;
  input: WalletStatusInput;
  status: { label: string; tone: WalletStatusTone } | null;
  onSendToWallet: (row: GmailTx) => void;
  onChargeWallet: (row: GmailTx) => void;
  onMarkResolved: (row: GmailTx) => void;
  onViewHistory: (row: GmailTx) => void;
}) {
  const dir = directionPill(row);
  const label = status?.label ?? '';
  const isIn = row.direction === 'in';
  const isOut = row.direction === 'out' || row.direction === 'charge';
  const settled = label === 'Credited' || label === 'Partially credited';

  // Same eligibility the row swipe actions use, so this panel can never offer
  // something the rest of the panel would not.
  const canSend = isIn && !isWelileOutboundEcho(row) && label === 'Awaiting routing';
  const canCharge = isOut && Number(row.amount ?? 0) > 0 && label === 'Not charged yet';
  const canResolve = isIn && !input.manualMark && !settled && !isWelileOutboundEcho(row) && !isUnparsedRow(row);

  const matchedWallet =
    input.history.find((h) => h.target_user_name)?.target_user_name
    || input.credited[0]?.user_name
    || null;

  const timeline = useMemo(() => {
    const items: Array<{ key: string; title: string; at: string | null; tone: WalletStatusTone }> = [];
    items.push({ key: 'received', title: 'Email received', at: row.internal_date, tone: 'green' });
    items.push(
      isUnparsedRow(row)
        ? { key: 'read', title: 'Could not read an amount from this email', at: row.internal_date, tone: 'red' }
        : { key: 'read', title: 'Amount and transaction ID read', at: row.internal_date, tone: 'green' },
    );
    for (const h of input.history) {
      const reversed = /revers/i.test(h.reason || '');
      const debit = h.route === 'withdrawable_debit' && /^DEBIT\b/i.test(h.reason || '');
      items.push({
        key: `h-${h.created_at}-${h.target_user_name ?? ''}`,
        title: `${reversed ? 'Reversed' : debit ? 'Charged' : 'Routed'}${h.target_user_name ? ` — ${h.target_user_name}` : ''}`,
        at: h.created_at,
        tone: reversed ? 'red' : debit ? 'blue' : 'violet',
      });
    }
    for (const c of input.credited) {
      items.push({ key: `c-${c.credited_at}-${c.user_name}`, title: `Credited — ${c.user_name}`, at: c.credited_at, tone: 'green' });
    }
    if (status && (label === 'Awaiting routing' || label === 'Not charged yet')) {
      items.push({
        key: 'waiting',
        title: isIn ? 'Waiting for a wallet match' : 'Waiting to be charged to a wallet',
        at: null,
        tone: 'amber',
      });
    }
    return items.sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  }, [row, input, status, label, isIn]);

  return (
    <aside
      aria-label="Selected email details"
      className="flex min-w-[300px] max-w-[420px] flex-[1_1_340px] flex-col gap-4 rounded-2xl border bg-card p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">Selected email</div>
          <div className="text-2xl font-bold tracking-tight tabular-nums">{fmtUgx(row.amount)}</div>
          <div className="text-xs text-muted-foreground">{dir.label} · {when(row.internal_date)}</div>
        </div>
        {status && <Pill tone={status.tone}>{status.label}</Pill>}
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Sender</dt><dd className="break-words font-semibold">{senderOf(row)}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Counterparty</dt><dd className="break-words font-semibold">{row.counterparty || '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Transaction ID</dt><dd className="break-all font-mono text-xs">{row.transaction_id || '—'}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Matched wallet</dt><dd className="font-semibold">{matchedWallet ?? 'Not matched yet'}</dd></div>
      </dl>

      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-sm font-semibold"><Mail className="h-3.5 w-3.5" aria-hidden="true" /> Original email</div>
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-dashed bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
          {[row.subject, row.snippet].filter(Boolean).join('\n\n') || 'No text was saved for this email.'}
        </div>
      </div>

      <div className="space-y-2.5">
        <div className="text-sm font-semibold">What happened</div>
        {timeline.map((t) => (
          <div key={t.key} className="flex items-start gap-3">
            <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASS[t.tone]}`} />
            <div>
              <div className="text-sm font-medium">{t.title}</div>
              <div className="text-xs text-muted-foreground">{t.at ? when(t.at) : 'Now'}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        <Button disabled={!canSend} onClick={() => onSendToWallet(row)} className="h-11">
          <Zap className="mr-1.5 h-4 w-4" aria-hidden="true" /> Send to wallet
        </Button>
        <div className="grid grid-cols-2 gap-2.5">
          <Button variant="outline" disabled={!canCharge} onClick={() => onChargeWallet(row)} className="h-10">
            <Wallet className="mr-1.5 h-4 w-4" aria-hidden="true" /> Charge wallet
          </Button>
          <Button variant="outline" disabled={!canResolve} onClick={() => onMarkResolved(row)} className="h-10">
            <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden="true" /> Mark resolved
          </Button>
        </div>
        <Button variant="ghost" onClick={() => onViewHistory(row)} className="h-10 text-primary">
          <History className="mr-1.5 h-4 w-4" aria-hidden="true" /> View history
        </Button>
      </div>
    </aside>
  );
}

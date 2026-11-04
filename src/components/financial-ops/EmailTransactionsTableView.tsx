import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Mail, Zap, Wallet, CheckCircle2, History, MoreHorizontal, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  deriveWalletStatus,
  fmtUgx,
  isUnparsedRow,
  isWelileOutboundEcho,
  type GmailTx,
  type WalletStatusInput,
  type WalletStatusTone,
} from '@/lib/emailTransactionsLogic';
import { Pager } from './FinopsKit';

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
    ? `Today, ${time}`
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

function directionLabel(r: GmailTx): string {
  if (r.direction === 'in') return 'Money in';
  if (r.direction === 'out' || r.direction === 'charge') return 'Money out';
  return 'Fee';
}

function senderOf(r: GmailTx) {
  return (r.counterparty_name || r.counterparty || r.from_name || r.from_email || 'Unknown sender').trim();
}

/**
 * What can be done with a row. Same eligibility the row swipe actions use, so
 * this view can never offer something the rest of the panel would not.
 */
function eligibilityFor(
  r: GmailTx,
  input: WalletStatusInput,
  status: { label: string } | null,
) {
  const label = status?.label ?? '';
  const isIn = r.direction === 'in';
  const isOut = r.direction === 'out' || r.direction === 'charge';
  const settled = label === 'Credited' || label === 'Partially credited';
  return {
    canSend: isIn && !isWelileOutboundEcho(r) && label === 'Awaiting routing',
    canCharge: isOut && Number(r.amount ?? 0) > 0 && label === 'Not charged yet',
    canResolve: isIn && !input.manualMark && !settled && !isWelileOutboundEcho(r) && !isUnparsedRow(r),
  };
}

/**
 * Table layout for the Email Transactions panel (cards on a phone). Purely a
 * view: every action is handed back to the panel, which opens its existing
 * confirmation or history surface, so no money moves from here. The full
 * email, its timeline and every action open in a side drawer.
 */
export function EmailTransactionsTableView({
  rows, selectedIds, setSelectedIds, routingHistory, creditedDeposits, manualMarks, ledgerCredits,
  justRoutedIds, onSendToWallet, onChargeWallet, onMarkResolved, onViewHistory,
}: EmailTransactionsTableViewProps) {
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  const pageRows = useMemo(
    () => rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
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

  const detailRow = detailId ? rows.find((r) => r.id === detailId) ?? null : null;

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

  /** The one button shown on a row, and the menu behind the ⋯ button. */
  const renderActions = (r: GmailTx) => {
    const input = inputFor(r);
    const status = statusOf(r);
    const { canSend, canCharge, canResolve } = eligibilityFor(r, input, status);
    return (
      <div className="flex items-center gap-1.5">
        {canSend ? (
          <Button size="sm" className="min-h-[36px] gap-1.5" onClick={() => onSendToWallet(r)}>
            <Zap className="h-3.5 w-3.5" aria-hidden="true" /> Route
          </Button>
        ) : canCharge ? (
          <Button size="sm" className="min-h-[36px] gap-1.5" onClick={() => onChargeWallet(r)}>
            <Wallet className="h-3.5 w-3.5" aria-hidden="true" /> Charge
          </Button>
        ) : (
          <Button size="sm" variant="outline" className="min-h-[36px] gap-1.5" onClick={() => setDetailId(r.id)}>
            <Eye className="h-3.5 w-3.5" aria-hidden="true" /> View
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="h-9 w-9" aria-label={`More actions for ${senderOf(r)}`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setDetailId(r.id)}>
              <Eye className="mr-2 h-4 w-4" aria-hidden="true" /> View details
            </DropdownMenuItem>
            {(canSend || canCharge || canResolve) && <DropdownMenuSeparator />}
            {canSend && (
              <DropdownMenuItem onSelect={() => onSendToWallet(r)}>
                <Zap className="mr-2 h-4 w-4" aria-hidden="true" /> Send to wallet
              </DropdownMenuItem>
            )}
            {canCharge && (
              <DropdownMenuItem onSelect={() => onChargeWallet(r)}>
                <Wallet className="mr-2 h-4 w-4" aria-hidden="true" /> Charge wallet
              </DropdownMenuItem>
            )}
            {canResolve && (
              <DropdownMenuItem onSelect={() => onMarkResolved(r)}>
                <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" /> Mark resolved
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onViewHistory(r)}>
              <History className="mr-2 h-4 w-4" aria-hidden="true" /> View history
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const statusPill = (r: GmailTx) => {
    if (isUnparsedRow(r)) return <Pill tone="red">Could not read</Pill>;
    const status = statusOf(r);
    return status ? <Pill tone={status.tone}>{status.label}</Pill> : <span className="text-muted-foreground">—</span>;
  };

  return (
    <div className="p-3 sm:p-4">
      <div className="overflow-hidden rounded-2xl border bg-card">
        {/* Tablet and desktop: a table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={(v) => toggleAllOnPage(v === true)}
                    aria-label="Select all rows on this page"
                  />
                </th>
                <th className="px-2 py-3">From</th>
                <th className="px-2 py-3">Subject</th>
                <th className="px-2 py-3 text-right">Amount (UGX)</th>
                <th className="px-2 py-3">Reference</th>
                <th className="px-2 py-3">Received</th>
                <th className="px-2 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((r) => (
                <tr key={r.id} className="border-t align-middle hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Checkbox
                      checked={selectedIds.has(r.id)}
                      onCheckedChange={(v) => toggleOne(r.id, v === true)}
                      aria-label={`Select email from ${senderOf(r)}`}
                    />
                  </td>
                  <td className="max-w-[200px] px-2 py-3">
                    <button
                      type="button"
                      onClick={() => setDetailId(r.id)}
                      className="block max-w-full truncate text-left font-semibold hover:underline"
                    >
                      {senderOf(r)}
                    </button>
                    <div className="text-xs text-muted-foreground">{directionLabel(r)}</div>
                  </td>
                  <td className="max-w-[240px] truncate px-2 py-3 text-muted-foreground" title={r.subject ?? undefined}>
                    {r.subject || '—'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right font-bold tabular-nums">
                    {r.amount == null ? '—' : Math.round(r.amount).toLocaleString()}
                  </td>
                  <td className="px-2 py-3 font-mono text-xs">{r.transaction_id || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-muted-foreground">{when(r.internal_date)}</td>
                  <td className="px-2 py-3">{statusPill(r)}</td>
                  <td className="px-4 py-3">{renderActions(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Phone: one card per email */}
        <div className="space-y-3 p-3 md:hidden">
          {pageRows.map((r) => (
            <div key={r.id} className="space-y-2.5 rounded-2xl border bg-card p-3.5">
              <div className="flex items-start justify-between gap-3">
                <button type="button" onClick={() => setDetailId(r.id)} className="min-w-0 text-left">
                  <div className="text-lg font-bold tabular-nums">{fmtUgx(r.amount)}</div>
                  <div className="truncate text-sm text-muted-foreground">{senderOf(r)} · {when(r.internal_date)}</div>
                </button>
                <Checkbox
                  checked={selectedIds.has(r.id)}
                  onCheckedChange={(v) => toggleOne(r.id, v === true)}
                  aria-label={`Select email from ${senderOf(r)}`}
                />
              </div>
              {r.subject && <p className="truncate text-xs text-muted-foreground">{r.subject}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={r.direction === 'in' ? 'green' : r.direction === 'out' || r.direction === 'charge' ? 'blue' : 'grey'}>
                  {directionLabel(r)}
                </Pill>
                {statusPill(r)}
                {r.transaction_id && <span className="font-mono text-xs text-muted-foreground">{r.transaction_id}</span>}
              </div>
              {renderActions(r)}
            </div>
          ))}
        </div>

        <div className="border-t px-4 py-3">
          <Pager page={safePage} pageSize={PAGE_SIZE} total={rows.length} onPage={setPage} noun="emails" />
        </div>
      </div>

      <Sheet open={!!detailRow} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader className="text-left">
            <SheetTitle>Email details</SheetTitle>
            <SheetDescription>What was read from this email and what has happened to the money.</SheetDescription>
          </SheetHeader>
          {detailRow && (
            <DetailPanel
              row={detailRow}
              input={inputFor(detailRow)}
              status={statusOf(detailRow)}
              onSendToWallet={(r) => { setDetailId(null); onSendToWallet(r); }}
              onChargeWallet={(r) => { setDetailId(null); onChargeWallet(r); }}
              onMarkResolved={(r) => { setDetailId(null); onMarkResolved(r); }}
              onViewHistory={(r) => { setDetailId(null); onViewHistory(r); }}
            />
          )}
        </SheetContent>
      </Sheet>
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
  const label = status?.label ?? '';
  const isIn = row.direction === 'in';
  const { canSend, canCharge, canResolve } = eligibilityFor(row, input, status);

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
    <div className="mt-5 flex flex-col gap-5" aria-label="Selected email details">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-2xl font-bold tracking-tight tabular-nums">{fmtUgx(row.amount)}</div>
          <div className="text-xs text-muted-foreground">{directionLabel(row)} · {when(row.internal_date)}</div>
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
    </div>
  );
}

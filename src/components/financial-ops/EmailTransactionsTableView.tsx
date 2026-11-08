import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, CircleDot, Clock, Eye, History, Info, Mail, MoreHorizontal, Send, Wallet, X,
} from 'lucide-react';
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

const PAGE_SIZE = 25;

/** Solid status colours, light and dark. */
const TONE_CLASS: Record<WalletStatusTone, string> = {
  green: 'bg-[#E4F6EA] text-[#16703A] dark:bg-emerald-500/20 dark:text-emerald-300',
  amber: 'bg-[#FDF1D6] text-[#97580A] dark:bg-amber-500/20 dark:text-amber-300',
  red: 'bg-[#FDE7E7] text-[#B42318] dark:bg-rose-500/20 dark:text-rose-300',
  blue: 'bg-[#E3F0FD] text-[#1D5DB0] dark:bg-sky-500/20 dark:text-sky-300',
  violet: 'bg-[#EFE8FF] text-[#5A1FD0] dark:bg-violet-500/20 dark:text-violet-300',
  grey: 'border border-[#D5DAE3] bg-white text-slate-600 dark:border-slate-600 dark:bg-transparent dark:text-slate-300',
};

const DOT_CLASS: Record<WalletStatusTone, string> = {
  green: 'text-[#1F9D55]',
  amber: 'text-[#E0A21A]',
  red: 'text-[#D92D20]',
  blue: 'text-[#2F7DD6]',
  violet: 'text-[#6D2EE8]',
  grey: 'text-slate-400',
};

type HistoryEntry = WalletStatusInput['history'][number] & { routed_by_name?: string | null };
type CreditedEntry = WalletStatusInput['credited'][number];
type MarkEntry = { mark: 'credited' | 'uncredited'; created_at?: string; marked_by_name?: string | null };

/** The per-email lookups the panel already holds. */
export interface RowMaps {
  routingHistory: Record<string, HistoryEntry[]>;
  creditedDeposits: Record<string, CreditedEntry[]>;
  manualMarks: Record<string, MarkEntry>;
  ledgerCredits: Record<string, unknown[]>;
  justRoutedIds: Set<string>;
}

export interface MatchInfo { name: string; label: string; score: number }

export interface RowActions {
  /** Each action opens the panel's existing confirmation, never acts directly. */
  onSendToWallet: (row: GmailTx) => void;
  onChargeWallet: (row: GmailTx) => void;
  onMarkResolved: (row: GmailTx) => void;
  onViewHistory: (row: GmailTx) => void;
}

export interface EmailTransactionsTableViewProps extends RowMaps, RowActions {
  rows: GmailTx[];
  selectedIds: Set<string>;
  setSelectedIds: (next: Set<string>) => void;
  /** The email shown in the detail panel (null = none). Owned by the panel so the panel can sit beside the list. */
  detailId: string | null;
  setDetailId: (id: string | null) => void;
  /** At xl and up the detail panel is a column beside the list; below that it opens as a drawer. */
  inlinePanel: boolean;
  matchFor?: (r: GmailTx) => MatchInfo | null;
  channelLabelFor?: (r: GmailTx) => { label: string; tone: WalletStatusTone } | null;
}

/** True from 1280px up. */
export function useIsXl() {
  const q = '(min-width: 1280px)';
  const [xl, setXl] = useState(() => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q);
    const on = () => setXl(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return xl;
}

export function deriveRow(r: GmailTx, m: RowMaps) {
  const input: WalletStatusInput = {
    history: m.routingHistory[r.id] ?? [],
    credited: m.creditedDeposits[r.id] ?? [],
    manualMark: m.manualMarks[r.id] ?? null,
    ledgerHit: (m.ledgerCredits[r.id] ?? []).length > 0,
    justRouted: m.justRoutedIds.has(r.id),
  };
  return { input, status: deriveWalletStatus(r, input) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "8 Nov 20:41", 24-hour, in the viewer's timezone. */
function when(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

function directionLabel(r: GmailTx): string {
  if (r.direction === 'in') return 'Money in';
  if (r.direction === 'out' || r.direction === 'charge') return 'Money out';
  return 'Fee';
}

function senderOf(r: GmailTx) {
  return (r.counterparty_name || r.counterparty || r.from_name || r.from_email || 'Unknown sender').trim();
}

/** The mailbox the email arrived through, e.g. "Android SMS via IFTTT". */
function mailboxOf(r: GmailTx) {
  return (r.from_name || r.from_email || 'Unknown sender').trim();
}

function AndroidMark({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g fill="#3DDC84">
        <path d="M5.5 10a6.5 6.5 0 0 1 13 0Z" />
        <rect x="5.5" y="11" width="13" height="7" rx="1.5" />
        <rect x="2.5" y="11" width="2" height="5.5" rx="1" />
        <rect x="19.5" y="11" width="2" height="5.5" rx="1" />
        <rect x="8.5" y="17" width="2.2" height="4.5" rx="1.1" />
        <rect x="13.3" y="17" width="2.2" height="4.5" rx="1.1" />
        <path d="M8 3.2 9.3 5.3M16 3.2 14.7 5.3" stroke="#3DDC84" strokeWidth="1" strokeLinecap="round" />
      </g>
      <circle cx="9.5" cy="7.6" r=".8" fill="#fff" />
      <circle cx="14.5" cy="7.6" r=".8" fill="#fff" />
    </svg>
  );
}

function SenderIcon({ r }: { r: GmailTx }) {
  return /android|ifttt|sms/i.test(mailboxOf(r))
    ? <AndroidMark />
    : <Mail className="h-5 w-5 text-slate-500" strokeWidth={1.75} aria-hidden="true" />;
}

function StatusIcon({ label, className = 'h-4 w-4' }: { label: string; className?: string }) {
  if (label === 'Credited') return <Check className={className} strokeWidth={2.5} aria-hidden="true" />;
  if (label === 'Partially credited') return <CircleDot className={className} aria-hidden="true" />;
  if (label === 'Not charged yet') return <Circle className={className} aria-hidden="true" />;
  return <Clock className={className} aria-hidden="true" />;
}

function Pill({ tone, label, icon = true, children }: { tone: WalletStatusTone; label?: string; icon?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-semibold leading-tight ${TONE_CLASS[tone]}`}>
      {icon && label ? <StatusIcon label={label} className="h-4 w-4 shrink-0" /> : null}
      <span>{children}</span>
    </span>
  );
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
 * confirmation or history surface, so no money moves from here.
 */
export function EmailTransactionsTableView({
  rows, selectedIds, setSelectedIds, routingHistory, creditedDeposits, manualMarks, ledgerCredits,
  justRoutedIds, onSendToWallet, onChargeWallet, onMarkResolved, onViewHistory,
  detailId, setDetailId, inlinePanel, matchFor, channelLabelFor,
}: EmailTransactionsTableViewProps) {
  const [page, setPage] = useState(0);
  const maps: RowMaps = { routingHistory, creditedDeposits, manualMarks, ledgerCredits, justRoutedIds };

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => { if (page !== safePage) setPage(safePage); }, [page, safePage]);
  const pageRows = useMemo(
    () => rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [rows, safePage],
  );

  // Beside the list the panel is always open, on the first email until one is chosen.
  useEffect(() => {
    if (inlinePanel && pageRows.length > 0 && (detailId === null || !rows.some((r) => r.id === detailId))) {
      setDetailId(pageRows[0].id);
    }
  }, [inlinePanel, pageRows, rows, detailId, setDetailId]);

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

  const outlineBtn = 'min-h-[40px] rounded-lg border-[#C9B8F5] bg-white px-4 font-semibold text-[#5A1FD0] hover:bg-[#F3EEFF] hover:text-[#4413A8] dark:border-violet-500/50 dark:bg-transparent dark:text-violet-300';

  /** The one button shown on a row, and the menu behind the ⋯ button. */
  const renderActions = (r: GmailTx) => {
    const { input, status } = deriveRow(r, maps);
    const { canSend, canCharge, canResolve } = eligibilityFor(r, input, status);
    return (
      <div className="flex items-center gap-2">
        {canSend ? (
          <Button size="sm" variant="outline" className={outlineBtn} onClick={() => onSendToWallet(r)}>Route</Button>
        ) : canCharge ? (
          <Button size="sm" variant="outline" className={outlineBtn} onClick={() => onChargeWallet(r)}>Charge</Button>
        ) : (
          <Button size="sm" variant="outline" className={outlineBtn} onClick={() => setDetailId(r.id)}>View</Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="outline" className="h-10 w-10 rounded-lg border-[#D5DAE3] text-slate-700 dark:border-slate-600 dark:text-slate-200" aria-label={`More actions for ${senderOf(r)}`}>
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
                <Send className="mr-2 h-4 w-4" aria-hidden="true" /> Send to wallet
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
    if (isUnparsedRow(r)) return <Pill tone="amber" label="Could not read">Could not read</Pill>;
    const { status } = deriveRow(r, maps);
    return status ? <Pill tone={status.tone} label={status.label}>{status.label}</Pill> : <span className="text-muted-foreground">—</span>;
  };

  const from = rows.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const to = Math.min(rows.length, (safePage + 1) * PAGE_SIZE);

  return (
    <div>
      {/* Tablet and desktop: a table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-sm font-bold text-foreground">
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
            {pageRows.map((r) => {
              const active = r.id === detailId;
              return (
                <tr
                  key={r.id}
                  onClick={() => setDetailId(r.id)}
                  className={`cursor-pointer border-b align-middle ${active ? 'bg-[#F3EEFF] shadow-[inset_3px_0_0_#6D2EE8] dark:bg-violet-500/10' : 'hover:bg-muted/30'}`}
                >
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(r.id)}
                      onCheckedChange={(v) => toggleOne(r.id, v === true)}
                      aria-label={`Select email from ${senderOf(r)}`}
                    />
                  </td>
                  <td className="max-w-[210px] px-2 py-3">
                    <div className="flex items-center gap-2.5">
                      <SenderIcon r={r} />
                      <div className="min-w-0">
                        <div className="line-clamp-2 break-words text-sm font-bold leading-tight text-foreground">{mailboxOf(r)}</div>
                        <div className="text-xs text-muted-foreground">{directionLabel(r)}</div>
                      </div>
                    </div>
                  </td>
                  <td className="max-w-[220px] px-2 py-3 text-sm text-foreground/80" title={r.subject ?? undefined}>
                    <span className="line-clamp-2 break-words">{r.subject || '—'}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-3 text-right text-base font-extrabold text-foreground">
                    {r.amount == null ? '—' : Math.round(r.amount).toLocaleString()}
                  </td>
                  <td className="px-2 py-3 font-mono text-xs text-foreground/80">{r.transaction_id || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-3 text-foreground/80">{when(r.internal_date)}</td>
                  <td className="px-2 py-3">{statusPill(r)}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>{renderActions(r)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phone: one card per email */}
      <div className="space-y-3 p-3 md:hidden">
        {pageRows.map((r) => (
          <div key={r.id} className="space-y-2.5 rounded-2xl border bg-card p-3.5">
            <div className="flex items-start justify-between gap-3">
              <button type="button" onClick={() => setDetailId(r.id)} className="min-w-0 text-left">
                <div className="text-lg font-extrabold">{fmtUgx(r.amount)}</div>
                <div className="truncate text-sm text-muted-foreground">{mailboxOf(r)} · {when(r.internal_date)}</div>
              </button>
              <Checkbox
                checked={selectedIds.has(r.id)}
                onCheckedChange={(v) => toggleOne(r.id, v === true)}
                aria-label={`Select email from ${senderOf(r)}`}
              />
            </div>
            {r.subject && <p className="line-clamp-2 text-xs text-muted-foreground">{r.subject}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={r.direction === 'in' ? 'green' : r.direction === 'out' || r.direction === 'charge' ? 'blue' : 'grey'} icon={false}>
                {directionLabel(r)}
              </Pill>
              {statusPill(r)}
              {r.transaction_id && <span className="font-mono text-xs text-muted-foreground">{r.transaction_id}</span>}
            </div>
            {renderActions(r)}
          </div>
        ))}
      </div>

      {/* Footer: how many, and the pager */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
        <p className="text-sm text-foreground/80" role="status">
          {from.toLocaleString()}–{to.toLocaleString()} of {rows.length.toLocaleString()} emails
        </p>
        {totalPages > 1 && (
          <nav className="flex items-center gap-2" aria-label="Pages">
            <Button variant="outline" className="min-h-[40px] gap-2 rounded-lg px-4 text-slate-600 dark:text-slate-300" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Previous
            </Button>
            <Button variant="outline" className={`${outlineBtn} gap-2`} disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
              Next <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </nav>
        )}
      </div>

      {/* Below xl the details open as a drawer */}
      {!inlinePanel && (
        <Sheet open={!!detailRow} onOpenChange={(open) => { if (!open) setDetailId(null); }}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader className="text-left">
              <SheetTitle>Transaction details</SheetTitle>
              <SheetDescription>What was read from this email and what has happened to the money.</SheetDescription>
            </SheetHeader>
            {detailRow && (
              <EmailDetailBody
                row={detailRow}
                maps={maps}
                match={matchFor?.(detailRow) ?? null}
                channel={channelLabelFor?.(detailRow) ?? null}
                actions={{
                  onSendToWallet: (r) => { setDetailId(null); onSendToWallet(r); },
                  onChargeWallet: (r) => { setDetailId(null); onChargeWallet(r); },
                  onMarkResolved: (r) => { setDetailId(null); onMarkResolved(r); },
                  onViewHistory: (r) => { setDetailId(null); onViewHistory(r); },
                }}
              />
            )}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

/** The column beside the list at xl and up. Same content as the drawer, in a card. */
export function EmailDetailPanel({
  row, maps, match, channel, actions, onClose,
}: {
  row: GmailTx;
  maps: RowMaps;
  match: MatchInfo | null;
  channel: { label: string; tone: WalletStatusTone } | null;
  actions: RowActions;
  onClose: () => void;
}) {
  return (
    <section aria-label="Transaction details" className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-extrabold tracking-tight text-foreground">Transaction details</h2>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-lg p-1.5 text-slate-500 hover:bg-muted hover:text-foreground">
          <X className="h-5 w-5" />
        </button>
      </div>
      <EmailDetailBody row={row} maps={maps} match={match} channel={channel} actions={actions} />
    </section>
  );
}

function EmailDetailBody({
  row, maps, match, channel, actions,
}: {
  row: GmailTx;
  maps: RowMaps;
  match: MatchInfo | null;
  channel: { label: string; tone: WalletStatusTone } | null;
  actions: RowActions;
}) {
  const { input, status } = deriveRow(row, maps);
  const label = status?.label ?? '';
  const isIn = row.direction === 'in';
  const { canSend, canCharge, canResolve } = eligibilityFor(row, input, status);

  const matchedWallet =
    input.history.find((h) => h.target_user_name)?.target_user_name
    || input.credited[0]?.user_name
    || null;
  const walletShown = matchedWallet ?? (match ? match.name : null);

  const timeline = useMemo(() => {
    const items: Array<{ key: string; title: string; at: string | null; tone: WalletStatusTone; waiting?: boolean }> = [];
    items.push({ key: 'received', title: 'Email received', at: row.internal_date, tone: 'green' });
    items.push(
      isUnparsedRow(row)
        ? { key: 'read', title: 'Could not read an amount from this email', at: row.internal_date, tone: 'red' }
        : { key: 'read', title: 'Amount read', at: row.internal_date, tone: 'green' },
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
        title: isIn ? 'Waiting for routing' : 'Waiting to be charged',
        at: null,
        tone: 'amber',
        waiting: true,
      });
    }
    return items.sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  }, [row, input, status, label, isIn]);

  const directionTone: WalletStatusTone = isIn ? 'green' : row.direction === 'out' || row.direction === 'charge' ? 'blue' : 'grey';
  const confTone: WalletStatusTone = !match ? 'grey' : match.score >= 90 ? 'green' : match.score >= 75 ? 'blue' : 'amber';

  return (
    <div className="mt-4 flex flex-col gap-5" aria-label="Selected email details">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-3xl font-black tracking-tight text-foreground">{fmtUgx(row.amount)}</div>
        </div>
        {status && <Pill tone={status.tone} label={status.label}>{status.label}</Pill>}
      </div>

      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <span className={`rounded-lg px-3 py-1 text-sm font-semibold ${TONE_CLASS[directionTone]}`}>{directionLabel(row)}</span>
        {channel && <span className={`rounded-lg px-3 py-1 text-sm font-semibold ${TONE_CLASS[channel.tone]}`}>{channel.label}</span>}
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2.5 text-sm">
        <dt className="text-muted-foreground">Sender</dt>
        <dd className="min-w-0 break-words font-medium text-foreground">{mailboxOf(row)}</dd>
        <dt className="text-muted-foreground">Counterparty</dt>
        <dd className="min-w-0 break-words font-medium text-foreground">{row.counterparty || row.counterparty_name || '—'}</dd>
        <dt className="text-muted-foreground">Transaction ID</dt>
        <dd className="min-w-0 break-all font-medium text-foreground">{row.transaction_id || '—'}</dd>
        <dt className="text-muted-foreground">Matched wallet</dt>
        <dd className="min-w-0 break-words font-medium text-foreground">
          {walletShown ?? 'Not matched yet'}
          {!matchedWallet && match ? <span className="ml-1 text-xs font-normal text-muted-foreground">(suggested)</span> : null}
        </dd>
        {match && (
          <>
            <dt className="text-muted-foreground">Confidence</dt>
            <dd><span className={`inline-block rounded-md px-2.5 py-0.5 text-sm font-semibold ${TONE_CLASS[confTone]}`}>{match.label} · {match.score}%</span></dd>
          </>
        )}
      </dl>

      <div className="space-y-2 border-t pt-4">
        <div className="text-base font-bold text-foreground">Original email</div>
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/40 p-3 text-sm leading-relaxed text-foreground/80">
          {[row.subject, row.snippet].filter(Boolean).join('\n\n') || 'No text was saved for this email.'}
        </div>
      </div>

      <div className="space-y-2 border-t pt-4">
        <div className="text-base font-bold text-foreground">Timeline</div>
        <div className="space-y-1">
          {timeline.map((t) => (
            <div
              key={t.key}
              className={`flex items-start gap-3 rounded-lg px-1 py-1.5 ${t.waiting ? 'bg-[#FDF1D6] px-2 dark:bg-amber-500/15' : ''}`}
            >
              {t.waiting
                ? <Circle className={`mt-0.5 h-5 w-5 shrink-0 ${DOT_CLASS[t.tone]}`} strokeWidth={2.5} aria-hidden="true" />
                : <CheckCircle2 className={`mt-0.5 h-5 w-5 shrink-0 ${DOT_CLASS[t.tone]}`} aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-semibold text-foreground">{t.title}</div>
                  {t.at && <div className="shrink-0 text-sm text-foreground/70">{when(t.at)}</div>}
                </div>
                {t.key === 'read' && !isUnparsedRow(row) && row.amount != null && (
                  <div className="text-sm text-muted-foreground">{fmtUgx(row.amount)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {canSend && (
          <Button onClick={() => actions.onSendToWallet(row)} className="h-12 gap-2 rounded-xl bg-[#5A1FD0] text-base font-bold text-white hover:bg-[#4413A8]">
            <Send className="h-4 w-4" aria-hidden="true" /> Send to wallet
          </Button>
        )}
        {canCharge && (
          <Button onClick={() => actions.onChargeWallet(row)} className="h-12 gap-2 rounded-xl bg-[#5A1FD0] text-base font-bold text-white hover:bg-[#4413A8]">
            <Wallet className="h-4 w-4" aria-hidden="true" /> Charge wallet
          </Button>
        )}
        <div className="grid grid-cols-2 gap-2.5">
          <Button variant="outline" disabled={!canResolve} onClick={() => actions.onMarkResolved(row)} className="h-11 rounded-xl border-[#C9B8F5] font-semibold text-[#5A1FD0] dark:border-violet-500/50 dark:text-violet-300">
            Mark resolved
          </Button>
          <Button variant="outline" onClick={() => actions.onViewHistory(row)} className="h-11 gap-2 rounded-xl border-[#C9B8F5] font-semibold text-[#5A1FD0] dark:border-violet-500/50 dark:text-violet-300">
            <History className="h-4 w-4" aria-hidden="true" /> View history
          </Button>
        </div>
        {(canSend || canCharge) && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" /> Review recipient before confirming.
          </p>
        )}
      </div>
    </div>
  );
}

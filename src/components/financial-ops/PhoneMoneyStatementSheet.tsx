import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowDownLeft, ArrowUpRight, Banknote, Loader2, Phone, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useActualMoneyHeld } from '@/hooks/useActualMoneyHeld';

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.297.298-.496.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421-7.11c4.629 0 8.407 3.764 8.407 8.39 0 4.629-3.778 8.407-8.407 8.407-1.458 0-2.832-.372-4.029-1.03l-2.858.913 1.032-2.787c-.744-1.206-1.178-2.619-1.178-4.12 0-4.626 3.765-8.39 8.392-8.39m0-1.05c-5.21 0-9.442 4.233-9.442 9.44 0 1.79.5 3.466 1.368 4.897L3.75 21.25l2.715-1.003c1.32.86 2.893 1.36 4.586 1.36 5.21 0 9.442-4.233 9.442-9.442 0-5.207-4.232-9.44-9.442-9.44z" />
    </svg>
  );
}

const PAGE_SIZE = 20;

export type PhoneMoneyLine = 'mtn_momo' | 'airtel_money' | 'cash' | 'bank' | 'banked_cash';

interface Props {
  line: PhoneMoneyLine | null;
  onOpenChange: (open: boolean) => void;
  /** Optional: lets the account breakdown switch the statement to another line. */
  onSelectLine?: (line: PhoneMoneyLine) => void;
}

const TITLES: Record<PhoneMoneyLine, string> = {
  mtn_momo: 'MTN Money statement',
  airtel_money: 'Airtel Money statement',
  cash: 'Cash at hand statement',
  bank: 'Money at Bank — Bayo Mercy account',
  banked_cash: 'Cash at Bank — Financial Ops banked deposits',
};

interface Row {
  id: string;
  at: string | null;
  amount: number;
  direction: 'in' | 'out' | 'charge' | 'cash';
  party: string;
  reference: string | null;
  balanceAfter: number | null;
  note: string | null;
  phone: string | null;
  /** Coarse grouping used by the category filter. */
  category: string;
}

type DirectionFilter = 'all' | 'in' | 'out';

function purposeLabel(purpose: string | null | undefined): string {
  if (purpose === 'operational_float') return 'Agent float';
  if (purpose === 'personal_deposit') return 'Personal deposit';
  return 'Other deposit';
}

function dayStart(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00`).getTime();
}

function dayEnd(isoDate: string): number {
  return new Date(`${isoDate}T23:59:59.999`).getTime();
}

/**
 * Detailed movement statement for one Actual Money line. Read-only: it simply
 * replays the provider SMS/emails (or verified cash deposits) that produced the
 * balance shown on the card, and resolves who the money came from / went to.
 */
export function PhoneMoneyStatementSheet({ line, onOpenChange, onSelectLine }: Props) {
  const { data: held } = useActualMoneyHeld(!!line);

  /** Every configured money bucket, so the drilldown shows where each amount sits. */
  const accountRows = useMemo(() => {
    if (!held) return [];
    return [
      { line: 'mtn_momo' as PhoneMoneyLine, label: 'MTN Money', amount: held.mtn },
      { line: 'airtel_money' as PhoneMoneyLine, label: 'Airtel Money', amount: held.airtel },
      { line: 'cash' as PhoneMoneyLine, label: 'Cash in Custody — Not Yet Confirmed Banked', amount: held.cashAtHand },
      { line: 'banked_cash' as PhoneMoneyLine, label: 'Cash at Bank (Financial Ops banked)', amount: held.bankedCash },
      { line: 'bank' as PhoneMoneyLine, label: 'Bayo Mercy bank account (reference)', amount: held.bankReconciliation },
    ];
  }, [held]);

  const { data, isLoading } = useQuery({
    queryKey: ['finops-phone-money-statement', line],
    enabled: !!line,
    staleTime: 15_000,
    queryFn: async (): Promise<Row[]> => {
      if (line === 'cash' || line === 'banked_cash') {
        // Mirror the card exactly: latest verification per deposit request,
        // status 'verified', split by the Financial Ops cash location flag.
        const { data: cash, error } = await supabase
          .from('cash_deposit_verifications')
          .select('id, amount, status, user_id, verified_at, created_at, deposit_request_id, deposit_requests!inner(purpose_audit, deposit_purpose)')
          .order('created_at', { ascending: false })
          .limit(1000);
        if (error) throw error;

        const latest = new Map<string, any>();
        for (const c of (cash ?? []) as any[]) {
          const key = String(c.deposit_request_id);
          if (!latest.has(key)) latest.set(key, c);
        }
        const rows = Array.from(latest.values())
          .filter((c: any) => {
            if (c.status !== 'verified') return false;
            const loc = (c.deposit_requests?.purpose_audit?.cash_location ?? 'cash_at_hand') as string;
            return line === 'banked_cash' ? loc === 'bank' : loc !== 'bank';
          })
          .sort((a: any, b: any) =>
            new Date(b.verified_at ?? b.created_at).getTime() - new Date(a.verified_at ?? a.created_at).getTime(),
          );

        const people = await resolveNames(rows.map((c: any) => c.user_id));
        return rows.map((c: any) => ({
          id: c.id,
          at: c.verified_at ?? c.created_at,
          amount: Number(c.amount ?? 0),
          direction: 'cash' as const,
          party: people.get(c.user_id)?.name ?? 'Unknown depositor',
          reference: c.deposit_request_id ? String(c.deposit_request_id).slice(0, 8) : null,
          balanceAfter: null,
          note: line === 'banked_cash'
            ? 'Verified cash deposit — marked as banked by Financial Ops'
            : 'Verified cash collected — awaiting banking',
          phone: people.get(c.user_id)?.phone ?? null,
          category: purposeLabel(c.deposit_requests?.deposit_purpose),
        }));
      }


       if (line === 'bank') {
         const { data: reconciliation, error } = await supabase.rpc('get_money_at_bank_reconciliation' as any);
         if (error) throw error;
         const movements = Array.isArray((reconciliation as any)?.qualifying_emails)
           ? (reconciliation as any).qualifying_emails
           : [];
         // `party` is who the money moved to/from (the counterparty), never
         // the account being viewed itself -- otherwise "From/To Bayo Mercy
         // account" reads backwards on every row regardless of direction.
         return movements.map((t: any) => ({
           id: String(t.id),
           at: t.extracted_at ?? null,
           amount: Number(t.amount ?? 0),
           direction: (t.direction === 'out' ? 'out' : 'in') as Row['direction'],
           party: t.counterparty || extractParty(t.snippet) || String(t.match_reason ?? 'Bayo Mercy account activity'),
           reference: t.transaction_id ?? null,
           balanceAfter: null,
            note: t.snippet ? String(t.snippet).slice(0, 180) : String(t.match_reason ?? 'Qualifying Bayo Mercy account alert'),
            phone: null,
            category: t.direction === 'out' ? 'Money out' : 'Money in',
          }));
       }

      const { data: tx, error } = await supabase
        .from('gmail_transactions')
        .select('id, amount, direction, counterparty, balance, internal_date, created_at, transaction_id, snippet, linked_deposit_request_id')
        .eq('channel', line as string)
        .order('internal_date', { ascending: false })
        .limit(120);
      if (error) throw error;

      const depositIds = (tx ?? []).map((t: any) => t.linked_deposit_request_id).filter(Boolean);
      let depositUsers = new Map<string, { name: string; phone: string | null }>();
      if (depositIds.length) {
        const { data: deps } = await supabase
          .from('deposit_requests')
          .select('id, user_id')
          .in('id', depositIds);
        const people = await resolveNames((deps ?? []).map((d: any) => d.user_id));
        depositUsers = new Map(
          (deps ?? []).map((d: any) => [d.id, people.get(d.user_id) ?? { name: 'Unknown user', phone: null }]),
        );
      }

      return (tx ?? []).map((t: any) => {
        const linked = t.linked_deposit_request_id ? depositUsers.get(t.linked_deposit_request_id) : null;
        const raw = (t.counterparty || '').trim();
        const fromSnippet = extractParty(t.snippet);
        const party =
          linked?.name || (raw && raw.toLowerCase() !== 'you have received' ? raw : '') || fromSnippet || 'Unnamed counterparty';
        return {
          id: t.id,
          at: t.internal_date ?? t.created_at,
          amount: Number(t.amount ?? 0),
          direction: (t.direction === 'out' ? 'out' : t.direction === 'charge' ? 'charge' : 'in') as Row['direction'],
          party,
          reference: t.transaction_id ?? null,
          balanceAfter: t.balance != null ? Number(t.balance) : null,
          note: t.snippet ? String(t.snippet).slice(0, 180) : null,
          phone: linked?.phone ?? extractPhone(t.counterparty) ?? extractPhone(t.snippet),
          category: t.direction === 'charge' ? 'Provider charge' : t.direction === 'out' ? 'Money out' : 'Money in',
        };
      });
    },
  });

  const rows = data ?? [];
  const isMobile = useIsMobile();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<DirectionFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [category, setCategory] = useState<string>('all');
  useEffect(() => { setPage(0); setDateFrom(''); setDateTo(''); setCategory('all'); setFilter('all'); }, [line]);
  useEffect(() => { setPage(0); }, [filter, dateFrom, dateTo, category]);

  const isInflow = (r: Row) => r.direction === 'in' || r.direction === 'cash';

  const categories = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => set.add(r.category));
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const fromMs = dateFrom ? dayStart(dateFrom) : null;
    const toMs = dateTo ? dayEnd(dateTo) : null;
    return rows.filter((r) => {
      if (filter === 'in' && !isInflow(r)) return false;
      if (filter === 'out' && isInflow(r)) return false;
      if (category !== 'all' && r.category !== category) return false;
      if (fromMs != null || toMs != null) {
        const at = r.at ? new Date(r.at).getTime() : null;
        if (at == null) return false;
        if (fromMs != null && at < fromMs) return false;
        if (toMs != null && at > toMs) return false;
      }
      return true;
    });
  }, [rows, filter, dateFrom, dateTo, category]);

  const hasDrillFilters = dateFrom !== '' || dateTo !== '' || category !== 'all';

  const totals = useMemo(() => {
    let inflow = 0;
    let outflow = 0;
    filteredRows.forEach((r) => {
      if (isInflow(r)) inflow += r.amount;
      else outflow += r.amount;
    });
    return { inflow, outflow };
  }, [filteredRows]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filteredRows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <Sheet open={!!line} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          'flex flex-col p-0 gap-0',
          isMobile ? 'h-[92dvh] rounded-t-2xl' : 'w-full sm:max-w-xl',
        )}
      >
        <SheetHeader className="p-4 sm:p-5 pb-3 border-b border-border shrink-0 text-left">
          <SheetTitle>{line ? TITLES[line] : 'Statement'}</SheetTitle>
          <SheetDescription className="text-xs sm:text-sm">
             {line === 'banked_cash'
               ? 'Verified cash deposits explicitly marked as banked by Financial Ops.'
               : line === 'bank'
               ? 'Bayo Mercy account balance: qualifying credits in less debits out.'
               : line === 'cash'
              ? 'Verified cash deposits collected by agents and not yet banked.'
              : 'Every money-in and money-out movement parsed from provider messages on this line.'}
          </SheetDescription>
          <div className="flex gap-4 pt-2">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Money in</p>
              <p className="font-mono text-sm font-semibold text-success">{formatUGX(totals.inflow)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Money out</p>
              <p className="font-mono text-sm font-semibold text-destructive">{formatUGX(totals.outflow)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-3">
            {(['all', 'in', 'out'] as DirectionFilter[]).map((key) => (
              <Button
                key={key}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFilter(key)}
                className={cn(
                  'h-7 px-3 text-xs rounded-full border transition-colors',
                  filter === key
                    ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90'
                    : 'bg-background text-muted-foreground border-border hover:bg-muted',
                )}
              >
                {key === 'all' ? 'All' : key === 'in' ? 'Money in' : 'Money out'}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2 pt-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">From</p>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="mt-0.5 h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">To</p>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                className="mt-0.5 h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
            </div>
            <div className="min-w-0 flex-1 sm:max-w-[180px]">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Category</p>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-0.5 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                <option value="all">All categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            {hasDrillFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => { setDateFrom(''); setDateTo(''); setCategory('all'); }}
                className="h-8 px-2 text-xs text-muted-foreground"
              >
                Clear
              </Button>
            )}
          </div>
          {hasDrillFilters && (
            <p className="pt-1.5 text-[11px] text-muted-foreground">
              {filteredRows.length} of {rows.length} movement(s) match
            </p>
          )}

          {accountRows.length > 0 && (
            <div className="mt-3 rounded-xl border border-border bg-muted/30 p-2.5">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Where the money sits — by account
              </p>
              <div className="mt-1.5 space-y-0.5">
                {accountRows.map((a) => {
                  const active = a.line === line;
                  const share = held && held.total > 0 ? (a.amount / held.total) * 100 : 0;
                  return (
                    <button
                      key={a.line}
                      type="button"
                      disabled={!onSelectLine}
                      onClick={() => onSelectLine?.(a.line)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                        active ? 'bg-primary/10 ring-1 ring-primary/30' : onSelectLine ? 'hover:bg-muted/70' : '',
                      )}
                    >
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {a.label}
                        {a.line === 'bank' ? '' : ` · ${share.toFixed(1)}%`}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-foreground">
                        {formatUGX(a.amount)}
                      </span>
                    </button>
                  );
                })}
              </div>
              {held && (
                <p className="mt-1.5 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                  Money We Have total{' '}
                  <span className="font-mono font-semibold text-foreground">{formatUGX(held.total)}</span> · the Bayo
                  Mercy bank account is a reference figure and is not added to the total.
                </p>
              )}
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] divide-y divide-border">
          {isLoading && (
            <div className="p-8 flex items-center justify-center text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading statement…
            </div>
          )}
          {!isLoading && rows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No movements recorded on this line yet.</p>
          )}
          {!isLoading && rows.length > 0 && filteredRows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              No movements match the current filters.
            </p>
          )}
          {pageRows.map((r) => {
            const isIn = r.direction === 'in' || r.direction === 'cash';
            return (
              <div key={r.id} className="p-3 sm:p-4 flex items-start gap-3">
                <div className={cn('p-2 rounded-lg shrink-0', isIn ? 'bg-success/10' : 'bg-destructive/10')}>
                  {r.direction === 'cash' ? (
                    <Banknote className="h-4 w-4 text-success" />
                  ) : isIn ? (
                    <ArrowDownLeft className="h-4 w-4 text-success" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 text-destructive" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground break-words">
                    {isIn ? 'From' : 'To'} {r.party}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.at ? format(new Date(r.at), 'd MMM yyyy, HH:mm') : 'No date'}
                    {r.reference ? ` • ${r.reference}` : ''}
                  </p>
                  {r.note && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground break-words">{r.note}</p>}
                  {r.direction === 'charge' && (
                    <Badge variant="outline" className="mt-1 text-[10px]">Provider charge</Badge>
                  )}
                  {r.direction === 'cash' && r.category !== 'Other deposit' && (
                    <Badge variant="outline" className="mt-1 text-[10px]">{r.category}</Badge>
                  )}
                  {r.phone && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-xs"
                      >
                        <a href={`tel:${normalizePhone(r.phone)}`}>
                          <Phone className="h-3.5 w-3.5 mr-1.5" /> Call
                        </a>
                      </Button>
                      <Button
                        asChild
                        variant="default"
                        size="sm"
                        className="h-8 px-2 text-xs"
                      >
                        <a
                          href={`https://wa.me/${normalizePhone(r.phone).replace(/\D/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <WhatsAppIcon className="h-3.5 w-3.5 mr-1.5" /> WhatsApp
                        </a>
                      </Button>
                    </div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className={cn('font-mono text-xs sm:text-sm font-semibold tabular-nums', isIn ? 'text-success' : 'text-destructive')}>
                    {isIn ? '+' : '-'}{formatUGX(r.amount)}
                  </p>
                  {r.balanceAfter != null && (
                    <p className="text-[11px] text-muted-foreground font-mono">Bal {formatUGX(r.balanceAfter)}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {filteredRows.length > PAGE_SIZE && (
          <div className="shrink-0 border-t border-border p-3 flex items-center justify-between gap-2 bg-background">
            <Button variant="outline" size="sm" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Prev
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {safePage + 1} of {pageCount} • {filteredRows.length} movements
            </p>
            <Button variant="outline" size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

async function resolveNames(userIds: (string | null)[]): Promise<Map<string, { name: string; phone: string | null }>> {
  const ids = Array.from(new Set(userIds.filter(Boolean) as string[]));
  if (!ids.length) return new Map();
  const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
  return new Map(
    (data ?? []).map((p: any) => [p.id, { name: p.full_name || p.phone || 'Unnamed user', phone: p.phone ?? null }]),
  );
}

/** Extract a Ugandan phone number from free text (SMS snippet / counterparty field). */
function extractPhone(text: string | null): string | null {
  if (!text) return null;
  const m = String(text).match(/(?:\+?256|0)7\d{8}/);
  return m ? m[0] : null;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('256')) return `+${digits}`;
  if (digits.startsWith('0')) return `+256${digits.slice(1)}`;
  return digits;
}

/** Pull a human name/phone out of a provider SMS snippet when the parser left counterparty empty. */
function extractParty(snippet: string | null): string | null {
  if (!snippet) return null;
  const m =
    snippet.match(/from\s+([A-Z][A-Za-z' ]{2,40}?)(?:\s+\d|,|\.|\s+on\b)/) ||
    snippet.match(/to\s+([A-Z][A-Za-z' ]{2,40}?)(?:\s+\d|,|\.|\s+on\b)/) ||
    snippet.match(/(2567\d{8}|07\d{8})/);
  return m ? m[1].trim() : null;
}

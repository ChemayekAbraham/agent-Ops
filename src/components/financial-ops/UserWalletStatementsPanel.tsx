import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { UserProfileDrilldown } from '@/components/ops/UserProfileDrilldown';
import { formatUGX } from '@/lib/rentCalculations';
import { plainDeductionReason } from '@/lib/deductionReason';
import { deductionTimeline } from '@/lib/deductionReason';
import { format } from 'date-fns';
import {
  Wallet, HandCoins, Banknote, Landmark, AlertTriangle, Loader2,
  ArrowDownLeft, ArrowUpRight, User, ChevronRight, Search, Info,
} from 'lucide-react';
import { ChevronDown, ExternalLink, Clock } from 'lucide-react';
import { LedgerEntryDetailDrawer } from '@/components/wallet/LedgerEntryDetailDrawer';

/**
 * Financial Ops — per-user wallet statements.
 *
 * Search any user, then read their wallet exactly the way THEY see it:
 *   • Withdrawable wallet
 *   • Operational float
 *   • Landlord payout float
 *   • Advance repayment
 *
 * Tapping the user's name opens the full profile drill-down (location,
 * contacts, roles, portfolios and every other detail).
 *
 * Ops / Fin Ops surface — read-only. Mirrors the user-facing labels &
 * plain-language reasons so the operator sees what the customer sees.
 */

type UserBrief = { id: string; full_name: string | null; phone: string | null };

const CATEGORY_LABEL: Record<string, string> = {
  agent_float_deposit: 'Float deposit',
  operational_float_deposit: 'Float deposit',
  agent_float_topup: 'Float top-up',
  float_received: 'Float received',
  partner_float_transfer_in: 'Partner transfer in',
  rent_payment_for_tenant: "Paid tenant's rent",
  agent_float_used_for_rent: "Paid tenant's rent",
  agent_float_payout: 'Float payout',
  float_withdrawal: 'Float withdrawal',
  landlord_payout: 'Paid landlord',
  partner_float_transfer_out: 'Partner transfer out',
  agent_rent_commission: 'Rent commission (10%)',
  rent_commission: 'Rent commission',
  agent_commission_earned: 'Commission earned',
  agent_commission: 'Commission earned',
  agent_commission_payout: 'Commission paid out',
  agent_commission_payable: 'Commission posted',
  agent_investment_commission: 'Investment commission',
  investment_commission: 'Investment commission',
  partner_commission: 'Partner commission (2%)',
  subagent_commission: 'Sub-agent override',
  registration_bonus: 'Registration bonus',
  verification_bonus: 'Verification bonus',
  facilitation_bonus: 'Facilitation bonus',
  listing_bonus: 'Listing bonus',
  tenant_placement_bonus: 'Tenant placement bonus',
  agent_bonus: 'Bonus',
  approval_bonus: 'Approval bonus',
  referral_bonus: 'Referral bonus',
  roi_wallet_credit: 'Investor returns',
  withdrawal: 'Withdrawal',
  agent_wallet_withdrawal: 'Withdrawal',
  wallet_withdrawal: 'Withdrawal',
  deposit: 'Deposit',
  wallet_deposit: 'Deposit',
  tenant_repayment: 'Tenant repayment',
  rent_repayment: 'Rent repayment',
  rent_auto_deduction: 'Auto rent deduction',
  agent_float_settlement: 'Float settled',
  rent_float_funding: 'Rent funding',
  rent_disbursement: 'Rent disbursed to landlord',
  rent_receivable_created: 'Rent recorded',
  advance_disbursement: 'Advance disbursed',
  advance_repayment: 'Advance repayment',
  advance_recovery: 'Advance recovered',
  balance_correction: 'Wallet correction',
  historical_balance_reseed: 'Opening balance',
  wallet_transfer: 'Wallet transfer',
  transfer_in: 'Transfer received',
  transfer_out: 'Transfer sent',
  welcome_bonus: 'Welcome bonus',
};

function labelFor(cat: string | null): string {
  if (!cat) return 'Transaction';
  return CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ');
}

function fmtTs(iso: string): string {
  try {
    return format(new Date(iso), 'd MMM yyyy, h:mm a');
  } catch {
    return iso;
  }
}

type BucketKey = 'withdrawable' | 'float' | 'advance';

interface LedgerRow {
  id: string;
  transaction_date: string;
  direction: string;
  category: string | null;
  description: string | null;
  amount: number;
  wallet_bucket: string | null;
  ledger_scope: string | null;
  source_table: string | null;
  source_id: string | null;
  classification: string | null;
  currency: string | null;
}

/* ── Wallet (cache) summary ── */
function useWalletSummary(userId: string | null) {
  return useQuery({
    queryKey: ['finops-user-wallet', userId],
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async () => {
      const [{ data: wallet }, { data: landlordFloat }] = await Promise.all([
        supabase
          .from('wallets')
          .select('withdrawable_balance, float_balance, advance_balance, balance')
          .eq('user_id', userId!)
          .maybeSingle(),
        supabase
          .from('agent_landlord_float')
          .select('balance, total_funded, total_paid_out')
          .eq('agent_id', userId!)
          .maybeSingle(),
      ]);
      return {
        withdrawable: Number(wallet?.withdrawable_balance ?? 0),
        float: Number(wallet?.float_balance ?? 0),
        advance: Number(wallet?.advance_balance ?? 0),
        landlordFloat: Number(landlordFloat?.balance ?? 0),
        landlordFunded: Number(landlordFloat?.total_funded ?? 0),
        landlordPaidOut: Number(landlordFloat?.total_paid_out ?? 0),
      };
    },
  });
}

/* ── Single expandable ledger row ── */
function LedgerRowItem({ row: r }: { row: LedgerRow }) {
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const isIn = r.direction === 'cash_in';
  const why = !isIn ? plainDeductionReason(r) : null;
  const timeline = !isIn ? deductionTimeline(r) : null;

  const rawFields: { label: string; value: string | null }[] = [
    { label: 'Category', value: r.category },
    { label: 'Direction', value: r.direction },
    { label: 'Wallet bucket', value: r.wallet_bucket },
    { label: 'Ledger scope', value: r.ledger_scope },
    { label: 'Classification', value: r.classification },
    { label: 'Currency', value: r.currency },
    { label: 'Source table', value: r.source_table },
    { label: 'Source ID', value: r.source_id },
    { label: 'Ledger ID', value: r.id },
    { label: 'Transaction date', value: r.transaction_date },
  ];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
      >
        <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${isIn ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>
          {isIn ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{why ? why.title : labelFor(r.category)}</p>
          {!open && (
            why ? (
              <p className="text-[11px] text-muted-foreground leading-snug line-clamp-1">{why.reason}</p>
            ) : (
              r.description && (
                <p className="text-[11px] text-muted-foreground leading-snug line-clamp-1">{r.description}</p>
              )
            )
          )}
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">{fmtTs(r.transaction_date)}</p>
        </div>
        <p className={`text-sm font-black tabular-nums shrink-0 ${isIn ? 'text-emerald-600' : 'text-destructive'}`}>
          {isIn ? '+' : '−'}{formatUGX(Number(r.amount))}
        </p>
        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          {why && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-2.5 py-2">
              <p className="text-[11px] text-amber-800 dark:text-amber-300 leading-snug flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><span className="font-semibold">Why this was deducted: </span>{why.reason}</span>
              </p>
              {(why.phone || why.tid) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {why.phone && (
                    <span className="text-[10px] font-medium rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 px-1.5 py-0.5">Phone: {why.phone}</span>
                  )}
                  {why.tid && (
                    <span className="text-[10px] font-medium rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 px-1.5 py-0.5">Ref: {why.tid}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {timeline && (
            <div className="rounded-lg bg-muted/40 border border-border/60 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2.5 flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                Deduction timeline
                {timeline.isAutoDebit && (
                  <span className="ml-auto text-[9px] font-bold rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 normal-case tracking-normal">
                    Auto-debit
                  </span>
                )}
              </p>
              <ol className="relative space-y-3">
                {timeline.steps.map((s, i) => (
                  <li key={s.key} className="relative pl-5">
                    <span className="absolute left-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
                    {i < timeline.steps.length - 1 && (
                      <span className="absolute left-[7px] top-3 -bottom-3 w-px bg-border" />
                    )}
                    <p className="text-[11px] font-semibold text-foreground leading-snug">{s.title}</p>
                    <p className="text-[11px] text-muted-foreground leading-snug">{s.detail}</p>
                    {s.meta.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {s.meta.map((m) => (
                          <span key={m} className="text-[10px] font-medium rounded bg-muted text-foreground/80 px-1.5 py-0.5">{m}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {r.description && (
            <div className="rounded-lg bg-muted/50 border border-border/60 px-2.5 py-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-0.5">Original ledger note</p>
              <p className="text-[11px] text-foreground/90 leading-snug break-words">{r.description}</p>
            </div>
          )}

          <div className="rounded-lg bg-muted/40 border border-border/60 overflow-hidden">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground px-2.5 pt-2">Ledger fields</p>
            <dl className="divide-y divide-border/40 mt-1">
              {rawFields.filter((f) => f.value != null && f.value !== '').map((f) => (
                <div key={f.label} className="flex items-start justify-between gap-3 px-2.5 py-1.5">
                  <dt className="text-[11px] text-muted-foreground shrink-0">{f.label}</dt>
                  <dd className="text-[11px] font-medium text-foreground/90 text-right break-all">{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDetailOpen(true); }}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] font-semibold text-primary hover:bg-primary/10 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open full ledger record
          </button>

          <LedgerEntryDetailDrawer
            entryId={r.id}
            open={detailOpen}
            onOpenChange={setDetailOpen}
          />
        </div>
      )}
    </div>
  );
}

/* ── Wallet-bucket ledger statement (withdrawable / float / advance) ── */
function BucketStatement({ userId, bucket, fromDate, toDate }: { userId: string; bucket: BucketKey; fromDate: string; toDate: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['finops-user-bucket-ledger', userId, bucket, fromDate, toDate],
    staleTime: 30_000,
    queryFn: async () => {
      let query = supabase
        .from('general_ledger')
        .select('id, transaction_date, direction, category, description, amount, wallet_bucket, ledger_scope, source_table, source_id, classification, currency')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .eq('wallet_bucket', bucket)
        .order('transaction_date', { ascending: false })
        .limit(300);
      if (fromDate) query = query.gte('transaction_date', fromDate);
      if (toDate) query = query.lte('transaction_date', toDate + 'T23:59:59.999Z');
      const { data: rows, error } = await query;
      if (error) throw error;
      return (rows ?? []) as LedgerRow[];
    },
  });

  const { totalIn, totalOut } = useMemo(() => {
    let i = 0, o = 0;
    for (const r of data ?? []) {
      if (r.direction === 'cash_in') i += Number(r.amount || 0);
      else o += Number(r.amount || 0);
    }
    return { totalIn: i, totalOut: o };
  }, [data]);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading statement…
      </div>
    );
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-destructive">Could not load this statement.</div>;
  }
  const rows = data ?? [];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <ArrowDownLeft className="h-3.5 w-3.5" />
            <p className="text-[10px] font-bold uppercase tracking-wider">Money in</p>
          </div>
          <p className="text-base font-black tabular-nums mt-1 truncate">{formatUGX(totalIn)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/50 p-3">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <ArrowUpRight className="h-3.5 w-3.5" />
            <p className="text-[10px] font-bold uppercase tracking-wider">Money out</p>
          </div>
          <p className="text-base font-black tabular-nums mt-1 truncate">{formatUGX(totalOut)}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background p-8 text-center text-sm text-muted-foreground">
          No activity in this bucket yet.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-background overflow-hidden divide-y divide-border/40">
          {rows.map((r) => (
            <LedgerRowItem key={r.id} row={r} />
          ))}
        </div>
      )}
      {rows.length >= 300 && (
        <p className="text-[11px] text-muted-foreground text-center">Showing the most recent 300 entries.</p>
      )}
    </div>
  );
}

/* ── All-activity statement (every wallet bucket, chronological) ── */
const BUCKET_TONE: Record<string, string> = {
  withdrawable: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  float: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  advance: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

function AllActivityStatement({ userId, fromDate, toDate }: { userId: string; fromDate: string; toDate: string }) {
  const [query, setQuery] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['finops-user-all-ledger', userId, fromDate, toDate],
    staleTime: 30_000,
    queryFn: async () => {
      let query = supabase
        .from('general_ledger')
        .select('id, transaction_date, direction, category, description, amount, wallet_bucket, ledger_scope, source_table, source_id, classification, currency')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .order('transaction_date', { ascending: false })
        .limit(500);
      if (fromDate) query = query.gte('transaction_date', fromDate);
      if (toDate) query = query.lte('transaction_date', toDate + 'T23:59:59.999Z');
      const { data: rows, error } = await query;
      if (error) throw error;
      return (rows ?? []) as LedgerRow[];
    },
  });

  const filtered = useMemo(() => {
    const rows = data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    const qDigits = q.replace(/[^0-9]/g, '');
    return rows.filter((r) => {
      const haystack = [
        labelFor(r.category),
        r.category,
        r.description,
        r.wallet_bucket,
        r.direction,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (haystack.includes(q)) return true;
      if (qDigits && String(Math.round(Number(r.amount || 0))).includes(qDigits)) return true;
      return false;
    });
  }, [data, query]);

  const { totalIn, totalOut } = useMemo(() => {
    let i = 0, o = 0;
    for (const r of filtered) {
      if (r.direction === 'cash_in') i += Number(r.amount || 0);
      else o += Number(r.amount || 0);
    }
    return { totalIn: i, totalOut: o };
  }, [filtered]);

  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading full statement…
      </div>
    );
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-destructive">Could not load this statement.</div>;
  }
  const net = totalIn - totalOut;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter activity — reason, note or amount…"
          className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
            <ArrowDownLeft className="h-3.5 w-3.5" />
            <p className="text-[10px] font-bold uppercase tracking-wider">Money in</p>
          </div>
          <p className="text-sm font-black tabular-nums mt-1 truncate">{formatUGX(totalIn)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/50 p-3">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <ArrowUpRight className="h-3.5 w-3.5" />
            <p className="text-[10px] font-bold uppercase tracking-wider">Money out</p>
          </div>
          <p className="text-sm font-black tabular-nums mt-1 truncate">{formatUGX(totalOut)}</p>
        </div>
        <div className={`rounded-xl border p-3 ${net >= 0 ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-destructive/30 bg-destructive/5'}`}>
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Net flow</p>
          <p className={`text-sm font-black tabular-nums mt-1 truncate ${net >= 0 ? 'text-emerald-600' : 'text-destructive'}`}>
            {net >= 0 ? '+' : '−'}{formatUGX(Math.abs(net))}
          </p>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background p-8 text-center text-sm text-muted-foreground">
          {query ? 'No activity matches your search.' : 'No wallet activity yet.'}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-background overflow-hidden divide-y divide-border/40">
          {filtered.map((r) => (
            <div key={r.id} className="relative">
              {r.wallet_bucket && (
                <span className={`absolute right-10 top-3 z-10 text-[9px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${BUCKET_TONE[r.wallet_bucket] ?? 'bg-muted text-muted-foreground'}`}>
                  {r.wallet_bucket === 'withdrawable' ? 'Withdrawable' : r.wallet_bucket === 'float' ? 'Float' : r.wallet_bucket === 'advance' ? 'Advance' : r.wallet_bucket}
                </span>
              )}
              <LedgerRowItem row={r} />
            </div>
          ))}
        </div>
      )}
      {(data ?? []).length >= 500 && (
        <p className="text-[11px] text-muted-foreground text-center">Showing the most recent 500 entries.</p>
      )}
    </div>
  );
}

/* ── Landlord payout float statement ── */
function LandlordFloatStatement({ userId, funded, paidOut, balance, fromDate, toDate }: {
  userId: string; funded: number; paidOut: number; balance: number; fromDate: string; toDate: string;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['finops-user-landlord-float', userId, fromDate, toDate],
    staleTime: 30_000,
    queryFn: async () => {
      let query = supabase
        .from('agent_float_withdrawals')
        .select('id, amount, landlord_name, landlord_phone, status, mobile_money_provider, created_at, notes')
        .eq('agent_id', userId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (fromDate) query = query.gte('created_at', fromDate);
      if (toDate) query = query.lte('created_at', toDate + 'T23:59:59.999Z');
      const { data: rows, error } = await query;
      if (error) throw error;
      return rows ?? [];
    },
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Funded</p>
          <p className="text-sm font-black tabular-nums mt-1 truncate">{formatUGX(funded)}</p>
        </div>
        <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Paid out</p>
          <p className="text-sm font-black tabular-nums mt-1 truncate">{formatUGX(paidOut)}</p>
        </div>
        <div className="rounded-xl border border-[#9234EA]/30 bg-[#9234EA]/5 p-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#9234EA]">Balance</p>
          <p className="text-sm font-black tabular-nums mt-1 truncate">{formatUGX(balance)}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading payouts…
        </div>
      ) : error ? (
        <div className="py-8 text-center text-sm text-destructive">Could not load landlord payouts.</div>
      ) : (data ?? []).length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-background p-8 text-center text-sm text-muted-foreground">
          No landlord payouts yet.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-background overflow-hidden divide-y divide-border/40">
          {(data ?? []).map((r: any) => (
            <div key={r.id} className="flex items-center gap-3 p-3">
              <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 bg-[#9234EA]/10 text-[#9234EA]">
                <Landmark className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">
                  {r.landlord_name || 'Landlord'} {r.landlord_phone ? `· ${r.landlord_phone}` : ''}
                </p>
                <p className="text-[11px] text-muted-foreground capitalize">
                  {(r.status || '').replace(/_/g, ' ')}{r.mobile_money_provider ? ` · ${r.mobile_money_provider}` : ''}
                </p>
                <p className="text-[11px] text-muted-foreground/80 mt-0.5">{fmtTs(r.created_at)}</p>
              </div>
              <p className="text-sm font-black tabular-nums shrink-0 text-destructive">
                −{formatUGX(Number(r.amount))}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UserWalletStatementsPanel() {
  const [selected, setSelected] = useState<UserBrief | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const { data: summary, isLoading: summaryLoading } = useWalletSummary(selected?.id ?? null);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <Wallet className="h-6 w-6 text-primary" />
          User Wallet Statements
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Search a user and read their wallet exactly as they see it. Tap the name for the full profile.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
          <Search className="h-3 w-3" /> Find any user by name or phone
        </div>
        <UserSearchPicker
          label=""
          placeholder="Search by name or phone…"
          selectedUser={selected}
          onSelect={setSelected}
        />
      </div>

      {selected && (
        <>
          {/* Tappable name → full profile drill-down */}
          <button
            type="button"
            onClick={() => setDrillOpen(true)}
            className="w-full flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left hover:bg-accent/40 transition-colors"
          >
            <div className="h-11 w-11 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <User className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-foreground truncate">{selected.full_name || 'Unnamed user'}</p>
              <p className="text-xs text-muted-foreground">{selected.phone || '— no phone —'}</p>
              <p className="text-[11px] text-primary mt-0.5">View full profile — location, contacts, roles & portfolios</p>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
          </button>

          {/* Balance chips */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {([
              { label: 'Withdrawable', val: summary?.withdrawable ?? 0, tone: 'text-emerald-600', Icon: HandCoins },
              { label: 'Operational Float', val: summary?.float ?? 0, tone: 'text-sky-600', Icon: Banknote },
              { label: 'Landlord Float', val: summary?.landlordFloat ?? 0, tone: 'text-[#9234EA]', Icon: Landmark },
              { label: 'Advance Owed', val: summary?.advance ?? 0, tone: 'text-warning', Icon: AlertTriangle },
            ] as const).map(({ label, val, tone, Icon }) => (
              <div key={label} className="rounded-xl border border-border bg-card p-3">
                <div className={`flex items-center gap-1.5 ${tone}`}>
                  <Icon className="h-3.5 w-3.5" />
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
                </div>
                <p className="text-base font-black tabular-nums mt-1 truncate">
                  {summaryLoading ? '…' : formatUGX(val)}
                </p>
              </div>
            ))}
          </div>

          {/* Date range filter */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2 flex-1 min-w-[200px]">
              <span className="text-xs text-muted-foreground whitespace-nowrap">From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">To</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              />
            </div>
            {(fromDate || toDate) && (
              <button
                type="button"
                onClick={() => { setFromDate(''); setToDate(''); }}
                className="text-xs font-medium text-muted-foreground hover:text-foreground underline"
              >
                Clear dates
              </button>
            )}
          </div>

          {/* Statements */}
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="grid grid-cols-3 sm:grid-cols-5 w-full h-auto">
              <TabsTrigger value="all" className="text-xs py-2">All Activity</TabsTrigger>
              <TabsTrigger value="withdrawable" className="text-xs py-2">Withdrawable</TabsTrigger>
              <TabsTrigger value="float" className="text-xs py-2">Op. Float</TabsTrigger>
              <TabsTrigger value="landlord" className="text-xs py-2">Landlord Float</TabsTrigger>
              <TabsTrigger value="advance" className="text-xs py-2">Advance</TabsTrigger>
            </TabsList>
            <TabsContent value="all" className="pt-4">
              <AllActivityStatement userId={selected.id} fromDate={fromDate} toDate={toDate} />
            </TabsContent>
            <TabsContent value="withdrawable" className="pt-4">
              <BucketStatement userId={selected.id} bucket="withdrawable" fromDate={fromDate} toDate={toDate} />
            </TabsContent>
            <TabsContent value="float" className="pt-4">
              <BucketStatement userId={selected.id} bucket="float" fromDate={fromDate} toDate={toDate} />
            </TabsContent>
            <TabsContent value="landlord" className="pt-4">
              <LandlordFloatStatement
                userId={selected.id}
                funded={summary?.landlordFunded ?? 0}
                paidOut={summary?.landlordPaidOut ?? 0}
                balance={summary?.landlordFloat ?? 0}
                fromDate={fromDate}
                toDate={toDate}
              />
            </TabsContent>
            <TabsContent value="advance" className="pt-4">
              <BucketStatement userId={selected.id} bucket="advance" fromDate={fromDate} toDate={toDate} />
            </TabsContent>
          </Tabs>

          <UserProfileDrilldown
            open={drillOpen}
            onOpenChange={setDrillOpen}
            userId={selected.id}
            breadcrumbs={[
              { label: 'Wallet Statements', onClick: () => setDrillOpen(false) },
              { label: selected.full_name || 'User' },
            ]}
          />
        </>
      )}
    </div>
  );
}
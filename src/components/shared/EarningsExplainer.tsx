import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, TrendingUp, TrendingDown, Info, ChevronDown, ChevronRight } from 'lucide-react';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/rentCalculations';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';

interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

interface LedgerEntry {
  id: string;
  transaction_date: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  linked_party: string | null;
  classification: string | null;
}

const PAGE = 1000;

// Human-friendly labels + which top-level bucket each category rolls up to.
const CATEGORY_META: Record<string, { label: string; bucket: string; note?: string }> = {
  agent_commission: { label: '10% Rent Collection Commission', bucket: 'Agent Commissions', note: 'Instant 10% of every tenant rent slice the agent collected.' },
  agent_commission_earned: { label: 'Listing / Verification / Referral Bonuses', bucket: 'Agent Commissions', note: 'House listing 2k, landlord verified 2k, LC1 chairperson verified, sub-agent registration bonuses, recruiter overrides.' },
  partner_commission: { label: 'Partner Commission (2%)', bucket: 'Agent Commissions', note: '2% commission on proxy agent deposits routed to partners.' },
  tenant_placement_bonus: { label: 'Tenant Placement Bonus (10k)', bucket: 'Agent Commissions', note: 'Paid when an empty listing gets its first tenant assigned.' },
  recruiter_override: { label: 'Recruiter Override (3k)', bucket: 'Agent Commissions', note: 'Paid to the recruiting agent when a sub-agent produces a verified listing/landlord/LC1.' },
  agent_incentive_bonus: { label: 'Agent Incentive Bonus', bucket: 'Agent Commissions' },
  merchant_commission: { label: 'Merchant Cashout Commission (0.5%)', bucket: 'Agent Commissions' },
  field_deposit_commission: { label: 'Field Deposit Commission', bucket: 'Agent Commissions' },

  deposit: { label: 'Deposit', bucket: 'Money In (Deposits)', note: 'External money brought into the wallet.' },
  momo_deposit: { label: 'MoMo Deposit', bucket: 'Money In (Deposits)' },
  cash_deposit: { label: 'Cash Deposit', bucket: 'Money In (Deposits)' },
  bank_deposit: { label: 'Bank Deposit', bucket: 'Money In (Deposits)' },
  auto_credit: { label: 'Auto-Credited Deposit', bucket: 'Money In (Deposits)' },

  roi_wallet_credit: { label: 'Investor Returns (ROI)', bucket: 'Investment Returns' },
  roi_payout: { label: 'ROI Payout', bucket: 'Investment Returns' },
  roi_accrued: { label: 'ROI Accrued', bucket: 'Investment Returns' },

  payroll: { label: 'Payroll / Salary', bucket: 'Salary & Payroll' },
  payroll_growth: { label: 'Payroll Growth Interest', bucket: 'Salary & Payroll', note: '0.5% daily on un-withdrawn payroll.' },
  employee_requisition: { label: 'Employee Requisition Credit', bucket: 'Salary & Payroll' },

  wallet_transfer: { label: 'Wallet Transfer In', bucket: 'Transfers' },
  transfer_in: { label: 'Transfer In', bucket: 'Transfers' },
  portfolio_topup_refund: { label: 'Portfolio Top-up Refund', bucket: 'Transfers' },

  refund: { label: 'Refund', bucket: 'Refunds & Reversals' },
  reversal: { label: 'Reversal', bucket: 'Refunds & Reversals' },

  system_balance_correction: { label: 'System Balance Correction', bucket: 'Corrections', note: 'Admin correction — not real earnings.' },
  admin_correction: { label: 'Admin Correction', bucket: 'Corrections' },
  ledger_backfill: { label: 'Ledger Backfill', bucket: 'Corrections' },

  advance_disbursement: { label: 'Advance Disbursement', bucket: 'Advances / Credit' },
  business_advance: { label: 'Business Advance', bucket: 'Advances / Credit' },
  credit_draw: { label: 'Credit Draw', bucket: 'Advances / Credit' },
};

const humanize = (c: string) => c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

function metaFor(category: string) {
  return CATEGORY_META[category] || { label: humanize(category), bucket: 'Other' };
}

interface Props {
  /** Optional label shown at top; defaults to CFO copy. */
  role?: 'cfo' | 'finops';
}

export function EarningsExplainer({ role = 'cfo' }: Props) {
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = async (u: UserResult) => {
    setLoading(true);
    setEntries([]);
    try {
      const all: LedgerEntry[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('id, transaction_date, amount, direction, category, description, linked_party, classification')
          .eq('user_id', u.id)
          .eq('ledger_scope', 'wallet')
          .order('transaction_date', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as LedgerEntry[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setEntries(all);
    } catch (err: any) {
      console.error('[EarningsExplainer] load failed:', err);
      toast.error(err.message || 'Failed to load earnings');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (u: UserResult | null) => {
    setSelectedUser(u);
    setEntries([]);
    setExpanded({});
    if (u) load(u);
  };

  const { buckets, totalIn, totalOut, net, firstDate, lastDate } = useMemo(() => {
    const inEntries = entries.filter((e) => e.direction === 'cash_in');
    const outEntries = entries.filter((e) => e.direction === 'cash_out');

    // Group cash_in by bucket then by category.
    const byBucket: Record<string, {
      total: number;
      count: number;
      categories: Record<string, { total: number; count: number; samples: LedgerEntry[] }>;
    }> = {};

    for (const e of inEntries) {
      const m = metaFor(e.category);
      const b = (byBucket[m.bucket] ??= { total: 0, count: 0, categories: {} });
      const c = (b.categories[e.category] ??= { total: 0, count: 0, samples: [] });
      const amt = Number(e.amount) || 0;
      b.total += amt;
      b.count += 1;
      c.total += amt;
      c.count += 1;
      if (c.samples.length < 5) c.samples.push(e);
    }

    const totalIn = inEntries.reduce((s, e) => s + Number(e.amount || 0), 0);
    const totalOut = outEntries.reduce((s, e) => s + Number(e.amount || 0), 0);
    const dates = entries.map((e) => e.transaction_date).sort();
    return {
      buckets: byBucket,
      totalIn,
      totalOut,
      net: totalIn - totalOut,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
    };
  }, [entries]);

  const bucketList = Object.entries(buckets).sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">💡 How did they earn this?</h1>
        <p className="text-sm text-muted-foreground">
          {role === 'cfo'
            ? 'Search a user to see a plain-English breakdown of every UGX that landed in their wallet — grouped by source with counts, samples and totals. Answers "how did this person earn X?" without opening the raw ledger.'
            : 'Investigate why a user\'s wallet holds what it holds. Every cash-in event grouped by source with counts and samples.'}
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <UserSearchPicker
            label="Wallet Owner"
            placeholder="Search by name or phone..."
            selectedUser={selectedUser}
            onSelect={handleSelect}
          />
        </CardContent>
      </Card>

      {selectedUser && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp className="h-3 w-3 text-success" /> Lifetime Earned In</p>
              <p className="text-lg font-bold text-success">{formatUGX(totalIn)}</p>
              <p className="text-[10px] text-muted-foreground">{entries.filter((e) => e.direction === 'cash_in').length} events</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingDown className="h-3 w-3 text-destructive" /> Lifetime Paid Out</p>
              <p className="text-lg font-bold text-destructive">{formatUGX(totalOut)}</p>
              <p className="text-[10px] text-muted-foreground">{entries.filter((e) => e.direction === 'cash_out').length} events</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Net (should ≈ current wallet)</p>
              <p className={`text-lg font-bold ${net >= 0 ? 'text-success' : 'text-destructive'}`}>{formatUGX(net)}</p>
            </CardContent></Card>
            <Card><CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Activity Window</p>
              <p className="text-xs font-medium">
                {firstDate ? format(parseISO(firstDate), 'dd MMM yyyy') : '—'}
              </p>
              <p className="text-xs text-muted-foreground">
                → {lastDate ? format(parseISO(lastDate), 'dd MMM yyyy') : '—'}
              </p>
            </CardContent></Card>
          </div>

          {loading ? (
            <Card><CardContent className="py-10 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading earnings...
            </CardContent></Card>
          ) : bucketList.length === 0 ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
              No wallet credits found for this user.
            </CardContent></Card>
          ) : (
            <div className="space-y-3">
              {bucketList.map(([bucketName, bucket]) => {
                const pct = totalIn > 0 ? (bucket.total / totalIn) * 100 : 0;
                const cats = Object.entries(bucket.categories).sort((a, b) => b[1].total - a[1].total);
                return (
                  <Card key={bucketName}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{bucketName}</CardTitle>
                        <div className="text-right">
                          <div className="text-base font-bold text-success">{formatUGX(bucket.total)}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {bucket.count} events · {pct.toFixed(1)}% of earnings
                          </div>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                        <div className="h-full bg-success" style={{ width: `${Math.min(100, pct)}%` }} />
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-2">
                      {cats.map(([cat, c]) => {
                        const key = `${bucketName}::${cat}`;
                        const open = !!expanded[key];
                        const meta = metaFor(cat);
                        return (
                          <div key={cat} className="border rounded-md">
                            <button
                              onClick={() => setExpanded((s) => ({ ...s, [key]: !open }))}
                              className="w-full flex items-center justify-between gap-2 p-2 text-left hover:bg-muted/30"
                            >
                              <div className="flex items-start gap-2 min-w-0">
                                {open ? <ChevronDown className="h-4 w-4 shrink-0 mt-0.5" /> : <ChevronRight className="h-4 w-4 shrink-0 mt-0.5" />}
                                <div className="min-w-0">
                                  <div className="text-sm font-medium truncate">{meta.label}</div>
                                  <div className="flex items-center gap-1 flex-wrap mt-0.5">
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{cat}</Badge>
                                    <span className="text-[10px] text-muted-foreground">{c.count} events</span>
                                  </div>
                                </div>
                              </div>
                              <div className="text-sm font-mono font-semibold shrink-0 text-success">
                                {formatUGX(c.total)}
                              </div>
                            </button>
                            {open && (
                              <div className="px-3 pb-3 space-y-2 border-t bg-muted/10">
                                {meta.note && (
                                  <div className="flex gap-2 text-xs text-muted-foreground pt-2">
                                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                    <span>{meta.note}</span>
                                  </div>
                                )}
                                <div className="space-y-1">
                                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground pt-1">
                                    Sample events (latest {c.samples.length})
                                  </div>
                                  {c.samples.map((e) => (
                                    <div key={e.id} className="flex items-start justify-between gap-2 text-xs py-1 border-b last:border-0">
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate">{e.description || meta.label}</div>
                                        <div className="text-[10px] text-muted-foreground">
                                          {format(parseISO(e.transaction_date), 'dd MMM yyyy HH:mm')}
                                          {e.classification && e.classification !== 'production' && (
                                            <> · <Badge variant="secondary" className="text-[8px] px-1 py-0 h-3.5 align-middle">{e.classification}</Badge></>
                                          )}
                                        </div>
                                      </div>
                                      <div className="font-mono text-success shrink-0">+{formatUGX(Number(e.amount))}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default EarningsExplainer;
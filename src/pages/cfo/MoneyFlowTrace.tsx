import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, ArrowRight, ArrowDown, Wallet, Building2, Users, Banknote, Info, AlertCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

interface LedgerLeg {
  id: string;
  transaction_group_id: string | null;
  amount: number;
  direction: 'cash_in' | 'cash_out';
  category: string;
  ledger_scope: string;
  classification: string | null;
  account: string | null;
  user_id: string | null;
  description: string | null;
  reference_id: string | null;
  source_table: string | null;
  source_id: string | null;
  transaction_date: string;
}

const BUCKET_FOR_CATEGORY: Record<string, { bucket: string; sign: '+' | '-' }> = {
  // Cash in → wallet
  wallet_deposit: { bucket: 'withdrawable_balance', sign: '+' },
  agent_commission_earned: { bucket: 'withdrawable_balance', sign: '+' },
  agent_float_deposit: { bucket: 'float_balance', sign: '+' },
  partner_commission: { bucket: 'withdrawable_balance', sign: '+' },
  roi_wallet_credit: { bucket: 'withdrawable_balance', sign: '+' },
  pending_portfolio_topup: { bucket: 'withdrawable_balance', sign: '+' },
  agent_advance_credit: { bucket: 'advance_balance', sign: '+' },
  // Cash out → wallet
  wallet_withdrawal: { bucket: 'withdrawable_balance', sign: '-' },
  agent_commission_withdrawal: { bucket: 'withdrawable_balance', sign: '-' },
  agent_float_used_for_rent: { bucket: 'float_balance', sign: '-' },
  agent_commission_used_for_rent: { bucket: 'withdrawable_balance', sign: '-' },
  wallet_deduction: { bucket: 'withdrawable_balance', sign: '-' },
  rent_disbursement: { bucket: 'float_balance', sign: '-' },
  debt_recovery: { bucket: 'withdrawable_balance', sign: '-' },
};

function explainCategory(cat: string): string {
  return ({
    wallet_deposit: 'User top-up via Mobile Money / bank / cash agent',
    partner_commission: '2% proxy-agent commission on a partner deposit',
    agent_commission_earned: 'Agent commission credit for verified collection',
    agent_float_deposit: 'Operational float credited to agent for rent payouts',
    rent_disbursement: 'Rent paid out to landlord using agent float',
    agent_commission_withdrawal: 'Agent withdrawing earned commission to mobile money',
    wallet_withdrawal: 'User withdrawing wallet balance to mobile money',
    pending_portfolio_topup: 'Portfolio top-up parked into supporter wallet',
    roi_wallet_credit: 'ROI returns credited into supporter wallet',
    agent_advance_credit: 'Agent cash advance credited to advance bucket',
    debt_recovery: 'Recovery of unauthorized payout from wallet balance',
    wallet_deduction: 'Direct deduction from wallet (admin or system)',
    agent_float_used_for_rent: 'Float consumed when paying landlord',
    agent_commission_used_for_rent: 'Commission converted into rent payment',
  } as Record<string, string>)[cat] ?? 'Standard ledger movement';
}

function scopeIcon(scope: string) {
  if (scope === 'wallet') return <Wallet className="h-3.5 w-3.5" />;
  if (scope === 'platform') return <Building2 className="h-3.5 w-3.5" />;
  return <Users className="h-3.5 w-3.5" />;
}

export default function MoneyFlowTrace() {
  const [params, setParams] = useSearchParams();
  const initialQuery = params.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery);

  useEffect(() => { setQuery(initialQuery); setSubmitted(initialQuery); }, [initialQuery]);

  const trace = useQuery({
    queryKey: ['money-flow-trace', submitted],
    enabled: submitted.length > 8,
    queryFn: async () => {
      // Find a seed leg by id, transaction_group_id, source_id, or reference_id
      const isUuid = /^[0-9a-f-]{36}$/i.test(submitted);
      let seed: LedgerLeg | null = null;

      if (isUuid) {
        const tries = await Promise.all([
          supabase.from('general_ledger').select('*').eq('id', submitted).maybeSingle(),
          supabase.from('general_ledger').select('*').eq('transaction_group_id', submitted).limit(1).maybeSingle(),
          supabase.from('general_ledger').select('*').eq('source_id', submitted).limit(1).maybeSingle(),
        ]);
        seed = (tries.find((r) => r.data)?.data as LedgerLeg) ?? null;
      }
      if (!seed) {
        const { data } = await supabase
          .from('general_ledger')
          .select('*')
          .eq('reference_id', submitted)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        seed = (data as LedgerLeg) ?? null;
      }
      if (!seed) return null;

      // Pull every leg in the same transaction group
      const groupId = seed.transaction_group_id;
      let legs: LedgerLeg[] = [seed];
      if (groupId) {
        const { data } = await supabase
          .from('general_ledger')
          .select('*')
          .eq('transaction_group_id', groupId)
          .order('created_at', { ascending: true });
        legs = (data as LedgerLeg[]) ?? [seed];
      }

      // Resolve user names
      const userIds = [...new Set(legs.map((l) => l.user_id).filter(Boolean))] as string[];
      const profileMap = new Map<string, { full_name: string | null; phone: string | null }>();
      if (userIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', userIds);
        (profiles ?? []).forEach((p) => profileMap.set(p.id, p));
      }

      return { seed, legs, profileMap, groupId };
    },
  });

  const grouped = useMemo(() => {
    if (!trace.data) return null;
    const cashIn = trace.data.legs.filter((l) => l.direction === 'cash_in');
    const cashOut = trace.data.legs.filter((l) => l.direction === 'cash_out');
    const totalIn = cashIn.reduce((s, l) => s + Number(l.amount), 0);
    const totalOut = cashOut.reduce((s, l) => s + Number(l.amount), 0);
    return { cashIn, cashOut, totalIn, totalOut, balanced: Math.abs(totalIn - totalOut) < 0.01 };
  }, [trace.data]);

  const onSearch = () => {
    const trimmed = query.trim();
    setSubmitted(trimmed);
    setParams(trimmed ? { q: trimmed } : {});
  };

  return (
    <div className="container max-w-6xl mx-auto p-4 space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Banknote className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold">Money Flow Trace</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Paste a transaction id, transaction group id, source id, or reference id to see exactly where the money came from
          (debit) and where it went (credit) — across both the ledger and the wallet bucket fields.
        </p>
        <div className="text-[11px]">
          <Link to="/cfo/dashboard" className="text-primary hover:underline">← Back to CFO Dashboard</Link>
        </div>
      </header>

      <Card>
        <CardContent className="p-4 flex flex-col sm:flex-row gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            placeholder="Paste transaction id / group id / source id / reference id"
            className="font-mono text-xs"
          />
          <Button onClick={onSearch} disabled={query.trim().length < 8}>
            <Search className="h-4 w-4 mr-2" /> Trace
          </Button>
        </CardContent>
      </Card>

      {trace.isFetching && (
        <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
      )}

      {!trace.isFetching && submitted && !trace.data && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <AlertCircle className="h-6 w-6 mx-auto mb-2 text-orange-500" />
            No ledger entries found for that identifier. Try the transaction group id from the source row.
          </CardContent>
        </Card>
      )}

      {trace.data && grouped && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Transaction Overview</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <Stat label="Group ID" value={trace.data.groupId ?? '—'} mono />
              <Stat label="Date" value={new Date(trace.data.seed.transaction_date).toLocaleString()} />
              <Stat label="Total Debited (cash_out)" value={formatUGX(grouped.totalOut)} tone="warn" />
              <Stat
                label={grouped.balanced ? 'Total Credited (balanced ✓)' : 'Total Credited (UNBALANCED ⚠)'}
                value={formatUGX(grouped.totalIn)}
                tone={grouped.balanced ? 'ok' : 'danger'}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowDown className="h-4 w-4 text-orange-500" /> Where the money was DEBITED FROM
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Each row shows a source account that lost value (cash_out leg).
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {grouped.cashOut.length === 0 && (
                <div className="text-xs text-muted-foreground py-4">No cash_out legs found in this group.</div>
              )}
              {grouped.cashOut.map((leg) => (
                <LegRow key={leg.id} leg={leg} profileMap={trace.data.profileMap} side="debit" />
              ))}
            </CardContent>
          </Card>

          <div className="flex justify-center">
            <ArrowRight className="h-6 w-6 text-muted-foreground rotate-90" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ArrowDown className="h-4 w-4 text-emerald-500 rotate-180" /> Where the money was CREDITED TO
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Each row shows a destination account that gained value (cash_in leg) and which wallet bucket the router updated.
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              {grouped.cashIn.length === 0 && (
                <div className="text-xs text-muted-foreground py-4">No cash_in legs found in this group.</div>
              )}
              {grouped.cashIn.map((leg) => (
                <LegRow key={leg.id} leg={leg} profileMap={trace.data.profileMap} side="credit" />
              ))}
            </CardContent>
          </Card>

          <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Info className="h-4 w-4 text-blue-600" /> Plain-English Narration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {grouped.cashOut.map((d) => {
                const credit = grouped.cashIn[0];
                const dName = d.user_id ? trace.data.profileMap.get(d.user_id)?.full_name ?? d.user_id.slice(0, 8) : (d.account ?? d.ledger_scope);
                const cName = credit?.user_id ? trace.data.profileMap.get(credit.user_id)?.full_name ?? credit.user_id.slice(0, 8) : (credit?.account ?? credit?.ledger_scope ?? '?');
                const bucket = BUCKET_FOR_CATEGORY[credit?.category ?? '']?.bucket;
                return (
                  <p key={d.id}>
                    <strong>{formatUGX(Number(d.amount))}</strong> was deducted from{' '}
                    <Badge variant="outline" className="mx-1">{d.ledger_scope}: {dName}</Badge>
                    ({explainCategory(d.category)}) and credited to{' '}
                    <Badge variant="outline" className="mx-1">{credit?.ledger_scope}: {cName}</Badge>
                    {bucket && (
                      <>
                        {' '}— specifically into the <Badge className="mx-1" variant="secondary">{bucket}</Badge> bucket.
                      </>
                    )}
                  </p>
                );
              })}
              {!grouped.balanced && (
                <p className="text-red-700 font-medium">
                  ⚠ This transaction is unbalanced. Cash_in and cash_out totals do not match — investigate immediately.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone, mono }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger'; mono?: boolean }) {
  const toneCls =
    tone === 'danger' ? 'border-red-500/30 bg-red-500/10 text-red-700' :
    tone === 'warn' ? 'border-orange-500/30 bg-orange-500/10 text-orange-700' :
    tone === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' :
    'border-border bg-muted/30';
  return (
    <div className={cn('rounded-lg border px-3 py-2', toneCls)}>
      <div className="text-[10px] uppercase tracking-wider opacity-80">{label}</div>
      <div className={cn('text-sm font-semibold tabular-nums break-all', mono && 'font-mono text-[11px]')}>{value}</div>
    </div>
  );
}

function LegRow({
  leg,
  profileMap,
  side,
}: {
  leg: LedgerLeg;
  profileMap: Map<string, { full_name: string | null; phone: string | null }>;
  side: 'debit' | 'credit';
}) {
  const owner =
    leg.user_id ? profileMap.get(leg.user_id)?.full_name ?? leg.user_id.slice(0, 8) : leg.account ?? leg.ledger_scope;
  const bucketInfo = BUCKET_FOR_CATEGORY[leg.category];
  const isWallet = leg.ledger_scope === 'wallet';
  return (
    <div
      className={cn(
        'rounded-lg border p-3 grid grid-cols-1 md:grid-cols-12 gap-2 items-center text-xs',
        side === 'debit' ? 'border-orange-500/30 bg-orange-500/5' : 'border-emerald-500/30 bg-emerald-500/5',
      )}
    >
      <div className="md:col-span-3 flex items-center gap-2">
        {scopeIcon(leg.ledger_scope)}
        <div>
          <div className="font-medium">{owner}</div>
          <div className="text-muted-foreground text-[10px] uppercase">{leg.ledger_scope}</div>
        </div>
      </div>
      <div className="md:col-span-3">
        <div className="text-[10px] uppercase text-muted-foreground">Category</div>
        <div className="font-mono text-[11px]">{leg.category}</div>
        <div className="text-muted-foreground text-[10px]">{explainCategory(leg.category)}</div>
      </div>
      <div className="md:col-span-3">
        <div className="text-[10px] uppercase text-muted-foreground">Wallet Bucket Effect</div>
        {isWallet && bucketInfo ? (
          <div className="font-mono text-[11px]">
            <span className={cn('font-bold mr-1', bucketInfo.sign === '+' ? 'text-emerald-700' : 'text-orange-700')}>
              {bucketInfo.sign}
            </span>
            {bucketInfo.bucket}
          </div>
        ) : isWallet ? (
          <div className="text-muted-foreground text-[10px]">No bucket mapping (legacy / system)</div>
        ) : (
          <div className="text-muted-foreground text-[10px]">Platform-side leg (no wallet bucket)</div>
        )}
      </div>
      <div className="md:col-span-3 text-right">
        <div className="text-[10px] uppercase text-muted-foreground">Amount</div>
        <div
          className={cn(
            'tabular-nums font-bold text-sm',
            side === 'debit' ? 'text-orange-700' : 'text-emerald-700',
          )}
        >
          {side === 'debit' ? '−' : '+'} {formatUGX(Number(leg.amount))}
        </div>
        <div className="text-muted-foreground text-[10px]">{leg.classification ?? 'production'}</div>
      </div>
      {(leg.description || leg.reference_id || leg.source_table) && (
        <div className="md:col-span-12 border-t border-border/50 pt-2 mt-1 text-[11px] text-muted-foreground space-y-0.5">
          {leg.description && <div>{leg.description}</div>}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10px]">
            {leg.source_table && <span>source_table: {leg.source_table}</span>}
            {leg.source_id && <span>source_id: {leg.source_id.slice(0, 8)}…</span>}
            {leg.reference_id && <span>reference_id: {leg.reference_id}</span>}
            {leg.account && <span>account: {leg.account}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

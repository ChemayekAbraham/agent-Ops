import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { ContactActions } from '@/components/ops/ContactActions';
import { LendingAgentsPanel } from '@/components/executive/LendingAgentsPanel';
import { Banknote, TrendingUp, TrendingDown, Percent, MessageSquare, Wallet, AlertTriangle, Info } from 'lucide-react';

/**
 * Cost assumptions — kept visible in the UI so ops can sanity-check the economics.
 * These are unit costs the company actually pays when an agent lends through the
 * Welile wallet; they are NOT stored as ledger rows.
 */
const SMS_UNIT_COST_UGX = 32; // per notification (disbursement + each auto-deduction)
const CASHOUT_COST_PCT = 1.0; // mobile-money cash-out cost on money that leaves the wallet

type LoanRow = {
  id: string;
  lender_agent_id: string;
  borrower_display_name: string | null;
  borrower_phone: string | null;
  principal_ugx: number;
  interest_rate_pct: number | null;
  amount_repaid_ugx: number;
  platform_fee_ugx: number;
  auto_deduct_attempts: number | null;
  status: string;
  created_at: string;
};

export function WelileLendingBusinessPanel() {
  const { data: loans = [], isLoading } = useQuery({
    queryKey: ['lending-business-loans'],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from('lending_agent_loans')
        .select(
          'id, lender_agent_id, borrower_display_name, borrower_phone, principal_ugx, interest_rate_pct, amount_repaid_ugx, platform_fee_ugx, auto_deduct_attempts, status, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(3000);
      if (error) throw error;
      return (data || []) as LoanRow[];
    },
    staleTime: 60_000,
  });

  const econ = useMemo(() => {
    const n = (v: unknown) => Number(v || 0);
    const disbursed = loans.reduce((s, l) => s + n(l.principal_ugx), 0);
    const repaid = loans.reduce((s, l) => s + n(l.amount_repaid_ugx), 0);
    const outstanding = loans.reduce(
      (s, l) =>
        l.status === 'active' || l.status === 'partially_repaid'
          ? s + Math.max(0, n(l.principal_ugx) - n(l.amount_repaid_ugx))
          : s,
      0,
    );
    const badPrincipal = loans
      .filter((l) => l.status === 'defaulted' || l.status === 'written_off')
      .reduce((s, l) => s + Math.max(0, n(l.principal_ugx) - n(l.amount_repaid_ugx)), 0);

    // Revenue the company keeps
    const platformFees = loans.reduce((s, l) => s + n(l.platform_fee_ugx), 0);

    // Cost the company incurs to let agents lend through the wallet
    const smsCount = loans.length + loans.reduce((s, l) => s + n(l.auto_deduct_attempts), 0);
    const smsCost = smsCount * SMS_UNIT_COST_UGX;
    const cashoutCost = (disbursed * CASHOUT_COST_PCT) / 100;
    const totalCost = smsCost + cashoutCost;
    const netMargin = platformFees - totalCost;
    const takeRatePct = disbursed > 0 ? (platformFees / disbursed) * 100 : 0;

    const interestEarnedByLenders = loans.reduce(
      (s, l) => s + (n(l.principal_ugx) * n(l.interest_rate_pct)) / 100,
      0,
    );

    return {
      disbursed,
      repaid,
      outstanding,
      badPrincipal,
      platformFees,
      smsCount,
      smsCost,
      cashoutCost,
      totalCost,
      netMargin,
      takeRatePct,
      interestEarnedByLenders,
      loanCount: loans.length,
    };
  }, [loans]);

  return (
    <div className="space-y-5">
      {/* Business model summary */}
      <Card className="border-violet-200 bg-violet-50/50 dark:bg-violet-950/20 dark:border-violet-900">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-violet-600" />
            <p className="text-sm font-bold">How the Welile Lending Agent model works</p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            A vetted agent signs the Lending Agent Agreement, then lends their own withdrawable wallet
            money to any Welile user. Welile moves the money wallet-to-wallet, sends the borrower the
            schedule by SMS, and auto-deducts repayments back into the lender&apos;s wallet. The lender
            keeps the interest; Welile keeps a 1% platform fee and carries the rails cost (SMS plus
            mobile-money cash-out when the money finally leaves the wallet). Loan default risk sits with
            the lending agent, not with the company.
          </p>
        </CardContent>
      </Card>

      {/* Revenue vs cost */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Metric
          label="Platform revenue"
          value={formatUGX(econ.platformFees)}
          hint={`${econ.takeRatePct.toFixed(2)}% effective take rate`}
          icon={TrendingUp}
          tone="emerald"
        />
        <Metric
          label="Company cost"
          value={formatUGX(econ.totalCost)}
          hint="SMS + cash-out rails"
          icon={TrendingDown}
          tone="rose"
        />
        <Metric
          label="Net margin"
          value={formatUGX(econ.netMargin)}
          hint={econ.netMargin >= 0 ? 'Profitable' : 'Subsidised'}
          icon={Percent}
          tone={econ.netMargin >= 0 ? 'emerald' : 'rose'}
        />
        <Metric
          label="Lender interest earned"
          value={formatUGX(econ.interestEarnedByLenders)}
          hint="Paid to agents, not company"
          icon={Banknote}
          tone="violet"
        />
      </div>

      {/* Cost breakdown */}
      <Card>
        <CardContent className="p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
            Cost of allowing agents to lend via the Welile wallet
          </p>
          <div className="space-y-2">
            <CostRow
              icon={MessageSquare}
              label="Borrower SMS notifications"
              detail={`${econ.smsCount} messages × ${formatUGX(SMS_UNIT_COST_UGX)}`}
              amount={econ.smsCost}
            />
            <CostRow
              icon={Wallet}
              label="Mobile-money cash-out on lent funds"
              detail={`${CASHOUT_COST_PCT}% of ${formatUGX(econ.disbursed)} disbursed`}
              amount={econ.cashoutCost}
            />
            <CostRow
              icon={AlertTriangle}
              label="Defaulted principal (carried by lending agents)"
              detail="Excluded from company cost — lender bears the loss"
              amount={econ.badPrincipal}
              muted
            />
            <div className="flex items-center justify-between pt-2 border-t">
              <p className="text-sm font-bold">Total company cost</p>
              <p className="text-sm font-bold text-rose-600">{formatUGX(econ.totalCost)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Book */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Metric label="Loans written" value={String(econ.loanCount)} icon={Banknote} tone="slate" />
        <Metric label="Disbursed all-time" value={formatUGX(econ.disbursed)} icon={TrendingUp} tone="slate" />
        <Metric label="Repaid" value={formatUGX(econ.repaid)} icon={TrendingUp} tone="emerald" />
        <Metric label="Outstanding" value={formatUGX(econ.outstanding)} icon={AlertTriangle} tone="amber" />
      </div>

      {/* Contactable lending agents */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-bold">Lending agents</p>
          {isLoading && <Badge variant="muted" size="sm">Loading…</Badge>}
        </div>
        <LendingAgentsPanel />
      </div>

      {/* Recent loans with borrower contact */}
      <Card>
        <CardContent className="p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">
            Recent loans — borrower contact
          </p>
          {loans.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">No lending activity yet.</p>
          )}
          <div className="divide-y">
            {loans.slice(0, 25).map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{l.borrower_display_name || 'Borrower'}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatUGX(Number(l.principal_ugx))} · {l.status.replace(/_/g, ' ')}
                    {l.interest_rate_pct ? ` · ${l.interest_rate_pct}% interest` : ''}
                  </p>
                </div>
                <ContactActions phone={l.borrower_phone} size="xs" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

const TONES: Record<string, string> = {
  emerald: 'text-emerald-600',
  rose: 'text-rose-600',
  violet: 'text-violet-600',
  amber: 'text-amber-600',
  slate: 'text-foreground',
};

function Metric({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'slate',
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ElementType;
  tone?: keyof typeof TONES | string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5 mb-1">
          <Icon className={`h-3.5 w-3.5 ${TONES[tone] ?? TONES.slate}`} />
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{label}</p>
        </div>
        <p className={`text-lg font-bold leading-none ${TONES[tone] ?? TONES.slate}`}>{value}</p>
        {hint && <p className="text-[11px] text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function CostRow({
  icon: Icon,
  label,
  detail,
  amount,
  muted,
}: {
  icon: React.ElementType;
  label: string;
  detail: string;
  amount: number;
  muted?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${muted ? 'text-muted-foreground' : 'text-rose-600'}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-[11px] text-muted-foreground">{detail}</p>
        </div>
      </div>
      <p className={`text-sm font-semibold shrink-0 ${muted ? 'text-muted-foreground' : ''}`}>
        {formatUGX(amount)}
      </p>
    </div>
  );
}

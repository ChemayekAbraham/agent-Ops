import { useState } from 'react';
import { ChevronDown, ChevronUp, ScrollText } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import type { TrustProfile } from '@/hooks/useTrustProfile';

interface Props {
  profile: TrustProfile;
}

/**
 * Audit log showing how each Welile-vouch component was computed:
 * the input signals, the formula used, and the resulting UGX contribution.
 * Mirrors the `compute welile vouch` block inside
 * `public.get_user_trust_profile`.
 */
export function VouchAuditLog({ profile }: Props) {
  const [open, setOpen] = useState(false);
  const vb = profile.trust.vouch_breakdown;
  if (!vb) return null;

  const portfolio = profile.supporter_activity?.portfolio_value ?? 0;
  const shares = profile.supporter_activity?.angel_shares_ugx ?? vb.angel_shares_ugx;
  const b = profile.trust.breakdown;
  const agentTerm = profile.agent_performance?.agent_term ?? 0;
  const monthlyCashflow = profile.cash_flow_capacity?.monthly_avg ?? 0;
  const totalRepaid = profile.payment_history?.total_repaid ?? 0;

  const rows: Array<{
    label: string;
    inputs: string;
    formula: string;
    result: number;
    primary?: boolean;
  }> = [
    {
      label: 'Partnership portfolio (primary)',
      inputs: `Portfolio value = ${formatUGX(portfolio)}`,
      formula: '1× portfolio value',
      result: vb.portfolio_component_ugx,
      primary: true,
    },
    {
      label: 'Welile shares',
      inputs: `Angel-pool shares = ${formatUGX(shares)}`,
      formula: '2× shares value',
      result: vb.shares_component_ugx,
      primary: true,
    },
    {
      label: 'Wallet activity',
      inputs: `Wallet score = ${(b.wallet ?? 0).toFixed(1)} / 10`,
      formula: 'min(200,000, score × 20,000)',
      result: vb.booster_breakdown.wallet_activity,
    },
    {
      label: 'Network contribution',
      inputs: `Network score = ${(b.network ?? 0).toFixed(1)} / 15`,
      formula: 'min(150,000, score × 10,000)',
      result: vb.booster_breakdown.network_contribution,
    },
    {
      label: 'Agent performance',
      inputs: `Agent-perf score = ${(b.agent_performance ?? 0).toFixed(1)} / 10, agent term = ${formatUGX(agentTerm)}`,
      formula: 'min(500,000, score × 25,000) + agent term (40% of healthy monthly book)',
      result: vb.booster_breakdown.agent_performance,
    },
    {
      label: 'Verification',
      inputs: `Verification score = ${(b.verification ?? 0).toFixed(1)} / 10`,
      formula: 'min(100,000, score × 10,000)',
      result: vb.booster_breakdown.verification,
    },
    {
      label: 'Movement behaviour',
      inputs: `Behaviour score = ${(b.behavior ?? 0).toFixed(1)} / 5`,
      formula: 'min(75,000, score × 15,000)',
      result: vb.booster_breakdown.movement_behavior,
    },
    {
      label: 'Payment history',
      inputs: `Total repaid = ${formatUGX(totalRepaid)}, monthly cash flow = ${formatUGX(monthlyCashflow)}`,
      formula: '(0.30 × total repaid) + (0.25 × monthly cash flow)',
      result: vb.booster_breakdown.payment_history,
    },
  ];

  return (
    <Card className="border-border/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ScrollText className="h-4 w-4 text-emerald-600 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold leading-tight">Vouch audit log</p>
            <p className="text-[11px] text-muted-foreground leading-tight">
              How each component of your Welile vouch was calculated
            </p>
          </div>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {open && (
        <CardContent className="pt-0 pb-4 space-y-2">
          <div className="rounded-md border border-border/60 divide-y divide-border/60">
            {rows.map((row) => (
              <div key={row.label} className="p-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className={`text-[12px] ${row.primary ? 'font-bold text-foreground' : 'font-semibold text-foreground/90'}`}
                  >
                    {row.label}
                    {row.primary && (
                      <span className="ml-2 rounded-sm bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-bold">
                        Primary
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-[12px] tabular-nums ${row.result > 0 ? 'font-bold text-emerald-700 dark:text-emerald-400' : 'font-semibold text-muted-foreground'}`}
                  >
                    +{formatUGX(row.result)}
                  </span>
                </div>
                <p className="text-[10.5px] text-muted-foreground leading-snug">
                  <span className="font-semibold text-foreground/70">Inputs:</span> {row.inputs}
                </p>
                <p className="text-[10.5px] text-muted-foreground leading-snug">
                  <span className="font-semibold text-foreground/70">Formula:</span> {row.formula}
                </p>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[12px] font-bold">Total Welile vouch</span>
            <span className="text-[13px] font-black tabular-nums text-emerald-700 dark:text-emerald-400">
              {formatUGX(vb.total_ugx)}
            </span>
          </div>

          <p className="text-[10px] text-muted-foreground leading-snug pt-1">
            Source: `public.get_user_trust_profile` — snapshot generated {new Date(profile.generated_at).toLocaleString()}.
          </p>
        </CardContent>
      )}
    </Card>
  );
}

export default VouchAuditLog;
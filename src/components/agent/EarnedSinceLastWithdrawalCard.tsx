import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { Sparkles, ArrowDownToLine } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

const EARN_CATEGORIES = [
  'agent_commission_earned',
  'agent_commission',
  'agent_bonus',
  'partner_commission',
  'referral_bonus',
  'proxy_investment_commission',
];

/**
 * Shows commission strictly earned since the agent's most recent
 * wallet_withdrawal entry. Excludes phantom back-fill / opening-equity
 * reconciliation rows so the figure reflects real new earnings only.
 */
export function EarnedSinceLastWithdrawalCard() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['earned-since-last-withdrawal', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async () => {
      if (!user?.id) {
        return { earned: 0, count: 0, since: null as string | null, lastAmount: 0 };
      }

      // Most recent wallet_withdrawal for this agent
      const { data: lastWd } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('created_at, amount, classification, category, source_table, description, reference_id')
        .eq('user_id', user.id)
        .eq('ledger_scope', 'wallet')
        .eq('category', 'wallet_withdrawal')
        .eq('direction', 'cash_out'))
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!lastWd) {
        return { earned: 0, count: 0, since: null as string | null, lastAmount: 0 };
      }

      // Commission/earning credits strictly after that withdrawal
      const { data: rows } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('amount, description, created_at, classification, category, source_table, reference_id')
        .eq('user_id', user.id)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .in('category', EARN_CATEGORIES)
        .gt('created_at', lastWd.created_at));

      // Exclude reconciliation / back-fill / opening-equity entries
      const real = (rows || []).filter(isCustomerWalletLedgerEntryVisible).filter((r: any) => {
        const d = (r.description || '').toLowerCase();
        return !d.includes('phantom') && !d.includes('back-fill') && !d.includes('backfill') && !d.includes('opening equity');
      });

      const earned = real.reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
      return {
        earned,
        count: real.length,
        since: lastWd.created_at as string,
        lastAmount: Number(lastWd.amount || 0),
      };
    },
  });

  if (isLoading || !data) return null;

  return (
    <Card className="overflow-hidden border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-card to-card">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-600">
            <Sparkles className="h-4 w-4" strokeWidth={2.4} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
              Earned since last withdrawal
            </p>
            <p className="text-2xl font-black leading-tight mt-0.5 text-foreground">
              {formatUGX(data.earned)}
            </p>
            <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground flex-wrap">
              <ArrowDownToLine className="h-3 w-3" />
              {data.since ? (
                <span>
                  Since {formatUGX(data.lastAmount)} withdrawal · {formatDistanceToNow(new Date(data.since), { addSuffix: true })}
                </span>
              ) : (
                <span>No withdrawals yet — showing all-time real earnings</span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground/80 mt-1">
              {data.count} commission entr{data.count === 1 ? 'y' : 'ies'} · excludes reconciliation back-fills
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default EarnedSinceLastWithdrawalCard;
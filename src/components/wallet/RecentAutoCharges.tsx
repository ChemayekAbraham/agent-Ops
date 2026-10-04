import { useState, useEffect } from 'react';

import { ArrowDownRight, ChevronDown, ChevronUp } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

interface ChargeEntry {
  id: string;
  amount: number;
  category: string;
  description: string | null;
  transaction_date: string;
  classification?: string | null;
  source_table?: string | null;
  reference_id?: string | null;
}

const categoryLabel = (category: string): string => {
  const map: Record<string, string> = {
    rent_repayment: 'Rent Auto-Charge',
    auto_charge: 'Auto-Deduction',
    agent_commission_payout: 'Commission Payout',
    wallet_withdrawal: 'Withdrawal',
    subscription_charge: 'Subscription',
  };
  return map[category] || category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

const timeAgo = (dateStr: string) => {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

export function RecentAutoCharges() {
  const { user } = useAuth();
  const [charges, setCharges] = useState<ChargeEntry[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!user) return;

    const fetchCharges = async () => {
      const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const { data } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('id, amount, category, description, transaction_date, classification, source_table, reference_id')
        .eq('user_id', user.id)
        .eq('direction', 'cash_out')
        .gte('transaction_date', since))
        .order('transaction_date', { ascending: false })
        .limit(5);

      if (data && data.length > 0) {
        setCharges(data.filter(isCustomerWalletLedgerEntryVisible));
      }
    };

    fetchCharges();
  }, [user]);

  if (charges.length === 0) return null;

  const totalDeducted = charges.reduce((sum, c) => sum + c.amount, 0);
  const latestCharge = charges[0];

  return (
    <div className="mt-2 w-full" onClick={(e) => e.stopPropagation()}>
      {/* Summary line - always visible */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-destructive/10 border border-destructive/20 text-left touch-manipulation"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <ArrowDownRight className="h-3 w-3 text-destructive shrink-0" />
          <span className="text-[10px] text-destructive font-semibold truncate">
            -{formatUGX(totalDeducted)} deducted ({charges.length} txn{charges.length > 1 ? 's' : ''})
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[9px] text-muted-foreground">{timeAgo(latestCharge.transaction_date)}</span>
          {expanded ? (
            <ChevronUp className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="overflow-hidden animate-fade-in">
          <div className="mt-1.5 space-y-1 px-1">
            {charges.map((charge) => (
              <div
                key={charge.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold text-foreground truncate">
                    {categoryLabel(charge.category)}
                  </p>
                  {charge.description && (
                    <p className="text-[9px] text-muted-foreground truncate">{charge.description}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[10px] font-bold text-destructive tabular-nums">
                    -{formatUGX(charge.amount)}
                  </p>
                  <p className="text-[8px] text-muted-foreground">{timeAgo(charge.transaction_date)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

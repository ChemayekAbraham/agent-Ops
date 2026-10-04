import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { HandCoins, ArrowUpRight, ArrowDownLeft, TrendingUp, History } from 'lucide-react';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';

interface ProxyTransaction {
  id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  transaction_date: string;
  classification?: string | null;
  source_table?: string | null;
}

interface ProxyInvestmentHistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProxyInvestmentHistorySheet({ open, onOpenChange }: ProxyInvestmentHistorySheetProps) {
  const [transactions, setTransactions] = useState<ProxyTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    fetchHistory();
  }, [open]);

  const fetchHistory = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data, error } = await applyCustomerWalletLedgerFilters(supabase
        .from('general_ledger')
        .select('id, amount, direction, category, description, reference_id, linked_party, transaction_date, classification, source_table')
        .eq('user_id', user.id)
        .in('category', ['agent_proxy_investment', 'proxy_investment_commission', 'angel_pool_commission']))
        .order('transaction_date', { ascending: false })
        .limit(50);

      if (error) throw error;
      setTransactions((data || []).filter(isCustomerWalletLedgerEntryVisible));
    } catch (err) {
      console.error('Error fetching proxy investment history:', err);
    } finally {
      setLoading(false);
    }
  };

  const totalInvested = transactions
    .filter(t => t.category === 'agent_proxy_investment')
    .reduce((sum, t) => sum + t.amount, 0);

  const totalCommission = transactions
    .filter(t => t.category === 'proxy_investment_commission' || t.category === 'angel_pool_commission')
    .reduce((sum, t) => sum + t.amount, 0);

  const investmentCount = transactions.filter(t => t.category === 'agent_proxy_investment').length;

  // Extract partner name from description
  const extractPartner = (desc: string | null) => {
    if (!desc) return 'Partner';
    const match = desc.match(/(?:on behalf of|for)\s+(.+?)(?:'s|\.|$)/i);
    return match?.[1]?.trim() || 'Partner';
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-2xl p-0">
        <SheetHeader className="p-4 pb-3 border-b border-border">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <HandCoins className="h-5 w-5 text-emerald-500" />
            Proxy Funding History
          </SheetTitle>
        </SheetHeader>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-2 p-4 pb-2">
          <div className="rounded-xl bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">Funded</p>
            <p className="text-sm font-bold text-destructive">{formatUGX(totalInvested)}</p>
          </div>
          <div className="rounded-xl bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">Earned</p>
            <p className="text-sm font-bold text-success">{formatUGX(totalCommission)}</p>
          </div>
          <div className="rounded-xl bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">Count</p>
            <p className="text-sm font-bold">{investmentCount}</p>
          </div>
        </div>

        <ScrollArea className="flex-1 h-[calc(90vh-180px)]">
          <div className="p-4 pt-2 space-y-2">
            {loading ? (
              [1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl" />)
            ) : transactions.length === 0 ? (
              <div className="text-center py-12">
                <History className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-sm text-muted-foreground">No proxy funding yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Use "Fund Partner" to get started
                </p>
              </div>
            ) : (
              transactions.map(tx => {
                const isInvestment = tx.category === 'agent_proxy_investment';
                const isAngelCommission = tx.category === 'angel_pool_commission';
                const partner = extractPartner(tx.description);

                return (
                  <div
                    key={tx.id}
                    className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <div className={`p-2 rounded-lg ${isInvestment ? 'bg-destructive/10' : 'bg-success/10'}`}>
                      {isInvestment ? (
                        <ArrowUpRight className="h-4 w-4 text-destructive" />
                      ) : (
                        <TrendingUp className="h-4 w-4 text-success" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">
                          {isInvestment ? `Funded for ${partner}` : isAngelCommission ? '1% Angel Commission' : '2% Commission'}
                        </p>
                        <Badge variant="outline" className="text-[10px] px-1.5 shrink-0">
                          {isInvestment ? 'Funding' : 'Earned'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {tx.reference_id} • {format(new Date(tx.transaction_date), 'MMM d, yyyy HH:mm')}
                      </p>
                    </div>
                    <p className={`text-sm font-semibold tabular-nums ${isInvestment ? 'text-destructive' : 'text-success'}`}>
                      {isInvestment ? '-' : '+'}{formatUGX(tx.amount)}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

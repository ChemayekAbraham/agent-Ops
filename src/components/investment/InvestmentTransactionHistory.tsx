import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  History, 
  ArrowUpRight, 
  ArrowDownRight, 
  TrendingUp, 
  Wallet,
  Plus,
  Minus,
  Settings
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

interface Transaction {
  id: string;
  account_id: string;
  transaction_type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  description: string | null;
  transaction_date: string;
  created_at: string;
}

interface InvestmentTransactionHistoryProps {
  accountId?: string;
  userId?: string;
  maxItems?: number;
  showHeader?: boolean;
}

type TransactionType = 'investment' | 'top_up' | 'roi_payout' | 'withdrawal' | 'adjustment';

const transactionConfig: Record<TransactionType, {
  icon: typeof Wallet;
  label: string;
  color: string;
  bgColor: string;
  isPositive: boolean;
}> = {
  investment: {
    icon: Wallet,
    label: 'Investment',
    color: 'text-primary',
    bgColor: 'bg-primary/10',
    isPositive: true
  },
  top_up: {
    icon: Plus,
    label: 'Top Up',
    color: 'text-success',
    bgColor: 'bg-success/10',
    isPositive: true
  },
  roi_payout: {
    icon: TrendingUp,
    label: 'ROI Payout',
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
    isPositive: true
  },
  withdrawal: {
    icon: Minus,
    label: 'Withdrawal',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    isPositive: false
  },
  adjustment: {
    icon: Settings,
    label: 'Adjustment',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    isPositive: true
  }
};

const getTransactionConfig = (type: string) => {
  return transactionConfig[type as TransactionType] || transactionConfig.adjustment;
};

export function InvestmentTransactionHistory({ 
  accountId, 
  userId, 
  maxItems = 20,
  showHeader = true
}: InvestmentTransactionHistoryProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTransactions();
  }, [accountId, userId]);

  const fetchTransactions = async () => {
    setLoading(true);
    try {
      // investment_transactions table removed
      setTransactions([]);
    } catch (error) {
      console.error('Error fetching transactions:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-6 text-center">
          <History className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No transaction history yet</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {showHeader && (
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <History className="h-4 w-4 text-primary" />
              Transaction History
            </span>
            <Badge variant="secondary">{transactions.length}</Badge>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className={showHeader ? "pt-0" : "pt-4"}>
        <ScrollArea className="max-h-[400px]">
          <div className="space-y-2">
            {transactions.map((tx) => {
              const config = getTransactionConfig(tx.transaction_type);
              const Icon = config.icon;
              
              return (
                <div 
                  key={tx.id} 
                  className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
                >
                  <div className={`p-2 rounded-lg ${config.bgColor}`}>
                    <Icon className={`h-4 w-4 ${config.color}`} />
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{config.label}</p>
                      {config.isPositive ? (
                        <ArrowUpRight className="h-3 w-3 text-success" />
                      ) : (
                        <ArrowDownRight className="h-3 w-3 text-destructive" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      {tx.description || format(new Date(tx.transaction_date), 'MMM d, yyyy')}
                    </p>
                  </div>
                  
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${config.isPositive ? 'text-success' : 'text-destructive'}`}>
                      {config.isPositive ? '+' : '-'}{formatUGX(Math.abs(tx.amount))}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

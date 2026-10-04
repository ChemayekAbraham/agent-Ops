import { Transaction, CASH_IN_CATEGORIES, CASH_OUT_CATEGORIES } from '@/types/financial';
import { cn } from '@/lib/utils';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { format } from 'date-fns';
import { useCurrency } from '@/hooks/useCurrency';

interface TransactionListProps {
  transactions: Transaction[];
}

const getCategoryLabel = (category: string, direction: string) => {
  const categories = direction === 'cash_in' ? CASH_IN_CATEGORIES : CASH_OUT_CATEGORIES;
  return categories.find(c => c.value === category)?.label || category;
};

export function TransactionList({ transactions }: TransactionListProps) {
  const { formatAmount: formatCurrency } = useCurrency();

  if (transactions.length === 0) {
    return (
      <div className="glass-card rounded-xl p-8 text-center">
        <p className="text-muted-foreground">No transactions recorded yet.</p>
        <p className="text-sm text-muted-foreground/70 mt-1">
          Add your first transaction to start generating financial statements.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold">Recent Transactions</h3>
      </div>
      <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
        {[...transactions].reverse().slice(0, 10).map((tx) => (
          <div 
            key={tx.id} 
            className="p-4 flex items-center gap-4 hover:bg-muted/30 transition-colors animate-slide-up"
          >
            <div className={cn(
              "p-2 rounded-lg",
              tx.direction === 'cash_in' ? "bg-success/10" : "bg-destructive/10"
            )}>
              {tx.direction === 'cash_in' ? (
                <ArrowDownLeft className="h-4 w-4 text-success" />
              ) : (
                <ArrowUpRight className="h-4 w-4 text-destructive" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">
                {getCategoryLabel(tx.category, tx.direction)}
              </p>
              <p className="text-sm text-muted-foreground">
                {tx.referenceId} • {tx.linkedParty}
              </p>
            </div>
            <div className="text-right">
              <p className={cn(
                "font-mono font-semibold",
                tx.direction === 'cash_in' ? "text-success" : "text-destructive"
              )}>
                {tx.direction === 'cash_in' ? '+' : '-'}{formatCurrency(tx.amount)}
              </p>
              <p className="text-xs text-muted-foreground">
                {format(tx.date, 'MMM d, HH:mm')}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

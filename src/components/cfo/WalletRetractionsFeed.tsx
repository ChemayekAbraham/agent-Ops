import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useWalletRealtime } from '@/hooks/useWalletRealtime';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RecipientRoutingWarningBanner } from './RecipientRoutingWarningBanner';
import { MisroutedRetractionRetryPanel } from './MisroutedRetractionRetryPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, MinusCircle, Filter } from 'lucide-react';
import { format } from 'date-fns';

interface WalletRetractionsFeedProps {
  compact?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  cash_payout_retraction: 'Retracted from Partner Wallet',
  fee_correction: 'Fee Correction',
  fraud_reversal: 'Fraud Reversal',
  penalty: 'Penalty',
  overpayment_reversal: 'Overpayment Reversal',
  general_adjustment: 'General Adjustment',
  other: 'Other',
};

export function WalletRetractionsFeed({ compact = false }: WalletRetractionsFeedProps) {
  const [filterRetractions, setFilterRetractions] = useState(false);

  // Refresh feed instantly whenever a wallet deduction is inserted/updated anywhere.
  useWalletRealtime(undefined, [['cfo-wallet-deductions', filterRetractions] as unknown as string[]]);

  const { data: deductions, isLoading } = useQuery({
    queryKey: ['cfo-wallet-deductions', filterRetractions],
    queryFn: async () => {
      let query: any = (supabase
        .from('wallet_deductions') as any)
        .select(`
          id,
          target_user_id,
          deducted_by,
          amount,
          category,
          reason,
          created_at,
          target_profile:profiles!wallet_deductions_target_user_id_fkey(full_name, phone),
          admin_profile:profiles!wallet_deductions_deducted_by_fkey(full_name)
        `)
        .order('created_at', { ascending: false });

      if (filterRetractions) {
        query = query.eq('category', 'cash_payout_retraction');
      }

      if (compact) {
        query = query.limit(5);
      } else {
        query = query.limit(100);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <MinusCircle className="h-4 w-4 text-destructive" />
            Recent Wallet Retractions
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(!deductions || deductions.length === 0) ? (
            <p className="text-xs text-muted-foreground">No deductions recorded yet.</p>
          ) : (
            deductions.map((d: any) => (
              <div key={d.id} className="flex items-center justify-between text-xs border-b border-border pb-1.5 last:border-0">
                <div>
                  <span className="font-medium">{d.target_profile?.full_name || 'Unknown'}</span>
                  <span className="text-muted-foreground ml-1.5">
                    UGX {Number(d.amount).toLocaleString()}
                  </span>
                </div>
                <Badge
                  variant={d.category === 'cash_payout_retraction' ? 'destructive' : 'secondary'}
                  className="text-[10px] px-1.5"
                >
                  {CATEGORY_LABELS[d.category] || d.category}
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <RecipientRoutingWarningBanner />
      <MisroutedRetractionRetryPanel />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <MinusCircle className="h-5 w-5 text-destructive" />
            Wallet Retractions & Deductions
          </h1>
          <p className="text-sm text-muted-foreground">
            All wallet deductions with full audit trail. Retraction entries are highlighted.
          </p>
        </div>
        <Button
          size="sm"
          variant={filterRetractions ? 'default' : 'outline'}
          onClick={() => setFilterRetractions(!filterRetractions)}
          className="gap-1.5"
        >
          <Filter className="h-3.5 w-3.5" />
          {filterRetractions ? 'Show All' : 'Retractions Only'}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {(!deductions || deductions.length === 0) ? (
            <div className="text-center py-10 text-muted-foreground text-sm">
              No {filterRetractions ? 'retraction' : 'deduction'} records found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Partner / User</th>
                    <th className="px-4 py-3 font-medium">Phone</th>
                    <th className="px-4 py-3 font-medium text-right">Amount</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 font-medium">Reason</th>
                    <th className="px-4 py-3 font-medium">Performed By</th>
                    <th className="px-4 py-3 font-medium">Date & Time</th>
                  </tr>
                </thead>
                <tbody>
                  {deductions.map((d: any) => {
                    const isRetraction = d.category === 'cash_payout_retraction';
                    return (
                      <tr
                        key={d.id}
                        className={`border-b border-border last:border-0 ${isRetraction ? 'bg-destructive/5' : ''}`}
                      >
                        <td className="px-4 py-3 font-medium">
                          {d.target_profile?.full_name || 'Unknown'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {d.target_profile?.phone || '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-destructive">
                          UGX {Number(d.amount).toLocaleString()}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={isRetraction ? 'destructive' : 'secondary'}
                            className="text-xs"
                          >
                            {CATEGORY_LABELS[d.category] || d.category}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 max-w-[200px] truncate text-muted-foreground">
                          {d.reason}
                        </td>
                        <td className="px-4 py-3">
                          {d.admin_profile?.full_name || '—'}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {format(new Date(d.created_at), 'dd MMM yyyy, HH:mm')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

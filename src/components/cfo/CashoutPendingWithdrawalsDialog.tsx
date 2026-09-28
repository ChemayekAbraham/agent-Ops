import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2, Wallet, Smartphone, Building2, Banknote, Bell } from 'lucide-react';
import { WithdrawalPayoutCard } from '@/components/withdrawals/WithdrawalPayoutCard';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: any | null;
}

export function CashoutPendingWithdrawalsDialog({ open, onOpenChange, agent }: Props) {
  const { data: allWithdrawals = [], isLoading, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['cfo-pending-withdrawals'],
    queryFn: async () => {
      // No FK between withdrawal_requests.user_id and profiles — fetch and join manually.
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        // Aligned with FinOps dashboard so pending counts match across dashboards.
        .in('status', ['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved'])
        .order('created_at', { ascending: true });
      if (error) throw error;
      const rows = data || [];
      if (rows.length === 0) return rows;
      // Resolve both the requester and any linked partner (proxy partner
      // withdrawals) so the payout card shows the real partner name.
      const ids = Array.from(new Set(
        rows.flatMap((r: any) => [r.user_id, r.linked_party]).filter(Boolean),
      ));
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', ids);
      const map = new Map((profs || []).map((p: any) => [p.id, p]));
      return rows.map((r: any) => ({
        ...r,
        profiles: map.get(r.user_id) || null,
        linked_party_profile: r.linked_party ? map.get(r.linked_party) || null : null,
      }));
    },
    enabled: open,
    staleTime: 15_000,
    // Polled while open instead of an unfiltered Realtime listener on
    // withdrawal_requests (doc 147).
    refetchInterval: open ? 30_000 : false,
    refetchIntervalInBackground: false,
  });

  // For the auto-refresh indicator / refresh button (UI owned by Gemini).
  const lastUpdatedAt = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  const refresh = async () => { await refetch(); };

  const cashoutAgentRowId = agent?.id; // cashout_agents.id (FK target for assigned_cashout_agent_id)
  const agentName = agent?.profiles?.full_name || 'Agent';

  // Exclude withdrawals already claimed by ANY cash-out agent — locked for 10 min.
  const unclaimedWithdrawals = allWithdrawals.filter((w: any) => !w.assigned_cashout_agent_id);

  const momoWithdrawals = unclaimedWithdrawals.filter((w: any) => ['mobile_money', 'mtn_mobile_money', 'airtel_money'].includes(w.payout_method));
  const bankWithdrawals = unclaimedWithdrawals.filter((w: any) => w.payout_method === 'bank_transfer');
  const cashWithdrawals = unclaimedWithdrawals.filter((w: any) => ['cash', 'cash_pickup'].includes(w.payout_method) || !w.payout_method);
  const totalPending = unclaimedWithdrawals.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-2xl p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="p-4 pb-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg pr-6">
            <Banknote className="h-5 w-5 text-primary shrink-0" />
            <span className="truncate">Pending Withdrawals</span>
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            All pending withdrawals visible to Merchant Agents. <span className="font-semibold">{agentName}</span> can claim &amp; complete these from their own dashboard.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4 space-y-3">
          {totalPending > 0 && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-700 dark:text-orange-400">
              <Bell className="h-4 w-4 animate-pulse shrink-0" />
              <span className="text-xs font-medium">{totalPending} pending withdrawal{totalPending !== 1 ? 's' : ''} — Live</span>
            </div>
          )}

          <Tabs defaultValue="all">
            <TabsList className="w-full h-auto p-1 grid grid-cols-4 gap-1">
              <TabsTrigger value="all" className="flex-col sm:flex-row gap-0.5 sm:gap-1 text-[10px] sm:text-xs px-1 py-1.5 h-auto">
                <Wallet className="h-3.5 w-3.5" />
                <span className="flex items-center gap-1">All {totalPending > 0 && <Badge variant="destructive" className="h-3.5 px-1 text-[9px]">{totalPending}</Badge>}</span>
              </TabsTrigger>
              <TabsTrigger value="momo" className="flex-col sm:flex-row gap-0.5 sm:gap-1 text-[10px] sm:text-xs px-1 py-1.5 h-auto">
                <Smartphone className="h-3.5 w-3.5" />
                <span className="flex items-center gap-1">MoMo {momoWithdrawals.length > 0 && <Badge variant="destructive" className="h-3.5 px-1 text-[9px]">{momoWithdrawals.length}</Badge>}</span>
              </TabsTrigger>
              <TabsTrigger value="bank" className="flex-col sm:flex-row gap-0.5 sm:gap-1 text-[10px] sm:text-xs px-1 py-1.5 h-auto">
                <Building2 className="h-3.5 w-3.5" />
                <span className="flex items-center gap-1">Bank {bankWithdrawals.length > 0 && <Badge variant="destructive" className="h-3.5 px-1 text-[9px]">{bankWithdrawals.length}</Badge>}</span>
              </TabsTrigger>
              <TabsTrigger value="cash" className="flex-col sm:flex-row gap-0.5 sm:gap-1 text-[10px] sm:text-xs px-1 py-1.5 h-auto">
                <Banknote className="h-3.5 w-3.5" />
                <span className="flex items-center gap-1">Cash {cashWithdrawals.length > 0 && <Badge variant="destructive" className="h-3.5 px-1 text-[9px]">{cashWithdrawals.length}</Badge>}</span>
              </TabsTrigger>
            </TabsList>

            {(['all', 'momo', 'bank', 'cash'] as const).map(tab => {
              const items = tab === 'all' ? unclaimedWithdrawals : tab === 'momo' ? momoWithdrawals : tab === 'bank' ? bankWithdrawals : cashWithdrawals;
              const emptyMsg = tab === 'all' ? 'No pending withdrawals' : `No pending ${tab} payouts`;
              return (
                <TabsContent key={tab} value={tab} className="space-y-2 mt-3">
                  {isLoading ? (
                    <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                  ) : items.length === 0 ? (
                    <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{emptyMsg}</CardContent></Card>
                  ) : (
                    items.map((w: any) => (
                      <WithdrawalPayoutCard
                        key={w.id}
                        withdrawal={w}
                        readOnly
                        isClaimed={cashoutAgentRowId && w.assigned_cashout_agent_id === cashoutAgentRowId}
                        isClaimedByOther={!!w.assigned_cashout_agent_id && w.assigned_cashout_agent_id !== cashoutAgentRowId}
                      />
                    ))
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

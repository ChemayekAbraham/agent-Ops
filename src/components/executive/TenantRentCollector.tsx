import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { UserSearchPicker } from '@/components/cfo/UserSearchPicker';
import { Loader2, User, Wallet, Banknote, AlertTriangle, CheckCircle2, Info, History } from 'lucide-react';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { format } from 'date-fns';

interface SelectedUser {
  id: string;
  full_name: string;
  phone: string;
}

export function TenantRentCollector() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedTenant, setSelectedTenant] = useState<SelectedUser | null>(null);
  const [reason, setReason] = useState('');
  const [collectingId, setCollectingId] = useState<string | null>(null);

  const { data: tenantData, isLoading } = useQuery({
    queryKey: ['tenant-collect-data', selectedTenant?.id],
    enabled: !!selectedTenant,
    queryFn: async () => {
      const [requestsRes, tenantWalletRes] = await Promise.all([
        supabase
          .from('rent_requests')
          .select('id, status, rent_amount, amount_repaid, total_repayment, daily_repayment, agent_id, created_at')
          .eq('tenant_id', selectedTenant!.id)
          .in('status', ['funded', 'disbursed', 'repaying', 'approved'])
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('wallets')
          .select('balance')
          .eq('user_id', selectedTenant!.id)
          .single(),
      ]);

      const requests = requestsRes.data || [];
      const tenantBalance = Number(tenantWalletRes.data?.balance || 0);

      const agentIds = [...new Set(requests.map(r => r.agent_id).filter(Boolean))];
      let agentMap = new Map<string, { name: string; balance: number }>();

      if (agentIds.length > 0) {
        const [agentProfiles, agentWallets] = await Promise.all([
          supabase.from('profiles').select('id, full_name').in('id', agentIds),
          supabase.from('wallets').select('user_id, balance').in('user_id', agentIds),
        ]);
        const walletMap = new Map((agentWallets.data || []).map(w => [w.user_id, Number(w.balance)]));
        (agentProfiles.data || []).forEach(a => {
          agentMap.set(a.id, { name: a.full_name || '—', balance: walletMap.get(a.id) || 0 });
        });
      }

      return {
        requests: requests.map(r => ({
          ...r,
          outstanding: Number(r.total_repayment || 0) - Number(r.amount_repaid || 0),
          agent_name: r.agent_id ? agentMap.get(r.agent_id)?.name || '—' : 'No agent',
          agent_balance: r.agent_id ? agentMap.get(r.agent_id)?.balance || 0 : 0,
        })),
        tenantBalance,
      };
    },
  });

  const { data: collectionHistory, isLoading: historyLoading } = useQuery({
    queryKey: ['tenant-collection-history', selectedTenant?.id],
    enabled: !!selectedTenant,
    queryFn: async () => {
      const { data } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, amount, category, description, direction')
        .eq('user_id', selectedTenant!.id)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_out')
        .eq('source_table', 'rent_requests')
        .order('transaction_date', { ascending: false })
        .limit(20);
      return data || [];
    },
  });

  const collectMutation = useMutation({
    mutationFn: async ({ rentRequestId, collectionReason }: { rentRequestId: string; collectionReason: string }) => {
      const { data, error } = await supabase.functions.invoke('manual-collect-rent', {
        body: { rent_request_id: rentRequestId, reason: collectionReason },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Collection failed. Please try again.');
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: '✅ Rent Collected',
        description: `UGX ${Number(data.total_collected).toLocaleString()} collected. Tenant: ${Number(data.tenant_deducted).toLocaleString()}, Agent: ${Number(data.agent_deducted).toLocaleString()}`,
      });
      setReason('');
      setCollectingId(null);
      qc.invalidateQueries({ queryKey: ['tenant-collect-data', selectedTenant?.id] });
      qc.invalidateQueries({ queryKey: ['tenant-collection-history', selectedTenant?.id] });
    },
    onError: (e: any) => {
      toast({ title: 'Collection Failed', description: e.message, variant: 'destructive' });
      setCollectingId(null);
    },
  });

  const handleCollect = (rentRequestId: string) => {
    if (reason.trim().length < 10) {
      toast({ title: 'Reason required', description: 'Please provide a reason of at least 10 characters.', variant: 'destructive' });
      return;
    }
    setCollectingId(rentRequestId);
    collectMutation.mutate({ rentRequestId, collectionReason: reason.trim() });
  };

  const requests = tenantData?.requests || [];
  const tenantBalance = tenantData?.tenantBalance || 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Banknote className="h-4 w-4 text-primary" />
            Collect from Tenant & Agent Wallets
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <UserSearchPicker
            label="Search Tenant"
            placeholder="Tenant name or phone..."
            selectedUser={selectedTenant}
            onSelect={(u) => { setSelectedTenant(u); setReason(''); }}
            roleFilter="tenant"
          />

          {selectedTenant && (
            <>
              <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 border">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">Tenant Wallet:</span>
                <span className={`text-sm font-bold ${tenantBalance > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                  UGX {tenantBalance.toLocaleString()}
                </span>
              </div>

              {/* Reason input */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <Info className="h-3 w-3" /> Reason for collection <span className="text-destructive">*</span>
                </label>
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Daily rent repayment instalment for March cycle..."
                  className="min-h-[60px] text-sm"
                  maxLength={500}
                />
                {reason.length > 0 && reason.trim().length < 10 && (
                  <p className="text-[10px] text-destructive">Minimum 10 characters required ({reason.trim().length}/10)</p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selectedTenant && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground px-1">
            Active Rent Requests
          </p>

          {isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && requests.length === 0 && (
            <Card className="border-dashed">
              <CardContent className="p-4 text-center text-sm text-muted-foreground">
                No active rent requests to collect from
              </CardContent>
            </Card>
          )}

          {requests.map((rr) => (
            <Card key={rr.id} className={`border ${rr.outstanding > 0 ? 'border-amber-200' : 'border-emerald-200'}`}>
              <CardContent className="p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-[10px]">
                    {rr.status.replace(/_/g, ' ')}
                  </Badge>
                  {rr.outstanding <= 0 ? (
                    <Badge className="bg-emerald-500 text-white text-[10px]">
                      <CheckCircle2 className="h-3 w-3 mr-0.5" /> Paid
                    </Badge>
                  ) : (
                    <Badge className="bg-amber-500 text-white text-[10px]">
                      <AlertTriangle className="h-3 w-3 mr-0.5" /> Due
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div>
                    <span className="text-muted-foreground">Total:</span>{' '}
                    <span className="font-semibold">UGX {Number(rr.total_repayment || 0).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Outstanding:</span>{' '}
                    <span className="font-bold text-destructive">UGX {rr.outstanding.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Daily Rate:</span>{' '}
                    <span className="font-medium">UGX {Number(rr.daily_repayment || 0).toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Repaid:</span>{' '}
                    <span className="font-medium text-emerald-600">UGX {Number(rr.amount_repaid || 0).toLocaleString()}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs p-2 rounded-lg bg-muted/30 border">
                  <div className="flex items-center gap-1.5">
                    <User className="h-3 w-3 text-muted-foreground" />
                    <div>
                      <p className="text-muted-foreground text-[10px]">Agent</p>
                      <p className="font-medium">{rr.agent_name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Wallet className="h-3 w-3 text-muted-foreground" />
                    <div>
                      <p className="text-muted-foreground text-[10px]">Agent Wallet</p>
                      <p className={`font-bold ${rr.agent_balance > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                        UGX {rr.agent_balance.toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                {rr.outstanding > 0 && (
                  <Button
                    className="w-full h-10 text-sm gap-2"
                    variant="default"
                    disabled={collectMutation.isPending || reason.trim().length < 10}
                    onClick={() => handleCollect(rr.id)}
                  >
                    {collectingId === rr.id && collectMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Banknote className="h-4 w-4" />
                    )}
                    Collect UGX {Math.min(rr.outstanding, Number(rr.daily_repayment || rr.outstanding)).toLocaleString()}
                    <span className="text-xs opacity-70">(from wallets)</span>
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selectedTenant && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              Collection History
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {historyLoading && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {!historyLoading && (!collectionHistory || collectionHistory.length === 0) && (
              <p className="text-xs text-muted-foreground text-center py-4">No collection history yet</p>
            )}

            {!historyLoading && collectionHistory && collectionHistory.length > 0 && (
              <div className="divide-y divide-border">
                {collectionHistory.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">
                          {format(new Date(entry.transaction_date), 'dd MMM yyyy, HH:mm')}
                        </span>
                        <Badge variant="outline" size="sm">
                          {(entry.category || '').replace(/_/g, ' ')}
                        </Badge>
                      </div>
                      {entry.description && (
                        <p className="text-[11px] text-muted-foreground truncate max-w-[260px]">
                          {entry.description}
                        </p>
                      )}
                    </div>
                    <CompactAmount
                      value={Number(entry.amount || 0)}
                      className="text-sm font-semibold text-destructive shrink-0"
                    />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

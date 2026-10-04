import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  User, Wallet, Phone, Banknote, Loader2, AlertTriangle,
  CheckCircle2, Zap, CalendarPlus
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface UserProfileSheetProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  userName: string;
  userPhone?: string;
  userType: 'tenant' | 'agent' | 'landlord';
}

export function UserProfileSheet({ open, onClose, userId, userName, userPhone, userType }: UserProfileSheetProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showAutoCharge, setShowAutoCharge] = useState(false);
  const [chargeAmount, setChargeAmount] = useState('');
  const [chargeFrequency, setChargeFrequency] = useState('daily');
  const [chargeDays, setChargeDays] = useState('30');

  // Fetch wallet balance
  const { data: walletBalance } = useQuery({
    queryKey: ['profile-wallet', userId],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase.from('wallets').select('balance').eq('user_id', userId).single();
      return Number(data?.balance || 0);
    },
  });

  // Fetch active rent requests (for tenants, their own; for agents, their assigned)
  const { data: rentRequests, isLoading } = useQuery({
    queryKey: ['profile-rent-requests', userId, userType],
    enabled: open,
    queryFn: async () => {
      const col = userType === 'tenant' ? 'tenant_id' : userType === 'landlord' ? 'landlord_id' : 'agent_id';
      const { data } = await supabase
        .from('rent_requests')
        .select('id, status, tenant_id, agent_id, landlord_id, rent_amount, amount_repaid, total_repayment, daily_repayment, created_at')
        .eq(col, userId)
        .in('status', ['funded', 'disbursed', 'repaying', 'approved'])
        .order('created_at', { ascending: false })
        .limit(20);

      if (!data?.length) return [];

      // Fetch related profiles
      const relatedIds = [...new Set(data.map(r => userType === 'tenant' ? r.agent_id : r.tenant_id).filter(Boolean))] as string[];
      let profileMap = new Map<string, string>();
      if (relatedIds.length) {
        const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', relatedIds);
        (profiles || []).forEach(p => profileMap.set(p.id, p.full_name || '—'));
      }

      return data.map(r => ({
        ...r,
        outstanding: Number(r.total_repayment || 0) - Number(r.amount_repaid || 0),
        related_name: userType === 'tenant'
          ? (r.agent_id ? profileMap.get(r.agent_id) || '—' : 'No agent')
          : (profileMap.get(r.tenant_id) || r.tenant_id?.slice(0, 8) || '—'),
      }));
    },
  });

  // Fetch active auto-charges
  const { data: autoCharges } = useQuery({
    queryKey: ['profile-auto-charges', userId, userType],
    enabled: open,
    queryFn: async () => {
      const col = userType === 'agent' ? 'agent_id' : 'tenant_id';
      const { data } = await supabase
        .from('subscription_charges')
        .select('id, charge_amount, frequency, next_charge_date, charges_remaining, status, tenant_id, agent_id, charge_agent_wallet')
        .eq(col, userId)
        .eq('status', 'active')
        .order('next_charge_date', { ascending: true })
        .limit(10);
      return data || [];
    },
  });

  // Collect rent mutation
  const collectMutation = useMutation({
    mutationFn: async (rentRequestId: string) => {
      const { data, error } = await supabase.functions.invoke('manual-collect-rent', {
        body: { rent_request_id: rentRequestId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: '✅ Rent Collected',
        description: `${formatUGX(Number(data.total_collected))} collected successfully.`,
      });
      qc.invalidateQueries({ queryKey: ['profile-rent-requests', userId] });
      qc.invalidateQueries({ queryKey: ['profile-wallet', userId] });
      qc.invalidateQueries({ queryKey: ['daily-tracker-active'] });
      qc.invalidateQueries({ queryKey: ['missed-days-active'] });
    },
    onError: (e: any) => toast({ title: 'Collection Failed', description: e.message, variant: 'destructive' }),
  });

  // Add auto-charge mutation
  const autoChargeMutation = useMutation({
    mutationFn: async ({ rentRequestId, tenantId, agentId }: { rentRequestId: string; tenantId: string; agentId: string | null }) => {
      const amount = Number(chargeAmount);
      if (!amount || amount <= 0) throw new Error('Enter a valid amount');
      const days = Number(chargeDays);
      if (!days || days <= 0) throw new Error('Enter valid duration');

      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + days);

      const { error } = await supabase.from('subscription_charges').insert({
        tenant_id: tenantId,
        agent_id: agentId,
        rent_request_id: rentRequestId,
        charge_amount: amount,
        frequency: chargeFrequency,
        next_charge_date: new Date(startDate.getTime() + 86400000).toISOString().split('T')[0],
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        total_charges_due: chargeFrequency === 'daily' ? days : Math.ceil(days / 7),
        charges_remaining: chargeFrequency === 'daily' ? days : Math.ceil(days / 7),
        service_type: 'rent',
        charge_agent_wallet: userType === 'agent',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: '✅ Auto-Charge Added', description: `${formatUGX(Number(chargeAmount))} ${chargeFrequency} charge created.` });
      setShowAutoCharge(false);
      setChargeAmount('');
      qc.invalidateQueries({ queryKey: ['profile-auto-charges', userId] });
    },
    onError: (e: any) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const requests = rentRequests || [];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="bottom" className="h-[85vh] overflow-y-auto rounded-t-2xl px-4 pb-8">
        <SheetHeader className="pb-3">
          <SheetTitle className="flex items-center gap-2 text-base">
            <User className="h-5 w-5 text-primary" />
            {userName}
            <Badge variant="outline" className="text-[10px] capitalize">{userType}</Badge>
          </SheetTitle>
        </SheetHeader>

        {/* Quick info */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {userPhone && (
            <a href={`tel:${userPhone}`} className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50 border">
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs font-medium">{userPhone}</span>
            </a>
          )}
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50 border">
            <Wallet className="h-4 w-4 text-muted-foreground" />
            <span className={`text-sm font-bold ${(walletBalance || 0) > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
              {formatUGX(walletBalance || 0)}
            </span>
          </div>
        </div>

        {/* Active auto-charges */}
        {autoCharges && autoCharges.length > 0 && (
          <div className="mb-4 space-y-1.5">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3" /> Active Auto-Charges
            </p>
            {autoCharges.map(ac => (
              <div key={ac.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-amber-500/5 border border-amber-200 text-xs">
                <div>
                  <span className="font-semibold">{formatUGX(ac.charge_amount)}</span>
                  <span className="text-muted-foreground"> / {ac.frequency}</span>
                </div>
                <div className="text-right">
                  <span className="text-muted-foreground">{ac.charges_remaining} left</span>
                  <span className="text-muted-foreground ml-2">Next: {ac.next_charge_date}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add auto-charge button */}
        {!showAutoCharge && requests.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="w-full mb-4 gap-2 text-xs h-9"
            onClick={() => setShowAutoCharge(true)}
          >
            <CalendarPlus className="h-3.5 w-3.5" />
            Add Auto-Charge for {userType === 'tenant' ? 'Tenant' : 'Agent'}
          </Button>
        )}

        {/* Auto-charge form */}
        {showAutoCharge && requests.length > 0 && (
          <Card className="mb-4 border-primary/20">
            <CardContent className="p-3 space-y-3">
              <p className="text-xs font-semibold">New Auto-Charge</p>
              <Input
                type="number"
                placeholder="Amount (UGX)"
                value={chargeAmount}
                onChange={e => setChargeAmount(e.target.value)}
                className="h-9"
              />
              <div className="grid grid-cols-2 gap-2">
                <Select value={chargeFrequency} onValueChange={setChargeFrequency}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  placeholder="Duration (days)"
                  value={chargeDays}
                  onChange={e => setChargeDays(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 h-9 text-xs gap-1"
                  disabled={autoChargeMutation.isPending}
                  onClick={() => {
                    const rr = requests[0];
                    autoChargeMutation.mutate({
                      rentRequestId: rr.id,
                      tenantId: userType === 'tenant' ? userId : rr.tenant_id,
                      agentId: userType === 'agent' ? userId : rr.agent_id,
                    });
                  }}
                >
                  {autoChargeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                  Create
                </Button>
                <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setShowAutoCharge(false)}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Rent Requests */}
        <p className="text-xs font-semibold text-muted-foreground mb-2">
          {userType === 'tenant' ? 'Rent Requests' : 'Assigned Tenants'}
        </p>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : requests.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-4 text-center text-sm text-muted-foreground">
              No active rent requests
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {requests.map(rr => (
              <Card key={rr.id} className={`border ${rr.outstanding > 0 ? 'border-amber-200' : 'border-emerald-200'}`}>
                <CardContent className="p-3 space-y-2">
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

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">{userType === 'tenant' ? 'Agent' : 'Tenant'}:</span>{' '}
                      <span className="font-medium">{rr.related_name}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Outstanding:</span>{' '}
                      <span className="font-bold text-destructive">{formatUGX(rr.outstanding)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Daily:</span>{' '}
                      <span className="font-medium">{formatUGX(Number(rr.daily_repayment || 0))}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Repaid:</span>{' '}
                      <span className="font-medium text-emerald-600">{formatUGX(Number(rr.amount_repaid || 0))}</span>
                    </div>
                  </div>

                  {rr.outstanding > 0 && (
                    <Button
                      className="w-full h-9 text-xs gap-2"
                      disabled={collectMutation.isPending}
                      onClick={() => collectMutation.mutate(rr.id)}
                    >
                      {collectMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Banknote className="h-3.5 w-3.5" />
                      )}
                      Collect {formatUGX(Math.min(rr.outstanding, Number(rr.daily_repayment || rr.outstanding)))}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

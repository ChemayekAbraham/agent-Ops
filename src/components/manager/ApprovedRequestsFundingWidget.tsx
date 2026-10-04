import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CheckCircle, Home, Loader2, MapPin, HandCoins, Clock } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { excludePartnerReservedPlans } from '@/lib/partnerReservedPlans';
import { formatDistanceToNow } from 'date-fns';
import { motion } from 'framer-motion';
import { useToast } from '@/hooks/use-toast';
import { CollapsibleAgentSection } from '@/components/agent/CollapsibleAgentSection';

interface ApprovedRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  created_at: string;
  approved_at: string | null;
  house_category: string | null;
  request_city: string | null;
  tenant_name: string;
  agent_name: string | null;
  landlord_name: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  'single-room': 'Single Room',
  'double-room': 'Double Room',
  '1-bed': '1 Bed House',
  '2-bed': '2 Bedroom',
  '2-bed-full': '2 Bed Full',
  '3-bed': '3 Bedroom',
  '3-bed-luxury': '3 Bed Luxury',
  '4-bed': '4+ Bed Villa',
  'shop': 'Shop / Lock-up Shop',
  'market-stall': 'Market Stall',
  'kiosk': 'Kiosk / Container',
  'salon-workshop': 'Salon / Workshop',
  'office': 'Office Space',
  'warehouse': 'Warehouse / Store',
  'commercial': 'Other Commercial Premises',
};

export function ApprovedRequestsFundingWidget() {
  const [requests, setRequests] = useState<ApprovedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [fundingId, setFundingId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<ApprovedRequest | null>(null);
  const [transactionIdInput, setTransactionIdInput] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const { toast } = useToast();

  const fetchApproved = async () => {
    const { data, error } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, duration_days, created_at, approved_at, house_category, request_city, tenant_id, agent_id, landlord_id')
      .eq('status', 'approved')
      .is('funded_at', null)
      .order('approved_at', { ascending: false })
      .limit(30);

    if (error || !data) {
      setLoading(false);
      return;
    }

    // Partner self-funded plans are released by Partner Ops approval, not from
    // company float — never offer them here.
    const rows = await excludePartnerReservedPlans(data);

    const tenantIds = [...new Set(rows.map(r => r.tenant_id))];
    const agentIds = [...new Set(rows.map(r => r.agent_id).filter(Boolean))] as string[];
    const landlordIds = [...new Set(rows.map(r => r.landlord_id))];
    const allUserIds = [...new Set([...tenantIds, ...agentIds])];

    const [profilesRes, landlordsRes] = await Promise.all([
      allUserIds.length > 0
        ? supabase.from('profiles').select('id, full_name').in('id', allUserIds)
        : { data: [] },
      landlordIds.length > 0
        ? supabase.from('landlords').select('id, name').in('id', landlordIds)
        : { data: [] },
    ]);

    const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p.full_name]));
    const landlordMap = new Map((landlordsRes.data || []).map(l => [l.id, l.name]));

    setRequests(rows.map(r => ({
      id: r.id,
      rent_amount: r.rent_amount,
      duration_days: r.duration_days,
      created_at: r.created_at,
      approved_at: r.approved_at,
      house_category: r.house_category,
      request_city: r.request_city,
      tenant_name: profileMap.get(r.tenant_id) || 'Unknown',
      agent_name: r.agent_id ? profileMap.get(r.agent_id) || null : null,
      landlord_name: landlordMap.get(r.landlord_id) || 'Unknown',
    })));
    setLoading(false);
  };

  useEffect(() => {
    fetchApproved();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => fetchApproved(), 5000);
    };
    const channel = supabase
      .channel('approved-rent-requests-funding')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rent_requests' }, () => debouncedFetch())
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      supabase.removeChannel(channel);
    };
  }, []);

  const openFundConfirm = (request: ApprovedRequest) => {
    setPendingRequest(request);
    setTransactionIdInput('');
    setConfirmed(false);
    setConfirmOpen(true);
  };

  const handleFundTenant = async () => {
    if (!pendingRequest) return;

    const txDigits = transactionIdInput.replace(/\D/g, '');
    if (txDigits.length < 5) {
      toast({
        title: 'Transaction ID required',
        description: 'Enter at least 5 digits from the payment Transaction ID.',
        variant: 'destructive',
      });
      return;
    }

    const transactionId = `TID${txDigits}`;
    setFundingId(pendingRequest.id);

    try {
      const { data, error } = await supabase.functions.invoke('fund-agent-landlord-float', {
        body: {
          rent_request_id: pendingRequest.id,
          notes: `Manager funded – TID: ${transactionId}`,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      toast({
        title: '✅ Float Funded!',
        description: `${formatUGX(data.float_funded)} credited to ${data.message}. Agent must pay landlord & submit receipt.`,
      });

      setRequests(prev => prev.filter(r => r.id !== pendingRequest.id));
      setConfirmOpen(false);
      setPendingRequest(null);
      setTransactionIdInput('');
      setConfirmed(false);
      window.dispatchEvent(new CustomEvent('pool-funded'));
    } catch (err: any) {
      toast({
        title: 'Funding failed',
        description: err?.message || 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setFundingId(null);
    }
  };

  if (loading) {
    return (
      <CollapsibleAgentSection icon={CheckCircle} label="Approved — Ready to Fund" iconColor="text-emerald-600">
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </CollapsibleAgentSection>
    );
  }

  const txDigits = transactionIdInput.replace(/\D/g, '');
  const normalizedTransactionId = txDigits ? `TID${txDigits}` : '';
  const canConfirmFunding = !!pendingRequest && confirmed && txDigits.length >= 5 && !fundingId;

  return (
    <>
      <CollapsibleAgentSection
        icon={CheckCircle}
        label={`Approved — Ready to Fund${requests.length > 0 ? ` (${requests.length})` : ''}`}
        iconColor="text-emerald-600"
        isOpen={true}
      >
        {requests.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No approved requests awaiting funding
          </div>
        ) : (
          <div className="space-y-2">
            {requests.map((req, i) => (
              <motion.div
                key={req.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm truncate">{req.tenant_name}</p>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5">
                      {req.house_category && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
                          <Home className="h-2.5 w-2.5" />
                          {CATEGORY_LABELS[req.house_category] || req.house_category}
                        </Badge>
                      )}
                      {req.request_city && (
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <MapPin className="h-2.5 w-2.5" />
                          {req.request_city}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="font-black text-sm text-emerald-600 dark:text-emerald-400 shrink-0">
                    {formatUGX(req.rent_amount)}
                  </p>
                </div>

                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />
                  Approved {req.approved_at ? formatDistanceToNow(new Date(req.approved_at), { addSuffix: true }) : '—'}
                  {req.agent_name && (
                    <>
                      <span>•</span>
                      <span>by {req.agent_name}</span>
                    </>
                  )}
                  <span>•</span>
                  <span>{req.duration_days}d</span>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">
                    → Landlord: <span className="font-semibold text-foreground">{req.landlord_name}</span>
                  </p>
                  <Button
                    size="sm"
                    onClick={() => openFundConfirm(req)}
                    disabled={!!fundingId}
                    className="h-9 px-4 rounded-xl font-bold text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white touch-manipulation"
                  >
                    {fundingId === req.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <HandCoins className="h-3.5 w-3.5" />
                    )}
                    Fund this Tenant
                  </Button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </CollapsibleAgentSection>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
            setPendingRequest(null);
            setTransactionIdInput('');
            setConfirmed(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Tenant Funding</AlertDialogTitle>
            <AlertDialogDescription>
              Enter the payment Transaction ID and confirm before funds are deployed.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="fund-tenant-transaction-id">Transaction ID</Label>
              <Input
                id="fund-tenant-transaction-id"
                value={transactionIdInput}
                onChange={(e) => setTransactionIdInput(e.target.value.replace(/\D/g, ''))}
                placeholder="e.g. 1234567890"
                inputMode="numeric"
                maxLength={20}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Saved as: <span className="font-semibold">{normalizedTransactionId || 'TID'}</span>
              </p>
              {transactionIdInput.length > 0 && txDigits.length < 5 && (
                <p className="text-xs text-destructive">Transaction ID must have at least 5 digits.</p>
              )}
            </div>

            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
              I confirm this funding is verified and should proceed.
            </label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!fundingId}>Cancel</AlertDialogCancel>
            <Button onClick={handleFundTenant} disabled={!canConfirmFunding}>
              {fundingId ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm & Fund'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  Banknote, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Phone,
  User,
  Wallet,
  Loader2,
  AlertCircle,
  Camera,
  ImageIcon,
  X,
  Download,
  Upload
} from 'lucide-react';
import { format } from 'date-fns';
import { motion } from 'framer-motion';
import { hapticTap } from '@/lib/haptics';

interface PayoutRequest {
  id: string;
  agent_id: string;
  amount: number;
  mobile_money_number: string;
  mobile_money_provider: string;
  status: string;
  requested_at: string;
  agent_name?: string;
  agent_phone?: string;
}

export function AgentCommissionPayoutsManager() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [payouts, setPayouts] = useState<PayoutRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedPayout, setSelectedPayout] = useState<PayoutRequest | null>(null);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [transactionId, setTransactionId] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [processing, setProcessing] = useState(false);
  const [agentWalletBalance, setAgentWalletBalance] = useState<number | null>(null);
  const [loadingAgentWallet, setLoadingAgentWallet] = useState(false);
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [uploadingScreenshot, setUploadingScreenshot] = useState(false);

  useEffect(() => {
    fetchPayouts();
    // Realtime removed — agent_commission_payouts not in realtime whitelist
  }, []);

  const fetchPayouts = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_commission_payouts')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true });

      if (error) throw error;

      // Fetch agent details
      const payoutsWithAgents = await Promise.all(
        (data || []).map(async (payout) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, phone')
            .eq('id', payout.agent_id)
            .single();
          return {
            ...payout,
            agent_name: profile?.full_name,
            agent_phone: profile?.phone
          };
        })
      );

      setPayouts(payoutsWithAgents);
    } catch (error) {
      console.error('Error fetching payouts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSelectedAgentWalletBalance = async (agentId: string) => {
    setLoadingAgentWallet(true);
    try {
      const { data, error } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', agentId)
        .maybeSingle();

      if (error) throw error;
      setAgentWalletBalance(data?.balance ?? 0);
    } catch (error: any) {
      console.error('[AgentCommissionPayoutsManager] Failed to fetch wallet balance:', error);
      setAgentWalletBalance(null);
      toast({
        title: 'Failed to load wallet',
        description: error?.message || 'Could not fetch agent wallet balance.',
        variant: 'destructive',
      });
    } finally {
      setLoadingAgentWallet(false);
    }
  };

  const handleScreenshotChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setScreenshotFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setScreenshotPreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const clearScreenshot = () => {
    setScreenshotFile(null);
    setScreenshotPreview(null);
  };

  const saveScreenshotToDevice = () => {
    if (!screenshotPreview || !selectedPayout) return;
    
    const link = document.createElement('a');
    link.href = screenshotPreview;
    link.download = `payout-${selectedPayout.agent_name || 'agent'}-${transactionId || Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    toast({ title: 'Screenshot saved to device!' });
  };

  const uploadScreenshot = async (payoutId: string): Promise<string | null> => {
    if (!screenshotFile) return null;
    
    setUploadingScreenshot(true);
    try {
      const fileExt = screenshotFile.name.split('.').pop();
      const fileName = `payout-${payoutId}-${Date.now()}.${fileExt}`;
      const filePath = `commission-payouts/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from('payment-proofs')
        .upload(filePath, screenshotFile);

      if (uploadError) throw uploadError;

      const { data: signedUrlData } = await supabase.storage
        .from('payment-proofs')
        .createSignedUrl(filePath, 86400); // 24 hour expiry

      return signedUrlData?.signedUrl || null;
    } catch (error) {
      console.error('Screenshot upload failed:', error);
      return null;
    } finally {
      setUploadingScreenshot(false);
    }
  };

  const handleApprove = async () => {
    if (!selectedPayout || !transactionId.trim()) {
      toast({ title: 'Please enter the transaction ID', variant: 'destructive' });
      return;
    }

    hapticTap();
    setProcessing(true);

    try {
      // Upload screenshot first
      const screenshotUrl = await uploadScreenshot(selectedPayout.id);
      
      // Database trigger (trg_process_agent_commission_payout_approval) will
      // automatically deduct from wallet when status changes to 'approved'.
      // If balance is insufficient, the trigger raises an exception.

      const { error } = await supabase
        .from('agent_commission_payouts')
        .update({
          status: 'approved',
          transaction_id: transactionId.trim().toUpperCase(),
          processed_at: new Date().toISOString(),
          processed_by: user?.id
        })
        .eq('id', selectedPayout.id);

      if (error) {
        // Trigger may raise 'insufficient balance' error
        if (error.message?.includes('insufficient balance')) {
          toast({ 
            title: 'Insufficient Balance', 
            description: 'Agent does not have enough balance to cover this payout.',
            variant: 'destructive' 
          });
          setProcessing(false);
          return;
        }
        throw error;
      }

      // Notification removed - table dropped

      toast({ title: 'Payout approved successfully!' });
      // Re-fetch the agent's wallet balance so manager sees the deduction
      await fetchSelectedAgentWalletBalance(selectedPayout.agent_id);
      setApproveDialogOpen(false);
      setTransactionId('');
      setSelectedPayout(null);
      clearScreenshot();
    } catch (error: any) {
      toast({ title: 'Failed to approve', description: error.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!selectedPayout || !rejectionReason.trim()) {
      toast({ title: 'Please provide a rejection reason', variant: 'destructive' });
      return;
    }

    hapticTap();
    setProcessing(true);

    try {
      const { error } = await supabase
        .from('agent_commission_payouts')
        .update({
          status: 'rejected',
          rejection_reason: rejectionReason.trim(),
          processed_at: new Date().toISOString(),
          processed_by: user?.id
        })
        .eq('id', selectedPayout.id);

      if (error) throw error;

      // Notification removed - table dropped

      toast({ title: 'Payout rejected' });
      setRejectDialogOpen(false);
      setRejectionReason('');
      setSelectedPayout(null);
    } catch (error: any) {
      toast({ title: 'Failed to reject', description: error.message, variant: 'destructive' });
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (payouts.length === 0) {
    return null;
  }

  return (
    <>
      <Card className="border-warning/30 bg-warning/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Banknote className="h-5 w-5 text-warning" />
            Pending Commission Payouts
            <Badge variant="secondary" className="ml-auto">{payouts.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {payouts.map((payout, index) => (
            <motion.div
              key={payout.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              className="p-4 rounded-xl bg-background border border-border/50 space-y-3"
            >
              {/* Agent info */}
              <button
                type="button"
                className="flex items-center gap-3 w-full text-left"
                onClick={() => {
                  hapticTap();
                  setSelectedPayout(payout);
                  setDetailsDialogOpen(true);
                  fetchSelectedAgentWalletBalance(payout.agent_id);
                }}
              >
                <div className="p-2 rounded-full bg-primary/10">
                  <User className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold">{payout.agent_name || 'Agent'}</p>
                  <p className="text-xs text-muted-foreground">{payout.agent_phone}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-lg text-success">{formatUGX(payout.amount)}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(payout.requested_at), 'MMM d, h:mm a')}
                  </p>
                </div>
              </button>

              {/* Mobile money details */}
              <div className={`p-3 rounded-lg ${payout.mobile_money_provider === 'MTN' ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                <div className="flex items-center gap-2">
                  <Phone className={`h-4 w-4 ${payout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`} />
                  <span className={`font-bold ${payout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {payout.mobile_money_provider}
                  </span>
                  <span className="font-mono text-lg">{payout.mobile_money_number}</span>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    hapticTap();
                    setSelectedPayout(payout);
                    setRejectDialogOpen(true);
                  }}
                  className="flex-1 h-12 border-destructive/50 text-destructive hover:bg-destructive/10 touch-manipulation active:scale-[0.98]"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
                <Button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    hapticTap();
                    setSelectedPayout(payout);
                    setApproveDialogOpen(true);
                    fetchSelectedAgentWalletBalance(payout.agent_id);
                  }}
                  className="flex-1 h-12 bg-success hover:bg-success/90 touch-manipulation active:scale-[0.98]"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Approve
                </Button>
              </div>
            </motion.div>
          ))}
        </CardContent>
      </Card>

      {/* Approve Dialog */}
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              Confirm Payment
            </DialogTitle>
          </DialogHeader>

          {selectedPayout && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-muted/50">
                <p className="text-sm text-muted-foreground">Paying to</p>
                <p className="font-semibold">{selectedPayout.agent_name}</p>
                <div className="flex items-center gap-2 mt-2">
                  <Phone className={`h-4 w-4 ${selectedPayout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`} />
                  <span className={`font-medium ${selectedPayout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {selectedPayout.mobile_money_provider}
                  </span>
                  <span className="font-mono">{selectedPayout.mobile_money_number}</span>
                </div>
                <p className="text-2xl font-bold mt-3">{formatUGX(selectedPayout.amount)}</p>

                <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Current wallet balance</p>
                  <p className="font-mono font-semibold">
                    {loadingAgentWallet ? 'Loading…' : formatUGX(agentWalletBalance ?? 0)}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="transaction-id" className="flex items-center gap-2">
                  Transaction ID
                  <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="transaction-id"
                  placeholder={`e.g. ${selectedPayout.mobile_money_provider === 'MTN' ? 'PP240123.1234.A12345' : 'CP1234567890'}`}
                  value={transactionId}
                  onChange={(e) => setTransactionId(e.target.value)}
                  className="h-12 text-base font-mono"
                  disabled={processing}
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Enter the {selectedPayout.mobile_money_provider} transaction reference
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setApproveDialogOpen(false);
                    setTransactionId('');
                  }}
                  disabled={processing}
                  className="flex-1 h-12"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleApprove}
                  disabled={processing || !transactionId.trim()}
                  className="flex-1 h-12 bg-success hover:bg-success/90"
                >
                  {processing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Confirm Payment'
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Reject Payout Request
            </DialogTitle>
          </DialogHeader>

          {selectedPayout && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20">
                <p className="text-sm text-muted-foreground">Rejecting request from</p>
                <p className="font-semibold">{selectedPayout.agent_name}</p>
                <p className="text-lg font-bold mt-1">{formatUGX(selectedPayout.amount)}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="rejection-reason">
                  Reason for rejection
                  <span className="text-destructive ml-1">*</span>
                </Label>
                <Textarea
                  id="rejection-reason"
                  placeholder="e.g. Insufficient funds, Invalid number, etc."
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  className="min-h-[80px] text-base"
                  disabled={processing}
                />
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setRejectDialogOpen(false);
                    setRejectionReason('');
                  }}
                  disabled={processing}
                  className="flex-1 h-12"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleReject}
                  disabled={processing || !rejectionReason.trim()}
                  className="flex-1 h-12"
                >
                  {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reject Request'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Agent Details (tap name) */}
      <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5 text-primary" />
              Agent Wallet Balance
            </DialogTitle>
          </DialogHeader>

          {selectedPayout && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/50 bg-muted/30 p-3">
                <p className="font-semibold">{selectedPayout.agent_name || 'Agent'}</p>
                <p className="text-xs text-muted-foreground">{selectedPayout.agent_phone}</p>
              </div>

              <div className="rounded-xl border border-border/50 bg-background p-4">
                <p className="text-xs text-muted-foreground">Wallet balance</p>
                <p className="mt-1 text-2xl font-bold font-mono">
                  {loadingAgentWallet ? 'Loading…' : formatUGX(agentWalletBalance ?? 0)}
                </p>

                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Requested payout</span>
                  <span className="font-mono font-semibold text-success">{formatUGX(selectedPayout.amount)}</span>
                </div>

                <div className="mt-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Would remain</span>
                  <span className="font-mono font-semibold">
                    {loadingAgentWallet
                      ? '—'
                      : formatUGX(Math.max(0, (agentWalletBalance ?? 0) - selectedPayout.amount))}
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                className="w-full h-12"
                onClick={() => fetchSelectedAgentWalletBalance(selectedPayout.agent_id)}
                disabled={loadingAgentWallet}
              >
                {loadingAgentWallet ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh Balance'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

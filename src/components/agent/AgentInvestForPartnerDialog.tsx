import { useState, useEffect, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { formatUGX } from '@/lib/rentCalculations';
import { MAX_INVEST, investHelperRange, isInvestAmountValid } from '@/lib/partnershipInvestment';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';
import { Loader2, HandCoins, Wallet, TrendingUp, CheckCircle2, Copy, Share2, MessageCircle, Link, Smartphone, UserPlus, Info, User, Phone, Upload, FileText, X, Image } from 'lucide-react';
import { isValidPhoneNumberGlobal } from '@/lib/phoneUtils';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';

interface AgentInvestForPartnerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface SuccessData {
  reference_id: string;
  partner_name: string;
  monthly_reward: number;
  first_payout_date: string;
  new_balance: number;
  amount: number;
  activation_token: string | null;
  agent_name: string;
  portfolio_code: string | null;
}

export function AgentInvestForPartnerDialog({ open, onOpenChange, onSuccess }: AgentInvestForPartnerDialogProps) {
  const [partnerName, setPartnerName] = useState('');
  const [partnerPhone, setPartnerPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [investmentReference, setInvestmentReference] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [submitting, setSubmitting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [totalRentRequested, setTotalRentRequested] = useState(0);
  const [agentBalance, setAgentBalance] = useState(0);
  const [success, setSuccess] = useState<SuccessData | null>(null);
  const [shortActivationLink, setShortActivationLink] = useState<string | null>(null);

  const parsedAmount = Number(amount) || 0;
  const monthlyReward = Math.round(parsedAmount * 0.15);

  useEffect(() => {
    if (open) {
      fetchOpportunitySummary();
      fetchAgentBalance();
      setPartnerName('');
      setPartnerPhone('');
      setAmount('');
      setInvestmentReference('');
      setReceiptFile(null);
      setReceiptPreview(null);
      setSuccess(null);
      setShortActivationLink(null);
      setShowConfirm(false);
    }
  }, [open]);

  const handleReceiptChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      toast.error('Receipt file must be under 10MB');
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (!allowed.includes(file.type)) {
      toast.error('Only JPG, PNG, or PDF files are accepted');
      return;
    }
    setReceiptFile(file);
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setReceiptPreview(url);
    } else {
      setReceiptPreview(null);
    }
  };

  const removeReceipt = () => {
    setReceiptFile(null);
    setReceiptPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const fetchAgentBalance = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();
    if (data) setAgentBalance(data.balance);
  };

  const fetchOpportunitySummary = async () => {
    const { data } = await supabase
      .from('opportunity_summaries')
      .select('id, total_rent_requested')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      setSummaryId(data.id);
      setTotalRentRequested(data.total_rent_requested);
    }
  };

  const validateForm = () => {
    if (partnerName.trim().length < 2) {
      toast.error('Partner name is required (min 2 characters)');
      return false;
    }
    const phoneValidation = isValidPhoneNumberGlobal(partnerPhone);
    if (!phoneValidation.valid) {
      toast.error(phoneValidation.reason || 'Invalid phone number');
      return false;
    }
    if (parsedAmount < 1000) {
      toast.error('Minimum funding is UGX 1,000');
      return false;
    }
    if (parsedAmount > MAX_INVEST) {
      toast.error(`Maximum funding is ${formatUGX(MAX_INVEST)}`);
      return false;
    }
    if (parsedAmount > agentBalance) {
      toast.error('Amount exceeds your wallet balance');
      return false;
    }
    if (totalRentRequested > 0 && parsedAmount > totalRentRequested) {
      toast.error('Amount exceeds current rent demand');
      return false;
    }
    if (investmentReference.trim().length < 3) {
      toast.error('Funding reference is required (min 3 characters)');
      return false;
    }
    if (!receiptFile) {
      toast.error('Receipt upload is mandatory');
      return false;
    }
    return true;
  };

  const handleConfirmOpen = () => {
    if (!validateForm()) return;
    setShowConfirm(true);
  };

  // Lookup partner by phone, register if not found, then invest
  const handleSubmit = async () => {
    setShowConfirm(false);
    setSubmitting(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Upload receipt first
      let receiptUrl: string | null = null;
      if (receiptFile) {
        setUploadingReceipt(true);
        const timestamp = Date.now();
        const safeName = receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = `${user.id}/${timestamp}_${safeName}`;
        const { error: uploadErr } = await supabase.storage
          .from('investment-receipts')
          .upload(filePath, receiptFile);
        setUploadingReceipt(false);
        if (uploadErr) throw new Error('Receipt upload failed: ' + uploadErr.message);
        receiptUrl = filePath;
      }

      // Step 1: Try to find existing supporter by phone
      let partnerId: string | null = null;

      const phoneDigits = partnerPhone.replace(/[^0-9]/g, '');
      const local9 = phoneDigits.slice(-9);
      const phoneFormats = [local9, `0${local9}`, `256${local9}`, `+256${local9}`];

      const { data: existingPartners } = await supabase
        .rpc('search_supporters', {
          search_term: local9,
          result_limit: 5,
        });

      if (existingPartners && existingPartners.length > 0) {
        // Match by phone suffix
        const match = existingPartners.find((p: any) => {
          const pDigits = (p.phone || '').replace(/[^0-9]/g, '');
          return pDigits.slice(-9) === local9;
        });
        if (match) partnerId = match.id;
      }

      // Step 2: If not found, register new partner
      if (!partnerId) {
        const { data: regData, error: regError } = await supabase.functions.invoke('register-proxy-funder', {
          body: {
            full_name: partnerName.trim(),
            phone: partnerPhone.trim(),
            agent_id: user.id,
            notes: 'Auto-registered during field funding',
            telemetry: await collectAgentSignupTelemetry('/agent/invest-for-partner', 'funder'),
          },
        });

        if (regError) {
          const msg = await extractFromErrorObject(regError, 'Registration failed');
          throw new Error(msg);
        }
        if (regData?.error) throw new Error(regData.error);

        partnerId = regData.funder_id;
        toast.success(`${partnerName.trim()} registered as new partner`);
      }

      // Step 3: Invest for the partner
      const { data, error } = await supabase.functions.invoke('agent-invest-for-partner', {
        body: {
          partner_id: partnerId,
          amount: parsedAmount,
          summary_id: summaryId,
          investment_reference: investmentReference.trim(),
          receipt_file_url: receiptUrl,
        },
      });

      if (error) {
        const msg = await extractFromErrorObject(error, 'Funding failed');
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);

      setSuccess({
        reference_id: data.reference_id,
        partner_name: data.partner_name,
        monthly_reward: data.monthly_reward,
        first_payout_date: data.first_payout_date,
        new_balance: data.new_balance,
        amount: parsedAmount,
        activation_token: data.activation_token || null,
        agent_name: data.agent_name || 'Agent',
        portfolio_code: data.portfolio_code || null,
      });
      setAgentBalance(data.new_balance);
      toast.success('Funding completed — portfolio is active!');
      onSuccess?.();
    } catch (err: any) {
      toast.error(err.message || 'Funding failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Resolve short link when success is set
  useEffect(() => {
    if (!success?.activation_token) return;
    (async () => {
      try {
        const { data: { user: u } } = await supabase.auth.getUser();
        if (u) {
          const short = await createShortLink(u.id, '/join', { t: success.activation_token! });
          setShortActivationLink(short);
        }
      } catch {
        setShortActivationLink(`${getPublicOrigin()}/join?t=${success.activation_token}`);
      }
    })();
  }, [success?.activation_token]);

  const buildShareMessage = useCallback((s: SuccessData) => {
    const activationLink = shortActivationLink
      || (s.activation_token ? `${getPublicOrigin()}/join?t=${s.activation_token}` : null);

    let msg = `🎉 Your Welile Funding is Active!\n\nHi ${s.partner_name}, ${s.agent_name} has funded ${formatUGX(s.amount)} on your behalf into the Rent Management Pool.\n\n✅ Your portfolio is now active!\n\n💰 Monthly Reward: ${formatUGX(s.monthly_reward)} (15%)\n📅 Payout Cycle: Every 30 days\n🗓️ First Payout: ${s.first_payout_date}`;

    if (s.portfolio_code) {
      msg += `\n📋 Portfolio: ${s.portfolio_code}`;
    }

    if (activationLink) {
      msg += `\n\n👉 Activate your account to start receiving rewards:\n${activationLink}`;
    }

    msg += `\n\nRef: ${s.reference_id}`;
    return msg;
  }, [shortActivationLink]);

  const handleCopyLink = useCallback(async () => {
    if (!success) return;
    const msg = buildShareMessage(success);
    await navigator.clipboard.writeText(msg);
    toast.success('Copied to clipboard!');
  }, [success, buildShareMessage]);

  const handleWhatsApp = useCallback(() => {
    if (!success) return;
    const msg = buildShareMessage(success);
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  }, [success, buildShareMessage]);

  const handleSMS = useCallback(() => {
    if (!success) return;
    const msg = buildShareMessage(success);
    window.open(`sms:?body=${encodeURIComponent(msg)}`, '_self');
  }, [success, buildShareMessage]);

  const handleNativeShare = useCallback(async () => {
    if (!success) return;
    const msg = buildShareMessage(success);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Welile Funding', text: msg });
      } catch {
        // user cancelled
      }
    } else {
      await navigator.clipboard.writeText(msg);
      toast.success('Copied to clipboard!');
    }
  }, [success, buildShareMessage]);

  // ── Success Screen ──
  if (success) {
    const hasToken = !!success.activation_token;
    const activationLink = shortActivationLink
      || (hasToken ? `${getPublicOrigin()}/join?t=${success.activation_token}` : null);

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
          <div className="text-center space-y-4 py-4">
            <div className="mx-auto w-14 h-14 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <h3 className="font-bold text-lg">Portfolio Activated!</h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>Funded on behalf of <strong className="text-foreground">{success.partner_name}</strong></p>
              {success.portfolio_code && (
                <p>Portfolio: <strong className="font-mono text-foreground">{success.portfolio_code}</strong></p>
              )}
              <p>Monthly reward: <strong className="text-success">{formatUGX(success.monthly_reward)}</strong></p>
              <p>First payout: <strong className="text-foreground">{success.first_payout_date}</strong></p>
              <p>Your new balance: <strong className="text-foreground">{formatUGX(success.new_balance)}</strong></p>
              <p className="font-mono text-xs">Ref: {success.reference_id}</p>
              <p className="text-xs text-success">✅ Portfolio is active — partner can see their funds now</p>
              <p className="text-xs text-muted-foreground">💡 Your 2% commission is pending approval</p>
            </div>

            {/* Share Section */}
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-center gap-2 text-sm font-medium text-foreground">
                <Link className="h-4 w-4 text-primary" />
                {hasToken ? 'Share Activation Link' : 'Share Confirmation'}
              </div>

              {activationLink && (
                <div className="bg-muted/50 rounded-lg p-2 text-xs font-mono break-all text-muted-foreground">
                  {activationLink}
                </div>
              )}

              <div className="grid grid-cols-4 gap-2">
                <Button variant="outline" size="sm" onClick={handleCopyLink} className="flex-col h-auto py-2.5 gap-1">
                  <Copy className="h-4 w-4" />
                  <span className="text-[10px]">Copy</span>
                </Button>
                <Button variant="outline" size="sm" onClick={handleWhatsApp} className="flex-col h-auto py-2.5 gap-1 text-green-600 hover:text-green-700 border-green-200 hover:bg-green-50">
                  <MessageCircle className="h-4 w-4" />
                  <span className="text-[10px]">WhatsApp</span>
                </Button>
                <Button variant="outline" size="sm" onClick={handleSMS} className="flex-col h-auto py-2.5 gap-1 text-blue-600 hover:text-blue-700 border-blue-200 hover:bg-blue-50">
                  <Smartphone className="h-4 w-4" />
                  <span className="text-[10px]">SMS</span>
                </Button>
                <Button variant="outline" size="sm" onClick={handleNativeShare} className="flex-col h-auto py-2.5 gap-1">
                  <Share2 className="h-4 w-4" />
                  <span className="text-[10px]">Share</span>
                </Button>
              </div>

              {hasToken && (
                <div className="flex gap-2 p-3 rounded-lg bg-muted/50 border text-left">
                  <Info className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    If your partner doesn't have a smartphone, you can open the activation link on any device and enter the temporary password on their behalf.
                  </p>
                </div>
              )}
            </div>

            <Button onClick={() => onOpenChange(false)} className="w-full">Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Main Form ──
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-primary" />
              Fund Partner
            </DialogTitle>
            <DialogDescription>
              Enter partner details and funding amount. If the partner is new, they'll be registered automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Agent Balance */}
            <div className="p-3 rounded-lg bg-muted/50 border flex items-center gap-3">
              <Wallet className="h-5 w-5 text-primary" />
              <div>
                <p className="text-xs text-muted-foreground">Your Balance</p>
                <p className="font-bold text-foreground">{formatUGX(agentBalance)}</p>
              </div>
            </div>

            {/* Partner Name */}
            <div className="space-y-2">
              <Label htmlFor="partner-name">Partner Full Name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="partner-name"
                  placeholder="e.g. John Mukasa"
                  value={partnerName}
                  onChange={(e) => setPartnerName(e.target.value)}
                  className="pl-9"
                  maxLength={100}
                />
              </div>
            </div>

            {/* Partner Phone */}
            <div className="space-y-2">
              <Label htmlFor="partner-phone">Partner Phone Number</Label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="partner-phone"
                  placeholder="e.g. 0771234567"
                  value={partnerPhone}
                  onChange={(e) => setPartnerPhone(e.target.value)}
                  className="pl-9"
                  type="tel"
                />
              </div>
            </div>

            {/* Funding Amount */}
            <div className="space-y-2">
              <Label htmlFor="invest-amount">Funding Amount (UGX)</Label>
              <Input
                id="invest-amount"
                type="number"
                placeholder="Min 1,000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={1000}
              />
              <p className="text-xs text-muted-foreground">
                {investHelperRange(agentBalance)}
              </p>
              {parsedAmount > 0 && parsedAmount < 1000 && (
                <p className="text-xs text-destructive">Amount must be at least UGX 1,000</p>
              )}
              {parsedAmount > MAX_INVEST && (
                <p className="text-xs text-destructive">Amount must not exceed {formatUGX(MAX_INVEST)}</p>
              )}
              {parsedAmount > agentBalance && (
                <p className="text-xs text-destructive">Exceeds your wallet balance</p>
              )}
              {totalRentRequested > 0 && (
                <p className="text-xs text-muted-foreground">
                  Rent demand available: {formatUGX(totalRentRequested)}
                </p>
              )}
            </div>

            {/* Funding Reference */}
            <div className="space-y-2">
              <Label htmlFor="invest-ref">Funding Reference</Label>
              <div className="relative">
                <FileText className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="invest-ref"
                  placeholder="e.g. MoMo TID 12345 or cash receipt number"
                  value={investmentReference}
                  onChange={(e) => setInvestmentReference(e.target.value)}
                  className="pl-9"
                  maxLength={200}
                />
              </div>
            </div>

            {/* Receipt Upload */}
            <div className="space-y-2">
              <Label>Receipt Upload <span className="text-destructive">*</span></Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/jpg,application/pdf"
                onChange={handleReceiptChange}
                className="hidden"
              />
              {receiptFile ? (
                <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      {receiptFile.type.startsWith('image/') ? (
                        <Image className="h-4 w-4 text-primary shrink-0" />
                      ) : (
                        <FileText className="h-4 w-4 text-primary shrink-0" />
                      )}
                      <span className="text-xs truncate text-foreground">{receiptFile.name}</span>
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={removeReceipt}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  {receiptPreview && (
                    <img src={receiptPreview} alt="Receipt preview" className="rounded-md max-h-32 w-full object-contain" />
                  )}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full border-dashed h-20 flex-col gap-1"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-5 w-5 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Tap to upload receipt (JPG, PNG, PDF)</span>
                </Button>
              )}
            </div>

            {/* Payout Cycle Info */}
            <div className="p-3 rounded-lg bg-muted/50 border border-border/60">
              <p className="text-xs text-muted-foreground">📅 Payout Cycle: <strong className="text-foreground">Every 30 days</strong> from funding date</p>
            </div>

            {/* Reward Preview */}
            {parsedAmount >= 1000 && (
              <div className="p-3 rounded-lg bg-success/10 border border-success/20 space-y-1">
                <div className="flex items-center gap-2 text-sm font-medium text-success">
                  <TrendingUp className="h-4 w-4" />
                  15% Monthly Reward Preview
                </div>
                <p className="text-xs text-muted-foreground">
                  Monthly: <strong className="text-foreground">{formatUGX(monthlyReward)}</strong> ×12 months = <strong className="text-foreground">{formatUGX(monthlyReward * 12)}</strong>
                </p>
              </div>
            )}

            <Button
              onClick={handleConfirmOpen}
              disabled={submitting || partnerName.trim().length < 2 || !partnerPhone.trim() || !isInvestAmountValid(parsedAmount, agentBalance) || investmentReference.trim().length < 3 || !receiptFile}
              className="w-full"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Processing...
                </>
              ) : (
                <>
                  <HandCoins className="h-4 w-4 mr-2" />
                  Fund {parsedAmount >= 1000 ? formatUGX(parsedAmount) : ''} for Partner
                </>
              )}
            </Button>
          </div>
        </DialogContent>

        {/* Confirmation Dialog */}
        <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
          <AlertDialogContent className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <HandCoins className="h-5 w-5 text-primary" />
                Confirm Funding
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-3 pt-2">
                  <p className="text-sm text-muted-foreground">Please review the details before proceeding:</p>
                  <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Partner</span>
                      <span className="font-medium text-foreground">{partnerName.trim()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Phone</span>
                      <span className="font-medium text-foreground">{partnerPhone.trim()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Amount</span>
                      <span className="font-bold text-foreground">{formatUGX(parsedAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Commission (2%)</span>
                      <span className="font-medium text-success">{formatUGX(Math.round(parsedAmount * 0.02))}</span>
                    </div>
                    <hr className="border-border" />
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Monthly reward (15%)</span>
                      <span className="font-medium text-success">{formatUGX(monthlyReward)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Payout cycle</span>
                      <span className="font-medium text-foreground">Every 30 days</span>
                    </div>
                    <hr className="border-border" />
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Your balance after</span>
                      <span className="font-bold text-foreground">{formatUGX(agentBalance - parsedAmount)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 p-2 rounded-lg bg-success/10 border border-success/20">
                    <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                    <p className="text-xs text-muted-foreground">Portfolio will be <strong className="text-success">activated instantly</strong> — partner can see their funds immediately.</p>
                  </div>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleSubmit} className="gap-2">
                <HandCoins className="h-4 w-4" />
                Confirm & Activate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Dialog>
    </>
  );
}

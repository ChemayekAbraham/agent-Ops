import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Banknote, Loader2, Phone, ShieldCheck, Wallet, User } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { motion, AnimatePresence } from 'framer-motion';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';
import { LandlordPayoutProgress } from './LandlordPayoutProgress';
import AgentContactLocationGate from './AgentContactLocationGate';
import { useRequireContactLocation } from '@/hooks/useRequireContactLocation';

interface PropertyInfo {
  id: string;            // landlord_id
  name: string;          // landlord name
  phone: string;
  mobile_money_number: string | null;
  // The number Landlord Ops actually approved at verification time, frozen
  // by set_landlord_verification(). This — never mobile_money_number/phone,
  // which anyone with landlords-UPDATE access can silently change — is the
  // only number this dialog ever prefills or pays to.
  verified_mobile_money_number: string | null;
  verification_status?: string | null;
  property_address: string;
  monthly_rent: number | null;
}

interface AgentLandlordPayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  property: PropertyInfo | null;
  onSuccess?: () => void;
}

type Step = 'form' | 'otp' | 'progress';

function normalizeLandlordPhone(phone?: string | null): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.startsWith('256') && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 9) return `0${digits}`;
  return digits;
}

export function AgentLandlordPayoutDialog({ open, onOpenChange, property, onSuccess }: AgentLandlordPayoutDialogProps) {
  const { user } = useAuth();
  const locGate = useRequireContactLocation(property?.id ?? null, 'landlord', property?.name ?? null);
  const [step, setStep] = useState<Step>('form');

  // form
  const [landlordName, setLandlordName] = useState('');
  // Never agent-editable — this must always be the number Landlord Ops
  // actually approved, not something typed into this form and not the raw
  // mobile_money_number/phone (which can be changed with zero re-approval).
  // A blank prefill here once let an agent type in a number, which would
  // misdirect a real payout.
  const landlordVerified = property?.verification_status === 'verified';
  const landlordPhone = (property?.mobile_money_number || property?.phone || '').trim();
  const approvedPhone = (property?.verified_mobile_money_number || '').trim();
  const payoutNumberApproved =
    landlordVerified &&
    !!landlordPhone &&
    normalizeLandlordPhone(landlordPhone) === normalizeLandlordPhone(approvedPhone);
  const [tenantName, setTenantName] = useState('');
  const [tenantPhone, setTenantPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState<'MTN' | 'Airtel' | ''>('');
  const [floatBalance, setFloatBalance] = useState<number | null>(null);

  // OTP
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  // progress
  const [payoutId, setPayoutId] = useState<string | null>(null);

  const resetAll = () => {
    setStep('form');
    setLandlordName(property?.name ?? '');
    setTenantName('');
    setTenantPhone('');
    setAmount(property?.monthly_rent ? String(property.monthly_rent) : '');
    setProvider('');
    setChallengeId(null);
    setOtpSent(false);
    setOtpVerified(false);
    setOtpError(null);
    setPayoutId(null);
  };

  // Pre-fill when opened
  useEffect(() => {
    if (open && property) {
      setLandlordName(property.name ?? '');
      setAmount(property.monthly_rent ? String(property.monthly_rent) : '');
    }
  }, [open, property]);

  // Live float balance
  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;
    (async () => {
      // Spendable float, not the gross balance: `agent_landlord_float.balance`
      // still carries allocations the 24h idle recall has pulled back, and the
      // disbursement backend enforces this same RPC. Validating against the
      // gross figure would let an agent key in an amount the payout rejects.
      const { data } = await supabase.rpc('get_agent_lp_float_available', {
        p_agent_id: user.id,
      });
      if (!cancelled) setFloatBalance(Number(data ?? 0));
    })();
    return () => { cancelled = true; };
  }, [open, user, step]);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) resetAll();
    onOpenChange(newOpen);
  };

  const validateForm = (): string | null => {
    if (!landlordName.trim()) return 'Landlord name is required';
    if (!landlordPhone) return 'This landlord has no mobile money number on file — ask Landlord Ops to add and verify it before paying.';
    if (!/^\+?\d{9,15}$/.test(landlordPhone.replace(/\s|-/g, ''))) return 'The landlord number on file looks invalid — ask Landlord Ops to correct and verify it.';
    if (!payoutNumberApproved) return 'The landlord number on file has changed since approval — Landlord Ops must verify the current number before paying.';
    if (!tenantName.trim()) return 'Tenant name is required';
    if (!/^\+?\d{9,15}$/.test(tenantPhone.replace(/\s|-/g, ''))) return 'Invalid tenant phone';
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) return 'Enter a valid amount';
    if (floatBalance !== null && amt > floatBalance) {
      return `Amount exceeds your Landlord Payout Float (${formatUGX(floatBalance)})`;
    }
    if (!provider) return 'Select mobile money provider';
    return null;
  };

  const handleSendOtp = async () => {
    const err = validateForm();
    if (err) { toast.error(err); return; }
    setOtpLoading(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('issue-landlord-payout-otp', {
        body: {
          landlord_id: property?.id,
          landlord_name: landlordName,
          landlord_phone: landlordPhone,
          tenant_name: tenantName,
          tenant_phone: tenantPhone,
          amount: parseFloat(amount),
          mobile_money_provider: provider,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      setChallengeId((data as any).challenge_id);
      setOtpSent(true);
      setStep('otp');
      toast.success('OTP sent to landlord');
    } catch (e: any) {
      toast.error(e.message ?? 'Could not send OTP');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleResendOtp = async () => {
    if (!challengeId) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('issue-landlord-payout-otp', {
        body: { challenge_id: challengeId },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success('New OTP sent');
    } catch (e: any) {
      toast.error(e.message ?? 'Could not resend OTP');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleVerifyOtp = async (otp: string) => {
    if (!challengeId) return;
    setOtpLoading(true);
    setOtpError(null);
    try {
      const { data, error } = await supabase.functions.invoke('verify-landlord-payout-otp', {
        body: { challenge_id: challengeId, otp },
      });
      if (error) throw error;
      if ((data as any)?.error) {
        setOtpError((data as any).error);
        return;
      }
      setOtpVerified(true);
      setPayoutId((data as any).payout_id);
      setStep('progress');
      onSuccess?.();
    } catch (e: any) {
      setOtpError(e.message ?? 'Verification failed');
    } finally {
      setOtpLoading(false);
    }
  };

  if (!property) return null;

  if (open && locGate.needsCapture) {
    return (
      <AgentContactLocationGate
        open
        targetId={property.id}
        targetRole="landlord"
        targetName={property.name}
        blocking={false}
        onComplete={() => locGate.onCaptured()}
        onCancel={() => onOpenChange(false)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'progress' ? <ShieldCheck className="h-5 w-5 text-primary" /> : <Banknote className="h-5 w-5 text-success" />}
            {step === 'form' && 'Initiate Rent Payout'}
            {step === 'otp' && 'Verify Landlord OTP'}
            {step === 'progress' && 'Disbursement in Progress'}
          </DialogTitle>
          <DialogDescription>
            {step === 'form' && `Send rent from your Landlord Payout Float to ${property.name}`}
            {step === 'otp' && 'Ask the landlord for the 6-digit code we just SMS-ed them'}
            {step === 'progress' && 'Tracking the live mobile money transfer'}
          </DialogDescription>
        </DialogHeader>

        <AnimatePresence mode="wait">
          {step === 'form' && (
            <motion.div key="form" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="space-y-4">
              {/* Float */}
              <div className="flex items-center justify-between p-3 rounded-xl border-2 border-primary/20 bg-primary/5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Wallet className="h-4 w-4" /> Landlord Payout Float
                </div>
                <span className="font-mono font-bold text-primary">
                  {floatBalance === null ? '…' : formatUGX(floatBalance)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><User className="h-3 w-3" /> Landlord Name *</Label>
                  <Input value={landlordName} onChange={(e) => setLandlordName(e.target.value)} className="h-10" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><Phone className="h-3 w-3" /> Landlord Phone *</Label>
                  <Input
                    value={landlordPhone || 'Not yet approved by Landlord Ops'}
                    readOnly
                    disabled
                    className="h-10 bg-muted/60 text-muted-foreground cursor-not-allowed"
                  />
                  {!landlordPhone && (
                    <p className="text-[11px] text-destructive">Ask Landlord Ops to (re-)verify this landlord before paying.</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><User className="h-3 w-3" /> Tenant Name *</Label>
                  <Input value={tenantName} onChange={(e) => setTenantName(e.target.value)} className="h-10" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1"><Phone className="h-3 w-3" /> Tenant Phone *</Label>
                  <Input value={tenantPhone} onChange={(e) => setTenantPhone(e.target.value)} placeholder="0772…" className="h-10" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Amount (UGX) *</Label>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder={String(property.monthly_rent || 500000)}
                    className="h-10"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Provider *</Label>
                  <Select value={provider} onValueChange={(v) => setProvider(v as 'MTN' | 'Airtel')}>
                    <SelectTrigger className="h-10"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MTN">MTN Mobile Money</SelectItem>
                      <SelectItem value="Airtel">Airtel Money</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button onClick={handleSendOtp} className="w-full h-12 rounded-xl gap-2" disabled={otpLoading || !payoutNumberApproved}>
                {otpLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Send OTP to Landlord
              </Button>
              <p className="text-[11px] text-muted-foreground text-center">
                Funds remain in your Landlord Payout Float until the landlord shares the OTP with you.
              </p>
            </motion.div>
          )}

          {step === 'otp' && (
            <motion.div key="otp" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} className="space-y-4">
              <div className="rounded-xl bg-muted/50 p-3 text-xs space-y-1">
                <p><span className="text-muted-foreground">Paying:</span> <span className="font-semibold">{formatUGX(parseFloat(amount))}</span></p>
                <p><span className="text-muted-foreground">To:</span> {landlordName} ({landlordPhone})</p>
                <p><span className="text-muted-foreground">For tenant:</span> {tenantName}</p>
              </div>
              <OtpVerificationStep
                phone={landlordPhone}
                otpSent={otpSent}
                otpVerified={otpVerified}
                otpLoading={otpLoading}
                otpError={otpError}
                onSendOtp={handleSendOtp}
                onVerifyOtp={handleVerifyOtp}
                onResendOtp={handleResendOtp}
              />
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setStep('form')}>
                ← Back to details
              </Button>
            </motion.div>
          )}

          {step === 'progress' && payoutId && (
            <motion.div key="progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <LandlordPayoutProgress
                payoutId={payoutId}
                landlordName={landlordName}
                onDone={(status) => {
                  if (status === 'completed') {
                    toast.success('Rent paid to landlord');
                  }
                }}
              />
              <Button onClick={() => handleOpenChange(false)} variant="outline" className="w-full mt-2">
                Close
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

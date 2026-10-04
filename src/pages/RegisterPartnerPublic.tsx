import { useState, useEffect, useCallback, useRef } from 'react';
import { roleToSlug } from '@/lib/roleRoutes';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { UGANDA_BANKS } from '@/lib/ugandaBanks';
import {
  validateFullName,
  joinPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import {
  UserPlus, CheckCircle2, AlertCircle, Phone, User, Mail, MapPin,
  Loader2, Banknote, X, TrendingUp, Wallet
} from 'lucide-react';

function AgentFooter({ agentInfo }: { agentInfo: { name: string; phone: string } | null }) {
  if (!agentInfo) return null;
  return (
    <div className="mt-6 pt-4 border-t border-border/40 text-center space-y-1">
      <p className="text-xs text-muted-foreground">This form was shared by:</p>
      <p className="text-sm font-semibold">{agentInfo.name}</p>
      {agentInfo.phone && <p className="text-xs text-muted-foreground">{agentInfo.phone}</p>}
    </div>
  );
}

function Branding() {
  return (
    <div className="text-center pt-4">
      <p className="text-xs text-muted-foreground">Powered by <span className="font-semibold text-primary">Welile</span></p>
    </div>
  );
}

const ROI_RATE = 0.15;

export default function RegisterPartnerPublic() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const agentId = searchParams.get('agent');
  const token = searchParams.get('token');

  const [agentInfo, setAgentInfo] = useState<{ name: string; phone: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form fields
  // Captured in parts; `full_name` submitted as one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [residence, setResidence] = useState('');
  const [investmentAmount, setInvestmentAmount] = useState('');
  const [payoutMethod, setPayoutMethod] = useState('');
  const [mobileNetwork, setMobileNetwork] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');

  // Marketing insight state
  const [shownInsight, setShownInsight] = useState(false);
  const [insightVisible, setInsightVisible] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showInvestInsight = useCallback((amount: string) => {
    const num = parseFloat(amount.replace(/,/g, ''));
    if (!shownInsight && num >= 100000) {
      setInsightVisible(true);
      setShownInsight(true);
    }
  }, [shownInsight]);

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInvestmentAmount(val);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => showInvestInsight(val), 1000);
  };

  const handleAmountBlur = () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    showInvestInsight(investmentAmount);
  };

  const amount = parseInt(investmentAmount.replace(/,/g, '')) || 0;
  const monthlyROI = Math.round(amount * ROI_RATE);
  const annualROI = monthlyROI * 12;

  useEffect(() => {
    async function fetchAgent() {
      if (!agentId || !token) { setError('Invalid link — missing agent or token.'); setLoading(false); return; }
      try {
        const { data: profile } = await supabase
          .from('profiles').select('full_name, phone').eq('id', agentId).maybeSingle();
        if (profile) setAgentInfo({ name: profile.full_name || 'Welile Agent', phone: profile.phone || '' });
      } catch {}
      setLoading(false);
    }
    fetchAgent();
  }, [agentId, token]);

  const canSubmit = !!(
    validatePersonNameParts(nameParts).valid && phone.trim() && email.trim() && residence.trim() &&
    amount >= 100000 && payoutMethod &&
    (payoutMethod === 'bank_transfer'
      ? bankName && accountName.trim() && accountNumber.trim()
      : mobileNumber.trim())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const nameCheck = validateFullName(fullName);
      if (!nameCheck.valid) {
        setError(nameCheck.error);
        setSubmitting(false);
        return;
      }
      const payload: Record<string, unknown> = {
        token, agent_id: agentId,
        full_name: nameCheck.trimmed,
        phone: phone.trim(),
        email: email.trim(),
        residence: residence.trim(),
        investment_amount: amount,
        payout_method: payoutMethod,
      };

      if (payoutMethod === 'bank_transfer') {
        payload.bank_name = bankName;
        payload.account_name = accountName.trim();
        payload.account_number = accountNumber.trim();
      } else {
        payload.mobile_network = mobileNetwork || payoutMethod;
        payload.mobile_money_number = mobileNumber.trim();
      }

      const { data, error: fnErr } = await supabase.functions.invoke('submit-partner-form', { body: payload });
      if (fnErr || data?.error) throw new Error(data?.error || fnErr?.message || 'Submission failed');
      // Auto sign-in: backend returns temp credentials for newly-created partners.
      // Existing users skip sign-in (no password available) — they see the success screen.
      if (data?.auth_email && data?.auth_password) {
        try {
          await supabase.auth.signOut();
          const { error: signInErr } = await supabase.auth.signInWithPassword({
            email: data.auth_email,
            password: data.auth_password,
          });
          if (signInErr) {
            console.warn('[RegisterPartnerPublic] Auto sign-in failed:', signInErr.message);
            setSubmitted(true);
            return;
          }
          // Persistent session — user stays signed in across browser restarts until explicit sign-out.
          navigate('/dashboard/tenant', { replace: true });
          return;
        } catch (signInErr) {
          console.warn('[RegisterPartnerPublic] Auto sign-in threw:', signInErr);
        }
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/10 flex items-center justify-center">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </div>
          <h2 className="text-xl font-bold">Registration Submitted!</h2>
          <p className="text-muted-foreground text-sm">
            Thank you for your interest. Our team will review your application and contact you shortly.
          </p>
          {amount > 0 && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 text-left space-y-1">
              <p className="text-xs text-muted-foreground">Investment Summary</p>
              <p className="font-semibold">{formatUGX(amount)} invested</p>
              <p className="text-sm text-primary font-medium">Monthly ROI: {formatUGX(monthlyROI)}</p>
            </div>
          )}
          <AgentFooter agentInfo={agentInfo} />
          <Branding />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <div className="max-w-md mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
            <TrendingUp className="h-7 w-7 text-primary" />
          </div>
          <h1 className="text-xl font-bold">Partner Registration</h1>
          <p className="text-sm text-muted-foreground">Join Welile as an investment partner and start earning monthly returns.</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* A. Personal Details */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <User className="h-4 w-4 text-primary" /> Personal Details
            </h3>

            <div className="space-y-1.5">
              <Label>Full Name *</Label>
              <PersonNameFields idPrefix="register-partner" value={nameParts} onChange={setNameParts} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone Number *</Label>
              <Input id="phone" type="tel" placeholder="0783..." value={phone} onChange={e => setPhone(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email Address *</Label>
              <Input id="email" type="email" placeholder="john@email.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="residence">Residence / Location *</Label>
              <Input id="residence" placeholder="Kampala, Uganda" value={residence} onChange={e => setResidence(e.target.value)} />
            </div>
          </div>

          {/* B. Investment Details */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Banknote className="h-4 w-4 text-primary" /> Investment Details
            </h3>

            <div className="space-y-1.5">
              <Label htmlFor="investAmount">Amount to Invest (UGX) *</Label>
              <Input
                id="investAmount"
                type="number"
                inputMode="numeric"
                placeholder="1,000,000"
                min={100000}
                value={investmentAmount}
                onChange={handleAmountChange}
                onBlur={handleAmountBlur}
              />
              <p className="text-xs text-muted-foreground">Minimum: UGX 100,000</p>
            </div>

            {/* Marketing Insight Popup */}
            {insightVisible && amount > 0 && (
              <div className="relative bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 animate-in slide-in-from-top-2 duration-300">
                <button
                  type="button"
                  onClick={() => setInsightVisible(false)}
                  className="absolute top-2 right-2 p-1 rounded-full hover:bg-muted/60"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                <p className="text-xs font-semibold text-emerald-600 mb-1">💡 Did You Know?</p>
                <p className="text-sm">
                  With an investment of <span className="font-bold">{formatUGX(amount)}</span>, you could earn up to:
                </p>
                <p className="text-lg font-bold text-emerald-600 mt-1">
                  {formatUGX(annualROI)} per year
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  That's {formatUGX(monthlyROI)} every 30 days — deposited directly to your preferred payout method.
                </p>
              </div>
            )}

            {/* ROI Display */}
            {amount >= 100000 && (
              <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Monthly ROI (15%)</span>
                  <span className="font-bold text-primary">{formatUGX(monthlyROI)}</span>
                </div>
                <p className="text-xs text-muted-foreground">You will earn this amount every 30 days.</p>
                <div className="flex items-center justify-between pt-1 border-t border-border/30">
                  <span className="text-xs text-muted-foreground">Estimated Annual Earnings</span>
                  <span className="font-semibold text-sm">{formatUGX(annualROI)}</span>
                </div>
              </div>
            )}
          </div>

          {/* C. Payment Preferences */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" /> ROI Payment Preferences
            </h3>

            <div className="space-y-1.5">
              <Label>Preferred Payout Method *</Label>
              <Select value={payoutMethod} onValueChange={(v) => { setPayoutMethod(v); setMobileNetwork(''); setMobileNumber(''); setBankName(''); setAccountName(''); setAccountNumber(''); }}>
                <SelectTrigger><SelectValue placeholder="Select method" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mobile_money">📱 MTN Mobile Money</SelectItem>
                  <SelectItem value="airtel_money">📱 Airtel Money</SelectItem>
                  <SelectItem value="bank_transfer">🏦 Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(payoutMethod === 'mobile_money' || payoutMethod === 'airtel_money') && (
              <div className="space-y-1.5">
                <Label htmlFor="mobileNum">Mobile Money Number *</Label>
                <Input id="mobileNum" type="tel" placeholder="0783..." value={mobileNumber} onChange={e => setMobileNumber(e.target.value)} />
              </div>
            )}

            {payoutMethod === 'bank_transfer' && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Bank Name *</Label>
                  <Select value={bankName} onValueChange={setBankName}>
                    <SelectTrigger><SelectValue placeholder="Select bank" /></SelectTrigger>
                    <SelectContent>
                      {UGANDA_BANKS.map(bank => (
                        <SelectItem key={bank} value={bank}>{bank}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="accName">Account Name *</Label>
                  <Input id="accName" placeholder="Account holder name" value={accountName} onChange={e => setAccountName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="accNum">Account Number *</Label>
                  <Input id="accNum" placeholder="Account number" value={accountNumber} onChange={e => setAccountNumber(e.target.value)} />
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20">
              <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {/* Submit */}
          <Button type="submit" className="w-full h-12 text-base font-semibold" disabled={!canSubmit || submitting}>
            {submitting ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <UserPlus className="h-5 w-5 mr-2" />}
            {submitting ? 'Submitting...' : 'Submit Registration'}
          </Button>
        </form>

        <AgentFooter agentInfo={agentInfo} />
        <Branding />
      </div>
    </div>
  );
}

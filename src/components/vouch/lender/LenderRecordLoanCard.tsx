import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Banknote, FileText, Loader2, ShieldCheck, Building2, AlertCircle, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useLenderVouchAgreement } from '@/hooks/useLenderVouchAgreement';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import LenderVouchAgreementModal from './LenderVouchAgreementModal';
import { useNavigate } from 'react-router-dom';
import type { TrustProfile } from '@/hooks/useTrustProfile';

interface Props {
  profile: TrustProfile;
}

interface LenderPartner {
  id: string;
  legal_name: string;
  partner_type: string;
  agreement_accepted: boolean;
  is_active: boolean;
  kyc_status: string;
}

/**
 * Lender-facing card on a Welile public profile page.
 * Lets a registered lender record a vouched loan for THIS borrower.
 */
export default function LenderRecordLoanCard({ profile }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { isAccepted: agreementAccepted, acceptAgreement } = useLenderVouchAgreement();

  const [partner, setPartner] = useState<LenderPartner | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAgreementModal, setShowAgreementModal] = useState(false);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Register form
  const [legalName, setLegalName] = useState('');
  const [partnerType, setPartnerType] = useState('individual');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');

  // Loan form
  const [principal, setPrincipal] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [externalRef, setExternalRef] = useState('');
  const [repaymentDate, setRepaymentDate] = useState('');
  const [loanPurpose, setLoanPurpose] = useState('');

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    (async () => {
      const { data } = await (supabase
        .from('lender_partners' as any)
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle() as any);
      if (data) setPartner(data as LenderPartner);
      setLoading(false);
    })();
  }, [user]);

  // Don't show on the borrower's own page
  if (profile.permissions?.is_self) return null;
  if (loading) return null;

  if (!user) {
    return (
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Banknote className="h-4 w-4 text-primary" />
            <p className="text-sm font-bold">Are you a lender?</p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Sign in to register as a Welile Lending Partner and record vouched loans against this Trust Profile.
          </p>
          <Button size="sm" className="w-full" onClick={() => navigate('/auth')}>
            Sign in as Lender
          </Button>
        </CardContent>
      </Card>
    );
  }

  const registerPartner = async () => {
    if (!legalName.trim() || !contactPhone.trim()) {
      toast.error('Legal name and phone are required');
      return;
    }
    setSubmitting(true);
    const { data, error } = await (supabase
      .from('lender_partners' as any)
      .insert({
        user_id: user.id,
        legal_name: legalName.trim(),
        partner_type: partnerType,
        contact_phone: contactPhone.trim(),
        contact_email: contactEmail.trim() || null,
        registration_number: registrationNumber.trim() || null,
      })
      .select()
      .single() as any);
    setSubmitting(false);
    if (error) {
      console.error(error);
      toast.error('Could not register: ' + error.message);
      return;
    }
    setPartner(data as LenderPartner);
    setShowRegisterForm(false);
    toast.success('Lender profile created — now sign the Vouch Agreement');
    setShowAgreementModal(true);
  };

  const recordLoan = async () => {
    if (!partner) return;
    const principalNum = Number(principal);
    if (!principalNum || principalNum <= 0) { toast.error('Enter a valid principal'); return; }
    if (principalNum > profile.trust.borrowing_limit_ugx) {
      const ok = confirm(
        `You're lending ${formatUGX(principalNum)} but Welile only vouches up to ${formatUGX(profile.trust.borrowing_limit_ugx)}. The amount above the vouch is your own risk. Continue?`
      );
      if (!ok) return;
    }
    setSubmitting(true);
    const vouched = Math.min(principalNum, profile.trust.borrowing_limit_ugx);
    const { error } = await (supabase
      .from('vouch_claims' as any)
      .insert({
        lender_partner_id: partner.id,
        borrower_user_id: profile.user_id,
        borrower_ai_id: profile.ai_id,
        principal_ugx: principalNum,
        vouched_amount_ugx: vouched,
        trust_score_at_record: profile.trust.score,
        trust_tier_at_record: profile.trust.tier,
        loan_purpose: loanPurpose.trim() || null,
        expected_repayment_date: repaymentDate || null,
        interest_rate_pct: interestRate ? Number(interestRate) : null,
        external_loan_reference: externalRef.trim() || null,
      }) as any);
    setSubmitting(false);
    if (error) {
      console.error(error);
      toast.error('Could not record loan: ' + error.message);
      return;
    }
    toast.success(`Loan recorded. Welile vouches ${formatUGX(vouched)}.`);
    setShowLoanForm(false);
    setPrincipal(''); setInterestRate(''); setExternalRef(''); setRepaymentDate(''); setLoanPurpose('');
  };

  // Not registered yet
  if (!partner) {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-emerald-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Banknote className="h-4 w-4 text-primary" />
              Lender Tools — Welile Vouches Up To {formatUGX(profile.trust.borrowing_limit_ugx)}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 space-y-3">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Welile guarantees this borrower up to <span className="font-bold text-foreground">{formatUGX(profile.trust.borrowing_limit_ugx)}</span> if you record a loan as a registered Lending Partner. Default risk on the vouched portion is on Welile.
            </p>
            {!showRegisterForm ? (
              <Button size="sm" className="w-full" onClick={() => setShowRegisterForm(true)}>
                <Building2 className="h-4 w-4 mr-1.5" />
                Register as Lending Partner
              </Button>
            ) : (
              <div className="space-y-2 p-3 rounded-lg bg-background border">
                <div>
                  <Label className="text-xs">Legal name *</Label>
                  <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="ABC Microfinance Ltd." className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Partner type</Label>
                  <Select value={partnerType} onValueChange={setPartnerType}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="individual">Individual</SelectItem>
                      <SelectItem value="mfi">Microfinance (MFI)</SelectItem>
                      <SelectItem value="bank">Bank</SelectItem>
                      <SelectItem value="sacco">SACCO</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Contact phone *</Label>
                  <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+256..." className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Contact email</Label>
                  <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Registration / license number</Label>
                  <Input value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowRegisterForm(false)}>Cancel</Button>
                  <Button size="sm" className="flex-1" onClick={registerPartner} disabled={submitting}>
                    {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                    Register
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  // Registered, but agreement not accepted
  if (!agreementAccepted || !partner.agreement_accepted) {
    return (
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <p className="text-sm font-bold">Sign the Lender Vouch Agreement</p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            You're registered as <span className="font-medium text-foreground">{partner.legal_name}</span>. Sign the Welile Lender Vouch Agreement to start recording vouched loans.
          </p>
          <Button size="sm" className="w-full" onClick={() => setShowAgreementModal(true)}>
            <FileText className="h-4 w-4 mr-1.5" />
            Read & Sign Agreement
          </Button>
        </CardContent>
        <LenderVouchAgreementModal
          isOpen={showAgreementModal}
          onClose={() => setShowAgreementModal(false)}
          onAccept={acceptAgreement}
        />
      </Card>
    );
  }

  // Active lender
  return (
    <>
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Lender Tools
              <Badge variant="outline" className="ml-auto text-[10px]">{partner.legal_name}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2 space-y-3">
            <div className="p-3 rounded-lg bg-background/60 border border-border/50">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Welile vouches up to</p>
              <p className="text-2xl font-bold text-emerald-600">{formatUGX(profile.trust.borrowing_limit_ugx)}</p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Score {profile.trust.score} / 100 · {profile.trust.tier}
              </p>
            </div>

            {!showLoanForm ? (
              <Button size="sm" className="w-full" onClick={() => setShowLoanForm(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Record a Vouched Loan
              </Button>
            ) : (
              <div className="space-y-2 p-3 rounded-lg bg-background border">
                <div>
                  <Label className="text-xs">Principal (UGX) *</Label>
                  <Input type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="500000" className="h-8 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Interest %</Label>
                    <Input type="number" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} placeholder="10" className="h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Due date</Label>
                    <Input type="date" value={repaymentDate} onChange={(e) => setRepaymentDate(e.target.value)} className="h-8 text-sm" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Your loan reference</Label>
                  <Input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} placeholder="LN-2026-001" className="h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs">Loan purpose</Label>
                  <Textarea value={loanPurpose} onChange={(e) => setLoanPurpose(e.target.value)} rows={2} className="text-sm resize-none" />
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowLoanForm(false)}>Cancel</Button>
                  <Button size="sm" className="flex-1" onClick={recordLoan} disabled={submitting}>
                    {submitting && <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />}
                    Record Loan
                  </Button>
                </div>
              </div>
            )}

            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Recording a loan creates a vouch claim. If borrower defaults 30+ days, Welile pays you up to the vouched amount.
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  Store, Wallet, HandCoins, ShieldCheck, ChevronLeft, ChevronRight,
  PenLine, CheckCircle2, Loader2, FileText, BadgeCheck, Download,
} from 'lucide-react';
import SignaturePad from '@/components/shared/SignaturePad';
import { downloadMerchantAgreementPdf } from '@/components/merchant/agreement/merchantAgreementPdf';
import { MERCHANT_AGREEMENT_VERSION } from '@/components/merchant/agreement/MerchantAgreementContent';
import welileLogo from '@/assets/welile-contract-logo.png';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_KEY = 'merchant_agent_ref';
const INTAKE_KEY = 'merchant_agent_intake';

const SLIDES = [
  {
    icon: Store,
    title: 'What is a Merchant Agent?',
    body: 'You are Welile\'s trusted cash-out point in your community. You hold Welile FLOAT (company money) and use it to pay users who withdraw from their wallets.',
  },
  {
    icon: Wallet,
    title: 'Welile gives you the float',
    body: 'Welile funds your merchant float. The money is not yours — it belongs to Welile until it is correctly paid out to a verified user.',
  },
  {
    icon: HandCoins,
    title: 'You earn a commission on every payout',
    body: 'For each user withdrawal you successfully complete and verify, Welile pays you a commission straight into your Welile wallet.',
  },
  {
    icon: ShieldCheck,
    title: 'You verify, you protect',
    body: 'Confirm the user\'s identity and the payout amount before releasing cash. Fraud, misuse of float or unverified payouts result in immediate suspension.',
  },
];

/**
 * Public Merchant Agent invitation & contract page. Renders slides explaining
 * the merchant agent role, the full Welile Merchant Agent Agreement, and a
 * name + phone + signature capture. On submit, the intake (name / phone /
 * signature dataURL / referrer) is persisted to localStorage and the visitor
 * is forwarded to the Merchant-Agent-locked signup flow. Once signed in,
 * MerchantAgreementGate reads the intake and records the audited acceptance
 * with the captured signature.
 */
export default function InviteMerchantAgent() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  const rawRef = (params.get('ref') || '').trim();
  const ref = UUID_RX.test(rawRef) ? rawRef : '';

  const [slide, setSlide] = useState(0);
  // Captured in parts; `full_name` stays one concatenated string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const [signature, setSignature] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  // Persist referrer straight away so it survives every downstream bounce.
  useEffect(() => {
    if (ref) {
      try { localStorage.setItem(REF_KEY, ref); } catch { /* ignore */ }
    }
  }, [ref]);

  // If already signed in AND already an active merchant agent, skip to
  // the merchant surface — the contract is only for new applicants.
  useEffect(() => {
    if (loading || !user?.id) return;
    (async () => {
      const { data: ca } = await supabase
        .from('cashout_agents')
        .select('id, is_active')
        .eq('agent_id', user.id)
        .maybeSingle();
      if (ca?.is_active) navigate('/dashboard/agent', { replace: true });
    })();
  }, [user?.id, loading, navigate]);

  const canSubmit =
    validatePersonNameParts(nameParts).valid &&
    /^[+0-9 -]{7,}$/.test(phone.trim()) &&
    !!signature &&
    downloaded;

  const handleDownloadContract = async () => {
    const name = fullName.trim() || 'Merchant Agent';
    try {
      await downloadMerchantAgreementPdf({ name, phone: phone.trim() });
      setDownloaded(true);
      toast.success('Agreement PDF downloaded — please read it before signing.');
    } catch (err) {
      console.warn('[InviteMerchantAgent] download failed', err);
      toast.error('Could not download the PDF. Please try again.');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast.error('Please fill your full name, phone and sign the contract.');
      return;
    }
    setSubmitting(true);
    try {
      const intake = {
        full_name: fullName.trim(),
        phone: phone.trim(),
        signature_data_url: signature,
        agreement_version: MERCHANT_AGREEMENT_VERSION,
        signed_at: new Date().toISOString(),
        ref: ref || null,
      };
      try { localStorage.setItem(INTAKE_KEY, JSON.stringify(intake)); } catch { /* ignore */ }

      // Auto-download the fully-signed contract as a PDF (pixel-identical to preview).
      try {
        await downloadMerchantAgreementPdf({ name: intake.full_name, phone: intake.phone });
        toast.success('Signed agreement downloaded to your device.');
      } catch (dlErr) {
        console.warn('[InviteMerchantAgent] auto-download failed', dlErr);
      }

      if (user?.id) {
        // Signed in already — stamp pending flag and go straight to onboarding.
        if (ref && ref !== user.id) {
          await supabase
            .from('profiles')
            .update({
              pending_merchant_agent: true,
              merchant_agent_referrer_id: ref,
              full_name: intake.full_name,
              phone: intake.phone,
            })
            .eq('id', user.id);
          // Auto-activate as an active Merchant Agent so the dashboard
          // treats them as merchant, not standard agent.
          try {
            await supabase.rpc('auto_activate_merchant_referral', { p_referrer: ref });
          } catch (rpcErr) {
            console.warn('[InviteMerchantAgent] auto-activate failed', rpcErr);
          }
        } else {
          await supabase
            .from('profiles')
            .update({
              pending_merchant_agent: true,
              full_name: intake.full_name,
              phone: intake.phone,
            })
            .eq('id', user.id);
        }
        navigate('/merchant-agent/onboarding', { replace: true });
        return;
      }

      const q = new URLSearchParams({ signup: '1' });
      if (ref) q.set('mref', ref);
      navigate(`/auth?${q.toString()}`, { replace: true });
    } catch (e) {
      console.error('[InviteMerchantAgent] submit', e);
      toast.error('Could not submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const CurrentIcon = SLIDES[slide].icon;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/10 via-background to-background safe-area-top safe-area-bottom">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <img src={welileLogo} alt="Welile" className="h-9 w-auto" />
          <div className="flex-1">
            <h1 className="text-lg font-extrabold leading-tight">Become a Welile Merchant Agent</h1>
            <p className="text-xs text-muted-foreground">Read, sign and submit — approval usually within 24 hours.</p>
          </div>
          <Badge variant="secondary" className="text-[10px]">Agreement {MERCHANT_AGREEMENT_VERSION}</Badge>
        </div>

        {/* Slides */}
        <Card className="p-5 rounded-2xl border-2 border-primary/20 bg-gradient-to-br from-primary/5 to-background">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-primary/15 shrink-0">
              <CurrentIcon className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold uppercase tracking-wider text-primary">
                Step {slide + 1} of {SLIDES.length}
              </p>
              <h2 className="text-lg font-bold mt-1">{SLIDES[slide].title}</h2>
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{SLIDES[slide].body}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between">
            <Button
              variant="ghost" size="sm"
              disabled={slide === 0}
              onClick={() => setSlide((s) => Math.max(0, s - 1))}
            >
              <ChevronLeft className="h-4 w-4 mr-1" /> Back
            </Button>
            <div className="flex gap-1.5">
              {SLIDES.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === slide ? 'w-6 bg-primary' : 'w-1.5 bg-muted'}`}
                />
              ))}
            </div>
            <Button
              variant="ghost" size="sm"
              disabled={slide === SLIDES.length - 1}
              onClick={() => setSlide((s) => Math.min(SLIDES.length - 1, s + 1))}
            >
              Next <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </Card>

        {/* Contract */}
        <Card className="rounded-2xl overflow-hidden border-border/70">
          <div className="px-4 py-3 border-b border-border bg-muted/40 flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <p className="text-sm font-bold flex-1">Welile Merchant Agent Agreement</p>
          </div>
          <div className="p-5 space-y-3 bg-background">
            <p className="text-sm text-muted-foreground leading-relaxed">
              The full Merchant Agent Agreement is provided as a downloadable PDF. Please
              download and read it in full before signing below.
            </p>
            <Button
              type="button"
              variant={downloaded ? 'outline' : 'default'}
              className="w-full h-11 rounded-xl gap-1.5"
              onClick={handleDownloadContract}
            >
              <Download className="h-4 w-4" />
              {downloaded ? 'Download agreement again' : 'Download Agreement PDF'}
            </Button>
            {downloaded && (
              <p className="text-[11px] text-primary font-semibold flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> PDF downloaded. You can now sign below.
              </p>
            )}
          </div>
        </Card>

        {/* Signer details */}
        <Card className="p-5 rounded-2xl space-y-4">
          <div className="flex items-center gap-2">
            <PenLine className="h-4 w-4 text-primary" />
            <h3 className="text-base font-bold">Sign the agreement</h3>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-xs font-semibold">Full legal name</Label>
              <PersonNameFields idPrefix="ma-name" value={nameParts} onChange={setNameParts} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ma-phone" className="text-xs font-semibold">Phone number</Label>
              <Input
                id="ma-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0772 123 456"
                inputMode="tel"
                className="h-11 rounded-xl"
              />
            </div>
          </div>

          <SignaturePad label="Your signature" onChange={setSignature} />

          {/* Stamp preview shown once user has provided name + signature */}
          {signature && fullName.trim() && (
            <div className="relative flex items-center gap-4 p-4 rounded-xl border-2 border-dashed border-primary/40 bg-primary/5">
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Signed by</p>
                <p className="text-sm font-bold truncate">{fullName.trim()}</p>
                <p className="text-xs text-muted-foreground truncate">{phone.trim()}</p>
                <img src={signature} alt="Signature" className="mt-2 h-14 object-contain object-left" />
              </div>
              <div className="shrink-0 relative">
                <div className="w-24 h-24 rounded-full border-4 border-primary/70 flex flex-col items-center justify-center rotate-[-8deg] text-primary bg-background/60">
                  <BadgeCheck className="h-5 w-5" />
                  <span className="text-[9px] font-extrabold tracking-widest mt-0.5">WELILE</span>
                  <span className="text-[8px] font-bold tracking-wider">MERCHANT</span>
                  <span className="text-[8px] font-bold tracking-wider">AGENT</span>
                </div>
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            By tapping <span className="font-semibold">I Agree &amp; Continue</span> you confirm you have read,
            understood and accept the Welile Merchant Agent Agreement ({MERCHANT_AGREEMENT_VERSION}).
            Your signature, name, phone, IP and device are recorded for compliance.
          </p>

          <Button
            className="w-full h-12 rounded-xl text-base font-bold"
            disabled={!canSubmit || submitting}
            onClick={handleSubmit}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
            )}
            I Agree &amp; Continue
          </Button>
        </Card>
      </div>
    </div>
  );
}
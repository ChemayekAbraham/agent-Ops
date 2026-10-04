import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Briefcase, ArrowRight, Shield, Lock, UserPlus, CheckCircle2, ChevronDown, TrendingUp, Sparkles, BadgeCheck, Share2, Link2, Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import BusinessAdvanceStatusTracker, { AdvanceStatusRow, getActiveAdvanceStage } from '@/components/business-advance/BusinessAdvanceStatusTracker';
import { useBusinessAdvanceRealtime } from '@/hooks/useBusinessAdvanceRealtime';
import { BusinessAdvanceAuditLog } from '@/components/business-advance/BusinessAdvanceAuditLog';
import { BusinessAdvanceDocumentUploadPanel } from '@/components/business-advance/DocumentUploadPanel';
import { LiveUpdatingBadge } from '@/components/business-advance/LiveUpdatingBadge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { BusinessAdvanceNotificationPreferences } from '@/components/business-advance/NotificationPreferences';

export default function BusinessAdvanceTrack() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const phone = (params.get('phone') || '').replace(/\s/g, '');

  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState<AdvanceStatusRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);

  // Inline onboarding form state — applicant sets a password to claim the
  // account the agent provisioned for them and is auto-signed-in.
  const [claiming, setClaiming] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);
  const [accountReady, setAccountReady] = useState(false);
  const [trackerOpen, setTrackerOpen] = useState(true);
  const [authedUserId, setAuthedUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const trackerViewLoggedRef = useRef(false);

  const trackingUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/business-advance/track?phone=${encodeURIComponent(phone)}`
    : '';

  const shareMessage = `Get a Rent Business Advance up to UGX 30,000,000 with Welile — your rent history is your collateral. Fast, fair working capital for business owners. Track or apply here: ${trackingUrl}`;

  const logShareEvent = useCallback(
    async (eventType: 'whatsapp_share_click' | 'copy_link_click' | 'tracker_view') => {
      try {
        await supabase.from('business_advance_share_events').insert({
          event_type: eventType,
          phone: phone || null,
          advance_id: row?.id ?? null,
          user_id: authedUserId,
          user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
          referrer: typeof document !== 'undefined' ? (document.referrer || null) : null,
        });
      } catch {
        // analytics is best-effort — never break the page
      }
    },
    [phone, row?.id, authedUserId]
  );

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(trackingUrl);
      setCopied(true);
      toast.success('Tracking link copied');
      setTimeout(() => setCopied(false), 2000);
      void logShareEvent('copy_link_click');
    } catch {
      toast.error('Could not copy link');
    }
  };

  const handleShareWhatsApp = () => {
    const url = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    void logShareEvent('whatsapp_share_click');
  };

  const aliveRef = useRef(true);
  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (aliveRef.current) {
      setIsAuthed(!!user);
      setAuthedUserId(user?.id ?? null);
    }
    if (!phone) {
      if (aliveRef.current) { setError('Missing phone number in the link'); setLoading(false); }
      return;
    }
    const { data, error } = await supabase.rpc('get_business_advance_public_status', { p_phone: phone });
    if (!aliveRef.current) return;
    if (error) {
      setError(error.message);
    } else if (!data || (Array.isArray(data) && data.length === 0)) {
      setError('No Business Advance request found for this number yet.');
    } else {
      const r = Array.isArray(data) ? data[0] : data;
      setRow(r as AdvanceStatusRow);
      setError(null);
    }
    setLoading(false);
  }, [phone]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => { aliveRef.current = false; };
  }, [load]);

  // Fire a one-shot 'tracker_view' analytics event once the live approval
  // tracker has data to display for this phone.
  useEffect(() => {
    if (!row || trackerViewLoggedRef.current) return;
    trackerViewLoggedRef.current = true;
    void logShareEvent('tracker_view');
  }, [row, logShareEvent]);

  // Shared realtime — covers INSERT (request just created) and UPDATE
  // (stage advanced) so the public tracker mirrors the tenant dashboard hero.
  const rtStatus = useBusinessAdvanceRealtime(
    phone ? `public-track-${phone}` : null,
    () => { load(); }
  );

  const handleClaim = async () => {
    if (!otpVerified) return toast.error('Verify the SMS code first');
    if (password.length < 8) return toast.error('Password must be at least 8 characters');
    if (password !== confirmPassword) return toast.error('Passwords do not match');
    setClaiming(true);
    try {
      const { data, error } = await supabase.functions.invoke('claim-business-advance-account', {
        body: { phone, password, full_name: fullName.trim() || undefined },
      });
      if (error) throw error;
      const email = (data as any)?.email;
      if (!email) throw new Error('Could not provision account');
      const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
      if (signInErr) throw signInErr;
      setIsAuthed(true);
      setAccountReady(true);
      toast.success('Account ready — welcome aboard!');
      setTimeout(() => navigate('/dashboard/tenant'), 900);
    } catch (e: any) {
      toast.error(e?.message || 'Could not set up account');
    } finally {
      setClaiming(false);
    }
  };

  const handleSendOtp = async () => {
    setOtpBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'send', phone, category: 'business_claim' },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setOtpSent(true);
      setOtpVerified(false);
      toast.success('Verification code sent by SMS');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not send verification code');
    } finally {
      setOtpBusy(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!/^\d{6}$/.test(otp)) return toast.error('Enter the 6-digit SMS code');
    setOtpBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('sms-otp', {
        body: { action: 'verify', phone, otp, category: 'business_claim' },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Verification failed');
      setOtpVerified(true);
      toast.success('Phone verified');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not verify the code');
    } finally {
      setOtpBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/10 to-background p-4">
      <Helmet>
        <title>Rent Business Advance — Track & Apply | Welile</title>
        <meta
          name="description"
          content="Track or apply for a Welile Rent Business Advance up to UGX 30,000,000. Your verified rent history is your collateral — fast, fair working capital for Ugandan business owners."
        />
        <link rel="canonical" href="https://welileapp.com/business-advance/track" />
        <meta property="og:title" content="Welile Rent Business Advance — Track & Apply" />
        <meta
          property="og:description"
          content="Get working capital up to UGX 30,000,000 with your rent history as collateral. Track every stage live."
        />
        <meta property="og:url" content="https://welileapp.com/business-advance/track" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            mainEntity: [
              {
                '@type': 'Question',
                name: 'How can I access up to UGX 30,000,000?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Your access grows with your verified rent history on Welile. Starter limits begin around UGX 50,000 and climb as you build a clean record of on-time payments, longer tenancy, and trusted landlord relationships — up to UGX 30,000,000 for established business owners.',
                },
              },
              {
                '@type': 'Question',
                name: 'What does "rent history is your collateral" mean?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Every rent payment you make through Welile is recorded, verified, and scored. Instead of demanding land titles or vehicles, we use that proven track record as proof you can repay. Pay rent on time and unlock more working capital.',
                },
              },
              {
                '@type': 'Question',
                name: 'How fast will I get the money?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Most approved advances move from application to disbursement within 24–72 hours. You can track every stage live and get SMS or email updates the moment something changes.',
                },
              },
              {
                '@type': 'Question',
                name: 'How do I repay?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Repayments flow automatically through your Welile wallet alongside your normal rent. On-time repayment further increases your future limit.',
                },
              },
              {
                '@type': 'Question',
                name: 'Is my business information safe?',
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: 'Yes. Welile is built on a fully audited, double-entry ledger with bank-grade security. Only you, your assigned agent, and authorized operations staff can view your file.',
                },
              },
            ],
          })}
        </script>
      </Helmet>
      <div className="max-w-md mx-auto space-y-4 pt-6">
        {/* Marketing hero — modern, professional, business-owner focused */}
        <Card className="relative overflow-hidden border-primary/20 shadow-xl bg-gradient-to-br from-primary via-primary to-primary/80 text-primary-foreground">
          <div className="absolute inset-0 opacity-10 pointer-events-none" aria-hidden>
            <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-card blur-3xl" />
            <div className="absolute bottom-0 left-0 h-32 w-32 rounded-full bg-card blur-2xl" />
          </div>
          <CardContent className="relative p-5 space-y-3">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider bg-white/15 backdrop-blur px-2.5 py-1 rounded-full">
              <Sparkles className="h-3 w-3" /> Rent Business Advance
            </div>
            <div>
              <p className="text-[11px] font-medium opacity-90">Access working capital up to</p>
              <p className="text-3xl font-extrabold tracking-tight leading-none mt-0.5">
                UGX 30,000,000
              </p>
              <p className="text-xs opacity-90 mt-1.5 leading-relaxed">
                Your rent history is your collateral. Turn every receipt into fuel for your business — fast, fair, and built for hardworking owners like you.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1">
              <div className="bg-white/10 backdrop-blur rounded-lg p-2 text-center">
                <TrendingUp className="h-4 w-4 mx-auto mb-0.5" />
                <p className="text-[10px] font-semibold leading-tight">Grow faster</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-2 text-center">
                <BadgeCheck className="h-4 w-4 mx-auto mb-0.5" />
                <p className="text-[10px] font-semibold leading-tight">No bank queues</p>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-lg p-2 text-center">
                <Shield className="h-4 w-4 mx-auto mb-0.5" />
                <p className="text-[10px] font-semibold leading-tight">Trust-scored</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/15 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <p className="text-sm font-bold">How it works — quick FAQ</p>
            </div>
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="q1" className="border-b">
                <AccordionTrigger className="text-xs font-semibold text-left py-3">
                  How can I access up to UGX 30,000,000?
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  Your access grows with your verified rent history on Welile. Starter limits begin around UGX 50,000 and climb as you build a clean record of on-time payments, longer tenancy, and trusted landlord relationships — up to UGX 30,000,000 for established business owners. No bank queues, no paperwork marathons.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="q2" className="border-b">
                <AccordionTrigger className="text-xs font-semibold text-left py-3">
                  What does "rent history is your collateral" mean?
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  Every rent payment you make through Welile is recorded, verified, and scored. Instead of demanding land titles or vehicles, we use that proven track record as proof you can repay. Pay rent on time → unlock more working capital. Your receipts literally become your credit line.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="q3" className="border-b">
                <AccordionTrigger className="text-xs font-semibold text-left py-3">
                  How fast will I get the money?
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  Most approved advances move from application to disbursement within 24–72 hours. You can track every stage live on this page and get SMS or email updates the moment something changes.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="q4" className="border-b">
                <AccordionTrigger className="text-xs font-semibold text-left py-3">
                  How do I repay?
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  Repayments flow automatically through your Welile wallet alongside your normal rent. No new app, no extra trip to the bank — and on-time repayment further increases your future limit.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="q5">
                <AccordionTrigger className="text-xs font-semibold text-left py-3">
                  Is my business information safe?
                </AccordionTrigger>
                <AccordionContent className="text-xs text-muted-foreground leading-relaxed">
                  Yes. Welile is built on a fully audited, double-entry ledger with bank-grade security. Only you, your assigned agent, and authorized operations staff can view your file.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>

        {phone && (
          <Card className="border-primary/20 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Share2 className="h-4 w-4 text-primary" />
                <p className="text-sm font-semibold">Share with a business owner</p>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Spread the word — help another owner access up to UGX 30,000,000 in working capital.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  onClick={handleShareWhatsApp}
                  className="h-10 gap-1.5 bg-[#25D366] hover:bg-[#1ebe5d] text-white"
                >
                  <Share2 className="h-4 w-4" />
                  WhatsApp
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleCopyLink}
                  className="h-10 gap-1.5"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Link2 className="h-4 w-4" />}
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {loading ? (
          <Card><CardContent className="py-10 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></CardContent></Card>
        ) : error ? (
          <Card>
            <CardContent className="p-6 text-center space-y-3">
              <Shield className="h-10 w-10 text-muted-foreground mx-auto" />
              <p className="text-sm">{error}</p>
              <Button variant="outline" onClick={() => navigate('/')}>Go Home</Button>
            </CardContent>
          </Card>
        ) : row ? (
          <>
            <Card className="border-primary/20 shadow-lg">
              <Collapsible open={trackerOpen} onOpenChange={setTrackerOpen}>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-muted/40 transition-colors rounded-t-lg"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Briefcase className="h-5 w-5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <h2 className="text-sm font-bold leading-tight">Rent Business Advance</h2>
                        <p className="text-[11px] text-muted-foreground leading-tight">
                          Live approval progress — tap to {trackerOpen ? 'hide' : 'view'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <LiveUpdatingBadge status={rtStatus} />
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${trackerOpen ? 'rotate-180' : ''}`}
                      />
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-5 pb-5 pt-1 border-t">
                    <BusinessAdvanceStatusTracker row={row} />
                    <div className="mt-3">
                      <BusinessAdvanceAuditLog advanceId={row.id} phone={phone} />
                    </div>
                    {authedUserId && (() => {
                      const stage = getActiveAdvanceStage(row);
                      if (!stage) return null;
                      return (
                        <div className="mt-3">
                          <BusinessAdvanceDocumentUploadPanel
                            advanceId={row.id}
                            tenantId={authedUserId}
                            stageKey={stage.key}
                            stageLabel={stage.label}
                          />
                        </div>
                      );
                    })()}
                    {authedUserId && (
                      <div className="mt-3">
                        <BusinessAdvanceNotificationPreferences userId={authedUserId} />
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </Card>

            {isAuthed || accountReady ? (
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-4 space-y-2 text-center">
                  {accountReady && <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto" />}
                  <p className="text-sm font-semibold">Manage everything from your dashboard</p>
                  <p className="text-xs text-muted-foreground">
                    View payments, make repayments, and unlock more credit.
                  </p>
                  <Button className="w-full gap-2" onClick={() => navigate('/dashboard/tenant')}>
                    Open my dashboard <ArrowRight className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <Card className="border-primary/30 shadow-md">
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <UserPlus className="h-5 w-5 text-primary" />
                    <h3 className="font-bold text-sm">Set up your account</h3>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Your agent has pre-registered you using <strong>{phone}</strong>. Verify this phone, then choose a password to access your dashboard.
                  </p>

                  <div className="space-y-2 rounded-md border p-3">
                    <Label className="text-xs flex items-center gap-1"><Shield className="h-3 w-3" />Phone verification</Label>
                    {!otpSent ? (
                      <Button type="button" variant="outline" className="w-full" onClick={handleSendOtp} disabled={otpBusy}>
                        {otpBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                        Send SMS code
                      </Button>
                    ) : (
                      <div className="flex gap-2">
                        <Input
                          value={otp}
                          onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder="6-digit code"
                          disabled={otpVerified}
                        />
                        <Button type="button" variant={otpVerified ? 'secondary' : 'outline'} onClick={handleVerifyOtp} disabled={otpBusy || otpVerified}>
                          {otpVerified ? 'Verified' : 'Verify'}
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">Your full name (optional)</Label>
                    <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Sarah Nakato" autoComplete="name" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1"><Lock className="h-3 w-3" />Choose a password</Label>
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Confirm password</Label>
                    <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Re-enter password" autoComplete="new-password" />
                  </div>

                  <Button className="w-full h-11 gap-2" onClick={handleClaim} disabled={claiming || !otpVerified}>
                    {claiming ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                    Activate my account
                  </Button>

                  <button
                    type="button"
                    className="w-full text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => navigate(`/auth?phone=${encodeURIComponent(phone)}`)}
                  >
                    I already have an account — sign in instead
                  </button>
                </CardContent>
              </Card>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

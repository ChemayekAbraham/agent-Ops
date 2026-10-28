import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Check, Loader2, MapPin, ShieldCheck, Camera, AlertTriangle, Clock3, LockKeyhole, Smartphone, Mail, Home, CreditCard, UserRound, Users, ScanFace, Fingerprint } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAgentVetting } from '@/hooks/useAgentVetting';
import { useMyIdPhotos } from '@/hooks/useMyIdPhotos';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import IdentityPhotoCapture from '@/components/wallet/IdentityPhotoCapture';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';
import VettingMap from '@/components/agent-vetting/VettingMap';
import { agentVettingRedirect } from '@/hooks/agentVettingAccess';
import {
  VETTING_STATUS_LABEL, canEditVetting, vettingChecklist, vettingProgress, nationalIdOnFile, isLocationFresh,
  type AgentVetting, type VettingStepKey,
} from '@/lib/agentVetting';

type V = ReturnType<typeof useAgentVetting>;

const fmt = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? 'That did not work. Please try again.'));

/** Matches a server "missing" line to the step card it refers to. */
function stepForMissing(text: string): VettingStepKey | null {
  const t = text.toLowerCase();
  if (t.includes('phone') && !t.includes('next of kin')) return 'phone';
  if (t.includes('email')) return 'email';
  if (t.includes('next of kin')) return 'next_of_kin';
  if (t.includes('passport')) return 'passport_photo';
  if (t.includes('national id') || t.includes(' id ') || t.includes('nin')) return 'national_id';
  if (t.includes('location') || t.includes('gps')) return 'location';
  if (t.includes('stay') || t.includes('district') || t.includes('village')) return 'residence';
  return null;
}

const KYC_STEPS: { title: string; description: string; keys: VettingStepKey[]; icon: typeof Smartphone }[] = [
  { title: 'Contact', description: 'Confirm your phone and email with a code.', keys: ['phone', 'email'], icon: Smartphone },
  { title: 'Where you stay', description: 'Choose your district, parish and village.', keys: ['residence'], icon: Home },
  { title: 'Identity document', description: "Use your own National ID or your parent agent's ID.", keys: ['national_id'], icon: CreditCard },
  { title: 'Selfie / passport photo', description: 'Take a clear photo of your face.', keys: ['passport_photo'], icon: ScanFace },
  { title: 'Next of kin', description: 'Confirm who we can contact as your next of kin.', keys: ['next_of_kin'], icon: Users },
  // Last before Review: submit rejects a capture older than gps_rules.max_age_minutes (10), so
  // capturing it early sent agents back here after the ID and selfie steps.
  { title: 'Live location', description: 'Capture your location where you are staying, just before you submit.', keys: ['location'], icon: MapPin },
  { title: 'Review and submit', description: 'Check your details before sending them to Agent Ops.', keys: [], icon: ShieldCheck },
];

// The progress fill travels primary -> orange -> green: the system purple holds
// through the first steps, eases into orange by step 4, stays orange through the
// later steps, and green is saved for the final step.
type Hsl = [number, number, number];
const ORANGE: Hsl = [28, 90, 55];
const PRIMARY_HOLD = 2 / 7; // the true system purple holds through step 2
const ORANGE_AT = 4 / 7; // orange is fully reached at step 4
const GREEN_AT = 6 / 7; // green only begins after step 6
const readHsl = (token: string): Hsl | null => {
  if (typeof window === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const parts = raw.match(/^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null;
};
const blendHsl = (from: Hsl, to: Hsl, t: number): Hsl => {
  // Take the short way round the colour wheel, so purple -> orange runs through red.
  const hueDelta = (((to[0] - from[0] + 540) % 360) - 180) * t;
  return [
    (from[0] + hueDelta + 720) % 360,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ];
};
const progressFill = (ratio: number): CSSProperties | undefined => {
  const primary = readHsl('--primary');
  const success = readHsl('--success');
  if (!primary || !success) return undefined;
  const mixed = ratio <= PRIMARY_HOLD
    ? primary
    : ratio <= ORANGE_AT
      ? blendHsl(primary, ORANGE, (ratio - PRIMARY_HOLD) / (ORANGE_AT - PRIMARY_HOLD))
      : ratio <= GREEN_AT
        ? ORANGE
        : blendHsl(ORANGE, success, (ratio - GREEN_AT) / (1 - GREEN_AT));
  return { backgroundColor: `hsl(${mixed[0]} ${mixed[1]}% ${mixed[2]}%)` };
};

export default function AgentVerification() {
  const v = useAgentVetting();
  const navigate = useNavigate();
  const [submitResult, setSubmitResult] = useState<{ ok: boolean; message?: string; missing?: string[] } | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | (() => void)>(null);
  const [started, setStarted] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [viewOnly, setViewOnly] = useState(false);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const vetting = v.vetting;
  // Completion remains defined by the existing checklist, not by wizard navigation.
  const steps = useMemo(() => vetting ? vettingChecklist(vetting) : [], [vetting]);
  const progress = vettingProgress(steps);
  const done = (index: number) => index === 6 ? false : KYC_STEPS[index].keys.every(key => steps.some(s => s.key === key && s.done));
  const unfinished = KYC_STEPS.findIndex((_, index) => index < 6 && !done(index));
  const allComplete = unfinished < 0;
  const pending = steps.filter(s => !s.done);
  const current = selectedStep ?? (unfinished < 0 ? 6 : unfinished);
  const editable = !!vetting && canEditVetting(vetting.status) && !viewOnly;
  const busy = !!v.busy || !!v.emailSending;

  const goTo = (index: number) => {
    setSelectedStep(index);
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  };
  const guard = (fn: () => void) => {
    if (vetting?.status === 'verified') setConfirmAction(() => fn);
    else fn();
  };
  const act = async (fn: () => Promise<unknown>, success?: string) => {
    try {
      await fn();
      if (success) toast.success(success);
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    }
  };
  const onSubmit = async () => {
    setSubmitResult(null);
    try {
      const result = await v.submit();
      if (result.success === true) setSubmitResult({ ok: true });
      else if ('message' in result) setSubmitResult({ ok: false, message: result.message, missing: result.missing });
      if (result.success) setWizardOpen(false);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const openWizard = (readOnly = false) => {
    setViewOnly(readOnly);
    setWizardOpen(true);
    setStarted(true);
    goTo(readOnly ? 6 : (unfinished < 0 ? 6 : unfinished));
  };
  const redirectTo = agentVettingRedirect(v.applicability);
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const statusScreen = !!vetting && !wizardOpen && (vetting.status !== 'unverified' || submitResult?.ok);
  const untouched = !!vetting && progress.done === 0 && !vetting.residence.district && !vetting.gps.captured_at && !vetting.national_id.source && !vetting.passport_photo.path && !vetting.next_of_kin.name;
  const intro = !!vetting && vetting.status === 'unverified' && untouched && !started;
  const showWizard = !!vetting && !v.isLoading && !v.error && !statusScreen && !intro;

  return (
    <div className="min-h-screen bg-background text-foreground pb-[calc(7rem+env(safe-area-inset-bottom))]">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-5 py-3">
          <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={() => navigate('/dashboard/agent')} aria-label="Back to dashboard"><ArrowLeft className="h-5 w-5" /></Button>
          <div className="flex-1"><p className="text-sm font-semibold">Welile KYC</p><p className="text-xs text-muted-foreground">Identity verification</p></div>
          <Fingerprint className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-5 py-4 sm:py-7">
        {v.isLoading ? <div className="space-y-5" aria-label="Loading verification"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-2 w-full" /><Skeleton className="h-64 w-full rounded-lg" /></div>
          : v.error || !vetting ? <div className="space-y-4"><p className="text-sm">{v.error?.message ?? 'Could not load your verification.'}</p><Button className="min-h-11" onClick={() => v.refresh()}>Retry</Button></div>
          : statusScreen ? <VerificationStatus vetting={vetting} submitted={!!submitResult?.ok} onFix={() => openWizard()} onView={() => openWizard(true)} onEdit={() => guard(() => openWizard())} />
          : intro ? <div className="space-y-7">
            <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-primary/20 bg-primary/5"><ShieldCheck className="h-8 w-8 text-primary" /></div>
            <div className="space-y-3"><h1 className="text-3xl font-semibold">Verify your identity</h1><p className="text-sm leading-relaxed text-muted-foreground">Welile verifies every agent before they can add tenants or post Rent Plan requests.</p><p className="flex items-center gap-2 text-sm"><Clock3 className="h-4 w-4 text-primary" /> About 5 minutes</p></div>
            <div><h2 className="mb-4 text-sm font-semibold">What you'll need</h2><ul className="space-y-4">{[
              [Smartphone, 'Your phone and email'], [Home, 'Where you stay and your live location'], [CreditCard, 'National ID front and back'], [Camera, 'A passport photo'], [Users, 'Your next of kin'],
            ].map(([Icon, label]) => { const ItemIcon = Icon as typeof Smartphone; return <li key={String(label)} className="flex items-center gap-3 text-sm"><ItemIcon className="h-5 w-5 shrink-0 text-primary" />{String(label)}</li>; })}</ul></div>
            <p className="flex items-start gap-2 border-t border-border pt-5 text-sm text-muted-foreground"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-primary" />Your details are only seen by Welile Agent Ops</p>
          </div> : showWizard ? <>
            <div className="mb-5 space-y-2">
              <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">Step {current + 1} of 7</p><Badge variant={vetting.status === 'unverified' ? 'destructive' : 'secondary'}>{VETTING_STATUS_LABEL[vetting.status]}</Badge></div>
              <Progress value={((current + 1) / 7) * 100} aria-label="Verification progress" indicatorStyle={progressFill((current + 1) / 7)} />
            </div>
            <div className="mb-4 space-y-1.5"><h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold outline-none">{KYC_STEPS[current].title}</h1><p className="text-sm leading-relaxed text-muted-foreground">{KYC_STEPS[current].description}</p></div>
            {vetting.status === 'rejected' && vetting.review_note && <div className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 p-3"><p className="text-sm font-semibold text-destructive">What to fix</p><p className="mt-1 whitespace-pre-wrap text-sm">{vetting.review_note}</p></div>}
            {/* Keep step bodies mounted so codes and unsaved inputs survive Back/Edit navigation. */}
            {KYC_STEPS.slice(0, 6).map((s, index) => <section key={s.title} hidden={current !== index} className="space-y-4">{s.keys.map(key => {
              const step = steps.find(item => item.key === key);
              const stepHint = step ? shortStepHint(key, step.hint, vetting) : '';
              return <div key={key} className="space-y-2">{index === 0 && <div className="flex items-center gap-2">{key === 'phone' ? <Smartphone className="h-4 w-4 text-primary" /> : <Mail className="h-4 w-4 text-primary" />}<h2 className="text-sm font-semibold">{step?.label}</h2>{step?.done && <Check className="h-4 w-4 text-primary" />}</div>}{stepHint && <p className="text-sm text-muted-foreground">{stepHint}</p>}<StepBody stepKey={key} v={v} vetting={vetting} editable={editable} guard={guard} act={act} /></div>;
            })}</section>)}
            {current === 6 && !viewOnly && pending.length > 0 && <div className="rounded-lg border border-warning/40 bg-warning/5 p-3"><p className="text-sm font-semibold">Still needed before you can submit</p><ul className="mt-2 space-y-2">{pending.map(s => <li key={s.key}><Button variant="outline" className="min-h-11 h-auto w-full justify-between gap-2 whitespace-normal py-3 text-left" onClick={() => { const target = KYC_STEPS.findIndex(k => k.keys.includes(s.key)); if (target >= 0) goTo(target); }}><span>{s.label}</span><ArrowRight className="h-4 w-4 shrink-0" /></Button></li>)}</ul></div>}
            {current === 6 && <ReviewDetails vetting={vetting} onEdit={index => { if (viewOnly) guard(() => { setViewOnly(false); goTo(index); }); else goTo(index); }} canEdit={canEditVetting(vetting.status)} />}
          </> : null}
      </main>
      {(intro || showWizard) && <footer className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"><div className="mx-auto grid max-w-2xl grid-cols-[auto_1fr] gap-3 px-5 py-4">
        {intro ? <Button className="col-span-2 min-h-12" onClick={() => { setStarted(true); goTo(0); }}>Start verification<ArrowRight className="ml-2 h-4 w-4" /></Button> : <>
          {current === 0 ? <Button variant="outline" className="min-h-12 border-destructive text-destructive hover:bg-destructive/5 hover:text-destructive" disabled={busy} onClick={() => vetting?.status !== 'unverified' ? setWizardOpen(false) : navigate('/dashboard/agent')}><ArrowLeft className="mr-2 h-4 w-4" />Exit</Button> : <Button variant="outline" className="min-h-12 border-primary text-primary hover:bg-primary/5 hover:text-primary" disabled={busy} onClick={() => goTo(current - 1)}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>}
          {current < 6 ? <Button className="min-h-12" disabled={busy} onClick={() => goTo(current + 1)}>Continue<ArrowRight className="ml-2 h-4 w-4" /></Button> : viewOnly ? <Button className="min-h-12" onClick={() => { setWizardOpen(false); setViewOnly(false); }}>Done</Button> : <Button className="min-h-12 whitespace-normal" disabled={busy || !allComplete} onClick={() => guard(onSubmit)}>{v.busy === 'submit' ? <><Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />Checking your location…</> : 'Submit for review'}</Button>}
        </>}
      </div></footer>}
      <Dialog open={!!submitResult && !submitResult.ok} onOpenChange={open => { if (!open) setSubmitResult(null); }}>
        <DialogContent aria-describedby={undefined} className="max-h-[85dvh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-lg"><DialogHeader><DialogTitle>{submitResult?.message}</DialogTitle></DialogHeader><ul className="space-y-2">{(submitResult?.missing ?? []).map((message, index) => <li key={index}><Button variant="outline" className="min-h-11 h-auto w-full justify-between gap-2 whitespace-normal py-3 text-left" onClick={() => { const key = stepForMissing(message); const target = KYC_STEPS.findIndex(s => !!key && s.keys.includes(key)); if (target >= 0) { setSubmitResult(null); goTo(target); } }}><span>{message}</span><ArrowRight className="h-4 w-4 shrink-0" /></Button></li>)}</ul></DialogContent>
      </Dialog>
      <AlertDialog open={!!confirmAction} onOpenChange={open => { if (!open) setConfirmAction(null); }}><AlertDialogContent className="w-[calc(100%-2rem)] max-w-sm rounded-lg"><AlertDialogHeader><AlertDialogTitle>Change your verified details?</AlertDialogTitle><AlertDialogDescription>Changing this sends your verification back to Agent Ops for review. You can't add tenants until they approve it again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel><AlertDialogAction className="min-h-11" onClick={() => { const action = confirmAction; setConfirmAction(null); action?.(); }}>Continue</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}

/** Shorter contact-step wording shown on the wizard; the shared checklist text is left untouched. */
function shortStepHint(key: VettingStepKey, hint: string, vetting: AgentVetting): string {
  if (key === 'phone') return "We'll text a code to confirm it.";
  if (key === 'email') return vetting.email.value ? "We'll email a code to confirm it." : 'Add your email, then confirm with a code.';
  // A location that has gone stale is recaptured with the button below, so no notice is shown.
  if (key === 'location' && vetting.gps.captured_at && !isLocationFresh(vetting)) return '';
  return hint;
}

function VerificationStatus({ vetting, submitted, onFix, onView, onEdit }: { vetting: AgentVetting; submitted: boolean; onFix: () => void; onView: () => void; onEdit: () => void }) {
  const reviewing = submitted || vetting.status === 'submitted';
  const verified = !reviewing && vetting.status === 'verified';
  const Icon = reviewing ? Clock3 : verified ? ShieldCheck : AlertTriangle;
  return <div className="mx-auto flex max-w-md flex-col items-center py-8 text-center">
    <div className="mb-7 flex h-28 w-28 items-center justify-center rounded-full border border-primary/20 bg-primary/5"><Icon className="h-12 w-12 text-primary" strokeWidth={1.5} /></div>
    <Badge variant={reviewing ? 'secondary' : vetting.status === 'unverified' ? 'destructive' : 'secondary'} className="mb-4">{reviewing ? VETTING_STATUS_LABEL.submitted : VETTING_STATUS_LABEL[vetting.status]}</Badge>
    <h1 className="text-3xl font-semibold">{reviewing ? 'Verification in review' : verified ? "You're verified" : 'Action needed'}</h1>
    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{reviewing ? "Agent Ops is checking your details. We'll let you know." : verified ? 'Your identity has been verified by Welile Agent Ops.' : 'Check the note from Agent Ops and update your details.'}</p>
    {!reviewing && !verified && vetting.review_note && <div className="mt-6 w-full rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-left"><p className="text-sm font-semibold text-destructive">Agent Ops review note</p><p className="mt-2 whitespace-pre-wrap text-sm">{vetting.review_note}</p></div>}
    <div className="mt-7 flex w-full flex-col gap-2">{verified ? <><Button variant="outline" className="min-h-12" onClick={onView}>View details</Button><Button variant="link" className="min-h-11" onClick={onEdit}>Edit details</Button></> : !reviewing ? <Button className="min-h-12" onClick={onFix}>Fix and resubmit<ArrowRight className="ml-2 h-4 w-4" /></Button> : <Button variant="outline" className="min-h-12" asChild><Link to="/dashboard/agent">Back to dashboard</Link></Button>}</div>
  </div>;
}

function PassportThumbnail({ path }: { path: string | null }) {
  const { data: url } = useQuery({ queryKey: ['agent-vetting-passport-url', path], enabled: !!path, staleTime: 4 * 60_000, queryFn: () => identityPhotoUrl(path) });
  return url ? <img src={url} alt="Passport photo" className="h-24 w-20 rounded-md border border-border object-cover" /> : <p>{path ? 'Passport photo saved' : 'Not added'}</p>;
}

function OwnIdSummary({ id, compact = false }: { id: AgentVetting['national_id']; compact?: boolean }) {
  const photos = useMyIdPhotos(id);
  const locked = nationalIdOnFile(id).locked;
  const [zoom, setZoom] = useState<string | null>(null);
  return <div className="min-w-0 space-y-3">
    <div className="grid grid-cols-2 gap-2">
      {(['front', 'back'] as const).map(side => {
        const url = photos.data?.[side];
        return <div key={side} className="min-w-0">
          {url ? <Button variant="ghost" className={`h-auto min-h-11 w-full p-0 ${compact ? 'max-w-28' : ''}`} aria-label={`Enlarge National ID ${side}`} onClick={() => setZoom(url)}>
            <img src={url} alt={`National ID ${side}`} className="aspect-[1.586] w-full rounded-md border border-border object-contain" />
          </Button> : <p className="flex min-h-11 items-center text-xs text-muted-foreground">{photos.isLoading ? 'Loading photo…' : id[`has_${side}`] ? `${side === 'front' ? 'Front' : 'Back'} photo saved${photos.isError ? ' · preview unavailable' : ''}` : (locked && side === 'back' ? 'Back photo not required' : `${side === 'front' ? 'Front' : 'Back'} photo missing`)}</p>}
        </div>;
      })}
    </div>
    <div className="space-y-1 break-words text-sm">
      <p>Name on ID: {id.name_on_id ?? 'Not on file'}</p>
      <p className="font-mono">NIN: {id.nin_masked ?? 'Not on file'}</p>
      {id.front_uploaded_at && <p className="text-xs text-muted-foreground">Uploaded {fmt(id.front_uploaded_at)}</p>}
    </div>
    <Dialog open={!!zoom} onOpenChange={open => { if (!open) setZoom(null); }}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-lg">
        <DialogHeader><DialogTitle>National ID photo</DialogTitle></DialogHeader>
        {zoom && <img src={zoom} alt="Enlarged National ID" className="max-h-[70dvh] w-full object-contain" />}
      </DialogContent>
    </Dialog>
  </div>;
}

function ReviewDetails({ vetting: v, onEdit, canEdit }: { vetting: AgentVetting; onEdit: (index: number) => void; canEdit: boolean }) {
  const address = [v.residence.village, v.residence.parish, v.residence.sub_county, v.residence.district, v.residence.region, v.residence.town, v.residence.city].filter(Boolean).join(', ');
  const confirmed = (value: string | null, at: string | null, href?: string | null) => <div className="flex flex-wrap items-center gap-2">{value && href ? <a href={href} className="break-all text-primary underline underline-offset-4">{value}</a> : <span className="break-all">{value ?? 'Not added'}</span>}{at && <span className="inline-flex items-center gap-1 text-xs text-primary"><Check className="h-3.5 w-3.5" />Confirmed</span>}</div>;
  const values = [
    <div className="space-y-2">{confirmed(v.phone.value, v.phone.verified_at, v.phone.value ? `tel:${v.phone.value}` : null)}{confirmed(v.email.value, v.email.verified_at, v.email.value ? `mailto:${v.email.value}` : null)}</div>,
    <p>{address || 'Not added'}</p>,
    v.national_id.source === 'parent' ? <div className="space-y-1"><p>Parent agent's National ID</p><p className="font-mono">{v.national_id.nin_masked ?? 'Not added'}</p><p className="text-xs text-muted-foreground">Front {v.national_id.has_front ? 'saved' : 'missing'} · Back {v.national_id.has_back ? 'saved' : 'missing'}</p></div> : <OwnIdSummary id={v.national_id} compact />,
    <PassportThumbnail path={v.passport_photo.path} />,
    <div className="space-y-1"><p>{v.next_of_kin.name ?? 'Not added'}</p><p>{v.next_of_kin.phone}</p><p className="text-muted-foreground">{v.next_of_kin.source === 'parent_agent' ? 'Parent agent' : v.next_of_kin.relationship}</p></div>,
    <div className="space-y-1"><p className="font-mono">{v.gps.lat !== null && v.gps.lng !== null ? `${v.gps.lat.toFixed(5)}, ${v.gps.lng.toFixed(5)}` : 'Not captured'}</p>{v.gps.accuracy_m != null && <p>Accuracy: {Math.round(v.gps.accuracy_m)} m</p>}{v.gps.captured_at && <p className="text-xs text-muted-foreground">{fmt(v.gps.captured_at)}</p>}</div>,
  ];
  return <div className="space-y-3">{values.map((value, index) => <section key={KYC_STEPS[index].title} className="rounded-lg border border-primary/30 bg-card px-3 py-3"><div className="mb-2 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{KYC_STEPS[index].title}</h2>{canEdit && <Button variant="link" className="min-h-11 shrink-0 px-2" onClick={() => onEdit(index)} aria-label={`Edit ${KYC_STEPS[index].title}`}>Edit</Button>}</div><div className="break-words text-sm">{value}</div></section>)}<p className="flex items-start gap-2 py-3 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="h-4 w-4 shrink-0 text-primary" />Your details are only seen by Welile Agent Ops. Your location is checked again when you submit.</p></div>;
}

type BodyProps = {
  stepKey: VettingStepKey;
  v: V;
  vetting: AgentVetting;
  editable: boolean;
  guard: (fn: () => void) => void;
  act: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
};

function StepBody(p: BodyProps) {
  switch (p.stepKey) {
    case 'phone': return <PhoneStep {...p} />;
    case 'email': return <EmailStep {...p} />;
    case 'residence': return <ResidenceStep {...p} />;
    case 'location': return <LocationStep {...p} />;
    case 'national_id': return <NationalIdStep {...p} />;
    case 'passport_photo': return <PassportStep {...p} />;
    case 'next_of_kin': return <NokStep {...p} />;
  }
}

const Spin = ({ on }: { on: boolean }) => (on ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null);

function CodeRow({ onConfirm, busy, label = 'Confirm' }: { onConfirm: (c: string) => void; busy: boolean; label?: string }) {
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input inputMode="numeric" maxLength={6} aria-label="6-digit code" autoComplete="one-time-code" placeholder="6-digit code" value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-11" />
      <Button variant="soft" className="min-h-11" disabled={busy || code.length !== 6} onClick={() => onConfirm(code)}>
        <Spin on={busy} />{label}
      </Button>
    </div>
  );
}

function PhoneStep({ v, vetting, editable, guard, act }: BodyProps) {
  const [sent, setSent] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <p className="text-sm font-medium">{vetting.phone.value ?? 'No phone number on file'}</p>
        <Link to="/settings" className="inline-flex items-center text-sm text-primary">Edit</Link>
      </div>
      {vetting.phone.verified_at && <p className="text-sm text-muted-foreground">Confirmed {fmt(vetting.phone.verified_at)}</p>}
      {editable && !vetting.phone.verified_at && (
        <>
          <Button variant="soft" className="min-h-11" disabled={v.busy === 'phone_send'}
            onClick={() => guard(async () => { if (await act(() => v.sendPhoneCode(), 'Code sent')) setSent(true); })}>
            <Spin on={v.busy === 'phone_send'} />{sent ? 'Send again' : 'Send code'}
          </Button>
          {sent && <CodeRow busy={v.busy === 'phone_confirm'} onConfirm={(c) => act(() => v.confirmPhoneCode(c), 'Phone confirmed')} />}
        </>
      )}
    </div>
  );
}

function EmailStep({ v, vetting, editable, guard, act }: BodyProps) {
  const [address, setAddress] = useState(vetting.email.value ?? '');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  if (vetting.email.verified_at) {
    return <p className="text-sm"><span className="font-medium">{vetting.email.value}</span> · confirmed {fmt(vetting.email.verified_at)}</p>;
  }
  if (!editable) return <p className="text-sm">{vetting.email.value ?? 'No email yet'}</p>;
  return (
    <div className="space-y-2">
      <Input aria-label="Email address" type="email" placeholder="you@example.com" value={address} onChange={(e) => setAddress(e.target.value)} className="min-h-11" />
      <Button variant="soft" className="min-h-11" disabled={v.emailSending || !address.trim()}
        onClick={() => guard(() => act(async () => {
          const r: any = await v.sendEmailCode(address.trim());
          if (r?.challengeId) setChallengeId(r.challengeId);
        }, 'Code sent'))}>
        <Spin on={!!v.emailSending} />{challengeId ? 'Send again' : 'Send code'}
      </Button>
      {challengeId && <CodeRow busy={v.busy === 'email_confirm'} onConfirm={(c) => act(() => v.confirmEmailCode(challengeId, c), 'Email confirmed')} />}
      {v.emailAttemptsLeft != null && <p className="text-sm text-muted-foreground">{v.emailAttemptsLeft} attempts left</p>}
    </div>
  );
}

function ResidenceStep({ v, vetting, editable, guard, act }: BodyProps) {
  const r = vetting.residence;
  const [loc, setLoc] = useState<UgLocationSelection | null>(null);
  const town = r.town ?? '';
  const city = r.city ?? '';
  const saved = [r.village, r.parish, r.sub_county, r.district, r.region].filter(Boolean).join(', ');
  return (
    <div className="space-y-2">
      {saved && <p className="text-sm"><span className="text-muted-foreground">Saved: </span>{saved}{r.town ? ` · ${r.town}` : ''}{r.city ? ` · ${r.city}` : ''}</p>}
      {editable && (
        <>
          <UgLocationPicker value={loc} onChange={setLoc} label="District to village" required />
          {loc && <p className="text-sm text-muted-foreground">{ugLocationLabel(loc)}</p>}
          <Button className="min-h-11" disabled={!loc || v.busy === 'residence'}
            onClick={() => loc && guard(() => act(() => v.saveResidence({
              region: loc.region, district: loc.district, sub_county: loc.subcounty,
              parish: loc.parish, village: loc.village, town: town.trim() || null, city: city.trim() || null,
            }), 'Saved'))}>
            <Spin on={v.busy === 'residence'} />Save
          </Button>
        </>
      )}
    </div>
  );
}

function LocationStep({ v, vetting, editable, guard, act }: BodyProps) {
  const g = vetting.gps;
  const point = g.lat !== null && g.lng !== null ? { lat: g.lat, lng: g.lng, label: 'You', tone: 'primary' as const } : null;
  const has = !!point;
  return (
    <div className="space-y-2">
      {point && (
        <>
          <p className="text-sm font-mono">{point.lat.toFixed(5)}, {point.lng.toFixed(5)}</p>
          <p className="text-sm text-muted-foreground">
            {g.accuracy_m != null && <>Accurate to {Math.round(g.accuracy_m)} m · </>}{fmt(g.captured_at)}
          </p>
          <VettingMap points={[point]} height={140} />
        </>
      )}
      {editable && (
        <Button className="min-h-11" disabled={v.busy === 'location'} onClick={() => guard(() => act(() => v.captureLocation(), 'Location captured'))}>
          {v.busy === 'location' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MapPin className="h-4 w-4 mr-2" />}
          {has ? 'Capture again' : 'Capture my location'}
        </Button>
      )}
    </div>
  );
}

function NationalIdStep({ v, vetting, editable, guard, act }: BodyProps) {
  const id = vetting.national_id;
  const parent = vetting.parent_agent;
  const link = v.parentIdLink;
  const [captureOpen, setCaptureOpen] = useState(false);
  const usingParent = id.source === 'parent';
  const onFile = nationalIdOnFile(id);
  const parentName = parent?.name ?? 'your parent agent';

  const openCapture = () => guard(() => setCaptureOpen(true));
  const closeCapture = () => { setCaptureOpen(false); v.refresh(); };

  const ended = link?.status && ['rejected_by_owner', 'rejected_by_staff', 'expired', 'cancelled_by_requester'].includes(link.status);

  return (
    <div className="space-y-3">
      {editable && id.can_use_parent && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button variant={!usingParent ? 'default' : 'outline'} className="min-h-11 h-auto whitespace-normal py-3" disabled={v.busy === 'id_source'}
            onClick={() => guard(() => act(() => v.chooseIdSource('own')))}>My own National ID</Button>
          <Button variant={usingParent ? 'default' : 'outline'} className="min-h-11 h-auto whitespace-normal py-3" disabled={v.busy === 'id_source'}
            onClick={() => guard(() => act(() => v.chooseIdSource('parent')))}>Use my parent agent's ID</Button>
        </div>
      )}

      {id.accounts_on_id != null && <p className="text-sm text-muted-foreground">{id.accounts_on_id} of 20 accounts are linked to this ID.</p>}
      {usingParent && id.reason && <p className="text-sm">{id.reason}</p>}
      {!usingParent ? (
        <div className="space-y-4">
          {onFile.state !== 'none' ? <section className="space-y-3 rounded-lg border border-primary/30 bg-card p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">National ID on file</h2>{onFile.locked && <Badge variant="outline" className="border-success/30 bg-success/10 text-success">Verified</Badge>}</div>
            <OwnIdSummary id={id} />
            {onFile.locked && <p className="text-sm leading-relaxed text-muted-foreground">Your National ID has already been verified by Admin. It can't be changed here; contact support if your details are wrong.</p>}
            {!onFile.locked && onFile.state === 'partial' && <ul className="space-y-1 text-sm text-warning">{onFile.missing.map(part => <li key={part}>{part === 'number' ? 'Your National ID number is missing' : part === 'front' ? 'Front photo missing' : 'Back photo missing'}</li>)}</ul>}
            {editable && !onFile.locked && <><Button variant="outline" className="min-h-11 h-auto w-full whitespace-normal" onClick={openCapture}><Camera className="mr-2 h-4 w-4 shrink-0" />{onFile.state === 'complete' ? 'Replace ID photos' : 'Upload missing photos'}</Button><p className="text-xs leading-relaxed text-muted-foreground">To change your ID details, upload new photos. Agent Ops will compare them with the ones on file.</p></>}
          </section> : <>
          <div className="mx-auto flex aspect-[1.586] w-full max-w-sm flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary/40 bg-muted/30 px-3">
            <CreditCard className="h-10 w-10 text-primary" strokeWidth={1.5} />
            <p className="text-sm font-medium">{id.has_front ? 'Back of National ID' : 'Front of National ID'}</p>
            <p className="text-xs text-muted-foreground">Front first, then the back</p>
          </div>
          <ul className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">{['Flat surface', 'Good light', 'All four corners visible', 'No glare'].map(tip => <li key={tip} className="flex items-start gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-primary" />{tip}</li>)}</ul>
          {id.nin_masked ? (
            <>
              <p className="text-sm font-mono">{id.nin_masked}</p>
              <p className="text-sm text-muted-foreground">
                Front photo {id.has_front ? 'saved' : 'missing'} · Back photo {id.has_back ? 'saved' : 'missing'}
              </p>
            </>
          ) : null}
          {editable && <Button variant="soft" className="min-h-11" onClick={openCapture}><Camera className="h-4 w-4 mr-2" />Add my National ID</Button>}
          </>}
          {id.linked_to && (
            <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-1">
              {id.reason && <p className="text-sm">{id.reason}</p>}
              <p className="text-sm">This ID is linked to {id.linked_to.first_name ?? 'another account'} ({id.linked_to.phone_masked ?? ''})</p>
              {editable && id.can_use_parent && (
                <Button variant="link" className="px-0 min-h-11" onClick={() => guard(() => act(() => v.chooseIdSource('parent')))}>
                  Use my parent agent's ID instead
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {link?.status === 'active' ? (
            <p className="text-sm"><span className="font-mono">{link.nin_masked ?? id.nin_masked}</span> · Your parent agent's ID</p>
          ) : link?.status === 'awaiting_owner' && !link.code_verified_at ? (
            <>
              <p className="text-sm">Ask {parentName} for the 6-digit code we sent them.</p>
              {editable && <CodeRow busy={v.busy === 'parent_link_confirm'} onConfirm={(c) => act(() => v.confirmParentIdCode(c), 'Code accepted')} />}
            </>
          ) : link?.status === 'awaiting_owner' || link?.status === 'owner_approved' ? (
            <p className="text-sm">Waiting for {parentName} to approve in their app.</p>
          ) : (
            <>
              {ended && <p className="text-sm">{link?.decision_reason ?? 'This request ended.'}</p>}
              {editable && (
                <div className="flex flex-wrap gap-2">
                  <Button className="min-h-11" disabled={v.busy === 'parent_link'}
                    onClick={() => guard(() => act(() => v.requestParentIdLink(), 'Code sent to your parent agent'))}>
                    <Spin on={v.busy === 'parent_link'} />{ended ? 'Ask again' : `Ask ${parentName}`}
                  </Button>
                  {ended && (
                    <Button variant="outline" className="min-h-11" onClick={() => guard(() => act(() => v.chooseIdSource('own')))}>
                      Use my own ID
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <Dialog open={captureOpen} onOpenChange={(o) => !o && closeCapture()}>
        <DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100%-1rem)] max-w-lg overflow-y-auto rounded-lg [&_button]:min-h-11">
          <DialogHeader><DialogTitle>National ID photos</DialogTitle></DialogHeader>
          <IdentityPhotoCapture />
          <Button variant="outline" className="min-h-11 w-full" onClick={closeCapture}>Done</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PassportStep({ v, vetting, editable, guard }: BodyProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // A just-taken photo waits here for the agent's own review; nothing is
  // uploaded until they press "Use this photo".
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<unknown>(null);
  const check = checkResult ?? vetting.passport_photo.check;
  const grade = check && typeof check === 'object' ? check as { status?: string; verdict?: string; unavailableReason?: string; failures?: { advice?: string }[] } : null;
  const path = vetting.passport_photo.path;
  const { data: url } = useQuery({
    queryKey: ['agent-vetting-passport-url', path],
    enabled: !!path,
    staleTime: 4 * 60_000,
    queryFn: () => identityPhotoUrl(path),
  });

  useEffect(() => () => { if (pendingUrl) URL.revokeObjectURL(pendingUrl); // eslint-disable-line react-hooks/exhaustive-deps
  }, []);

  const stageFile = (f: File | undefined) => {
    if (!f) return;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    setPendingFile(f);
    setPendingUrl(URL.createObjectURL(f));
  };
  const clearPending = () => {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    setPendingFile(null);
    setPendingUrl(null);
  };

  const usePendingPhoto = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    setError(null);
    try {
      const result = await v.savePassportPhoto(file);
      setCheckResult(result);
      toast.success('Passport photo saved');
      clearPending();
    } catch (e) {
      // Keep the shot on screen so they can retry it or take another.
      setError(errMsg(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex justify-center py-5"><div className="relative flex h-56 w-44 items-center justify-center overflow-hidden rounded-[50%] border-2 border-dashed border-primary/40 bg-muted/30">{pendingUrl ? <img src={pendingUrl} alt="New passport photo" className="h-full w-full object-cover" /> : url ? <img src={url} alt="Passport photo" className="h-full w-full object-cover" /> : <UserRound className="h-24 w-24 text-primary/40" strokeWidth={1} />}</div></div>
      <ul className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">{['Face the camera', 'Plain background', 'No hat', 'No glasses'].map(tip => <li key={tip} className="flex items-start gap-1.5"><Check className="h-3.5 w-3.5 shrink-0 text-primary" />{tip}</li>)}</ul>
      {grade && <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm" role="status"><p className="font-medium">{grade.status === 'unavailable' ? 'Photo check unavailable' : grade.verdict === 'review' ? 'Photo saved — Agent Ops will check it' : grade.status === 'no_face' || grade.verdict === 'fail' ? 'Please retake your photo' : grade.status === 'ok' ? 'Face detected — photo check complete' : 'Checking your photo…'}</p>{grade.unavailableReason && <p className="mt-1">{grade.unavailableReason}</p>}{grade.failures?.map((failure, index) => failure.advice ? <p className="mt-1" key={index}>{failure.advice}</p> : null)}</div>}
      {pendingUrl && <p className="text-sm text-muted-foreground">This is what you took. It is not saved yet — use it if it looks right, or retake it.</p>}
      {editable && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden"
            onChange={(e) => { stageFile(e.target.files?.[0]); e.target.value = ''; }} />
          {pendingUrl ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="min-h-12" disabled={v.busy === 'passport_photo'} onClick={() => { clearPending(); guard(() => fileRef.current?.click()); }}>
                <Camera className="h-4 w-4 mr-2" />Retake
              </Button>
              <Button className="min-h-12" disabled={v.busy === 'passport_photo'} onClick={() => guard(() => usePendingPhoto())}>
                {v.busy === 'passport_photo' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
                Use this photo
              </Button>
            </div>
          ) : (
            <Button variant="soft" className="min-h-12 w-full" disabled={v.busy === 'passport_photo'} onClick={() => guard(() => fileRef.current?.click())}>
              {v.busy === 'passport_photo' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
              {path ? 'Take again' : 'Take passport photo'}
            </Button>
          )}
        </>
      )}
      {error && <p className="flex items-start gap-1 text-sm text-destructive"><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />{error}</p>}
    </div>
  );
}

function NokStep({ v, vetting, editable, guard, act }: BodyProps) {
  const nok = vetting.next_of_kin;
  const [editing, setEditing] = useState(nok.source !== 'parent_agent');
  const [name, setName] = useState(nok.source === 'custom' ? nok.name ?? '' : '');
  const [phone, setPhone] = useState(nok.source === 'custom' ? nok.phone ?? '' : '');
  const [relationship, setRelationship] = useState(nok.source === 'custom' ? nok.relationship ?? '' : '');
  useEffect(() => { if (nok.source === 'parent_agent') setEditing(false); }, [nok.source]);

  if (nok.source === 'parent_agent' && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm">{nok.name}, {nok.phone}, Parent agent</p>
        {editable && <Button variant="link" className="px-0 min-h-11" onClick={() => setEditing(true)}>Change</Button>}
      </div>
    );
  }
  if (!editable) return <p className="text-sm">{nok.name ? `${nok.name}, ${nok.phone ?? ''}${nok.relationship ? `, ${nok.relationship}` : ''}` : 'Not added'}</p>;

  return (
    <div className="space-y-2">
      {vetting.parent_agent && (
        <Button variant="outline" className="min-h-11" disabled={v.busy === 'next_of_kin'}
          onClick={() => guard(() => act(() => v.saveNextOfKin({ useParent: true }), 'Saved'))}>
          Use my parent agent
        </Button>
      )}
      <Input aria-label="Next of kin full name" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} className="min-h-11" />
      <Input aria-label="Next of kin phone number" placeholder="Phone number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-11" />
      <Input aria-label="Next of kin relationship" placeholder="Relationship (e.g. sister)" value={relationship} onChange={(e) => setRelationship(e.target.value)} className="min-h-11" />
      <Button className="min-h-11" disabled={v.busy === 'next_of_kin' || !name.trim() || !phone.trim()}
        onClick={() => guard(() => act(() => v.saveNextOfKin({ name: name.trim(), phone: phone.trim(), relationship: relationship.trim() }), 'Saved'))}>
        <Spin on={v.busy === 'next_of_kin'} />Save
      </Button>
    </div>
  );
}

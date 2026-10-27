import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, CheckCircle2, Circle, ChevronDown, Loader2, MapPin, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useAgentVetting, type SubmitResult } from '@/hooks/useAgentVetting';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import {
  VETTING_STATUS_LABEL, canEditVetting, vettingChecklist, vettingProgress,
  type AgentVetting, type VettingStep, type VettingStepKey,
} from '@/lib/agentVetting';
import IdentityPhotoCapture from '@/components/wallet/IdentityPhotoCapture';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import { VettingMap } from '@/components/agent/vetting/VettingMap';

type V = ReturnType<typeof useAgentVetting>;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? 'That did not work. Please try again.'));
const fmt = (iso: string | null) => (iso ? format(new Date(iso), 'd MMM yyyy, h:mm a') : '');

/** Match a server "missing" line to its step by its first words. */
function stepForMissing(text: string): VettingStepKey | null {
  const t = text.toLowerCase();
  if (t.includes('phone') && !t.includes('next of kin') && !t.includes('kin')) return 'phone';
  if (t.includes('email')) return 'email';
  if (t.includes('where you stay') || t.includes('district') || t.includes('village') || t.includes('residence')) return 'residence';
  if (t.includes('location') || t.includes('gps')) return 'location';
  if (t.includes('national id') || t.includes(' id')) return 'national_id';
  if (t.includes('passport') || t.includes('photo')) return 'passport_photo';
  if (t.includes('kin')) return 'next_of_kin';
  return null;
}

function BusyButton({ busy, children, className, ...rest }: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button className={cn('min-h-11', className)} disabled={busy || rest.disabled} {...rest}>
      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </Button>
  );
}

function StepCard({
  step, open, onToggle, children, cardRef,
}: { step: VettingStep; open: boolean; onToggle: () => void; children: ReactNode; cardRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={cardRef} className="rounded-xl border border-border bg-card scroll-mt-20">
      <button type="button" onClick={onToggle} className="flex min-h-14 w-full items-center gap-3 p-4 text-left">
        {step.done ? (
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
        ) : (
          <Circle className="h-5 w-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{step.label}</p>
          {!step.done && step.hint && <p className="mt-0.5 text-sm text-muted-foreground">{step.hint}</p>}
        </div>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="space-y-3 border-t border-border p-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PhoneStep({ v, vetting, editable, guard }: StepProps) {
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <>
      <p className="text-sm text-foreground">{vetting.phone.value ?? 'No phone number on your profile.'}</p>
      {vetting.phone.verified_at && <p className="text-sm text-muted-foreground">Confirmed {fmt(vetting.phone.verified_at)}</p>}
      {editable && (
        <>
          <BusyButton
            variant="outline"
            className="w-full sm:w-auto"
            busy={v.busy === 'phone_send'}
            onClick={() => guard(async () => { await v.sendPhoneCode(); setSent(true); toast.success('Code sent'); })}
          >
            Send code
          </BusyButton>
          {sent && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-11" />
              <BusyButton busy={v.busy === 'phone_confirm'} disabled={code.length !== 6}
                onClick={() => guard(async () => { await v.confirmPhoneCode(code); setCode(''); setSent(false); })}>
                Confirm
              </BusyButton>
            </div>
          )}
          <Link to="/settings" className="inline-block text-sm text-primary underline-offset-4 hover:underline">Change my number</Link>
        </>
      )}
    </>
  );
}

function EmailStep({ v, vetting, editable, guard }: StepProps) {
  const [address, setAddress] = useState(vetting.email.value ?? '');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  return (
    <>
      {vetting.email.value ? (
        <p className="text-sm text-foreground break-all">{vetting.email.value}</p>
      ) : null}
      {vetting.email.verified_at && <p className="text-sm text-muted-foreground">Confirmed {fmt(vetting.email.verified_at)}</p>}
      {editable && (
        <>
          {!vetting.email.value && (
            <div className="space-y-1.5">
              <Label htmlFor="vet-email">Your email address</Label>
              <Input id="vet-email" type="email" value={address} onChange={(e) => setAddress(e.target.value)} className="min-h-11" />
            </div>
          )}
          <BusyButton variant="outline" className="w-full sm:w-auto" busy={v.emailSending}
            disabled={!(vetting.email.value ?? address).trim()}
            onClick={() => guard(async () => {
              const r = await v.sendEmailCode((vetting.email.value ?? address).trim());
              setChallengeId(r.challengeId);
              toast.success('Code sent');
            })}>
            Send code
          </BusyButton>
          {challengeId && (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-11" />
              <BusyButton busy={v.busy === 'email_confirm'} disabled={code.length < 4}
                onClick={() => guard(async () => { await v.confirmEmailCode(challengeId, code); setCode(''); setChallengeId(null); })}>
                Confirm
              </BusyButton>
            </div>
          )}
          {v.emailAttemptsLeft !== null && v.emailAttemptsLeft !== undefined && (
            <p className="text-sm text-muted-foreground">{v.emailAttemptsLeft} attempts left</p>
          )}
        </>
      )}
    </>
  );
}

function ResidenceStep({ v, vetting, editable, guard }: StepProps) {
  const r = vetting.residence;
  const [loc, setLoc] = useState<UgLocationSelection | null>(null);
  const [town, setTown] = useState(r.town ?? '');
  const [city, setCity] = useState(r.city ?? '');
  const saved = [r.village, r.parish, r.sub_county, r.district, r.region].filter(Boolean).join(', ');
  return (
    <>
      {saved && <p className="text-sm text-foreground">{saved}{r.town ? ` · ${r.town}` : ''}{r.city ? ` · ${r.city}` : ''}</p>}
      {editable && (
        <>
          <UgLocationPicker value={loc} onChange={setLoc} label={saved ? 'Change where you stay' : 'Where you stay'} required />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Town (optional)</Label><Input value={town} onChange={(e) => setTown(e.target.value)} maxLength={60} className="min-h-11" /></div>
            <div className="space-y-1.5"><Label>City (optional)</Label><Input value={city} onChange={(e) => setCity(e.target.value)} maxLength={60} className="min-h-11" /></div>
          </div>
          <BusyButton className="w-full sm:w-auto" busy={v.busy === 'residence'} disabled={!loc && !saved}
            onClick={() => guard(() => v.saveResidence(loc ? {
              region: loc.region, district: loc.district, sub_county: loc.subcounty, parish: loc.parish,
              village: loc.village, town: town.trim() || null, city: city.trim() || null,
            } : {
              region: r.region, district: r.district ?? '', sub_county: r.sub_county, parish: r.parish,
              village: r.village ?? '', town: town.trim() || null, city: city.trim() || null,
            }))}>
            Save
          </BusyButton>
        </>
      )}
    </>
  );
}

function LocationStep({ v, vetting, editable, guard }: StepProps) {
  const g = vetting.gps;
  const has = g.lat !== null && g.lng !== null;
  return (
    <>
      {has && (
        <>
          <VettingMap height={160} points={[{ lat: g.lat!, lng: g.lng!, label: 'You', tone: 'primary' }]} />
          <div className="text-sm text-foreground">
            <p>{g.lat!.toFixed(5)}, {g.lng!.toFixed(5)}</p>
            {g.accuracy_m !== null && <p className="text-muted-foreground">Accurate to {Math.round(g.accuracy_m)} m</p>}
            {g.captured_at && <p className="text-muted-foreground">Captured {fmt(g.captured_at)}</p>}
          </div>
        </>
      )}
      {editable && (
        <BusyButton className="w-full sm:w-auto" busy={v.busy === 'location'} onClick={() => guard(() => v.captureLocation())}>
          <MapPin className="mr-2 h-4 w-4" />
          {has ? 'Capture again' : 'Capture my location'}
        </BusyButton>
      )}
    </>
  );
}

function NationalIdStep({ v, vetting, editable, guard }: StepProps) {
  const id = vetting.national_id;
  const link = v.parentIdLink;
  const parentName = vetting.parent_agent?.name ?? 'your parent agent';
  const [mode, setMode] = useState<'own' | 'parent'>(id.source === 'parent' ? 'parent' : 'own');
  const [captureOpen, setCaptureOpen] = useState(false);
  const [code, setCode] = useState('');
  const [capError, setCapError] = useState<string | null>(null);
  const hasOwn = !!id.nin_masked && id.source !== 'parent';
  const ended = link?.status && ['rejected_by_owner', 'rejected_by_staff', 'expired', 'cancelled_by_requester'].includes(link.status);

  const pickOwn = () => guard(async () => { setMode('own'); await v.chooseIdSource('own'); });

  return (
    <>
      {editable && id.can_use_parent && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant={mode === 'own' ? 'default' : 'outline'} className="min-h-11" onClick={pickOwn} disabled={v.busy === 'id_source'}>My own National ID</Button>
          <Button variant={mode === 'parent' ? 'default' : 'outline'} className="min-h-11" onClick={() => setMode('parent')}>Use my parent agent's ID</Button>
        </div>
      )}

      {mode === 'own' && (
        <div className="space-y-3">
          {id.nin_masked && id.source !== 'parent' && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-mono text-foreground">{id.nin_masked}</p>
              <p className="mt-1 text-muted-foreground">
                Front {id.has_front ? 'on file' : 'missing'} · Back {id.has_back ? 'on file' : 'missing'}
              </p>
            </div>
          )}
          {id.linked_to && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
              {id.reason && <p className="text-foreground">{id.reason}</p>}
              <p className="mt-1 text-muted-foreground">
                This ID is linked to {id.linked_to.first_name ?? 'another account'}{id.linked_to.phone_masked ? ` (${id.linked_to.phone_masked})` : ''}
              </p>
              {editable && id.can_use_parent && (
                <Button variant="link" className="h-auto min-h-11 px-0" onClick={() => setMode('parent')}>Use my parent agent's ID instead</Button>
              )}
            </div>
          )}
          {editable && (
            <Button variant="outline" className="min-h-11 w-full sm:w-auto"
              onClick={() => guard(async () => { if (id.source !== 'own') await v.chooseIdSource('own'); setCaptureOpen(true); })}>
              {hasOwn ? 'Re-upload ID photos' : 'Add my National ID photos'}
            </Button>
          )}
        </div>
      )}

      {mode === 'parent' && (
        <div className="space-y-3 text-sm">
          {link?.status === 'active' ? (
            <div className="rounded-lg bg-muted p-3">
              <p className="font-mono text-foreground">{link.nin_masked ?? id.nin_masked}</p>
              <p className="mt-1 text-muted-foreground">Your parent agent's ID</p>
            </div>
          ) : link?.status === 'awaiting_owner' && !link.code_verified_at ? (
            <>
              <p className="text-foreground">Ask {parentName} for the 6-digit code we sent them.</p>
              {editable && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-11" />
                  <BusyButton busy={v.busy === 'parent_link_confirm'} disabled={code.length !== 6}
                    onClick={() => guard(async () => { await v.confirmParentIdCode(code); setCode(''); })}>
                    Confirm
                  </BusyButton>
                </div>
              )}
            </>
          ) : link?.status === 'awaiting_owner' || link?.status === 'owner_approved' ? (
            <p className="text-foreground">Waiting for {parentName} to approve in their app.</p>
          ) : ended ? (
            <>
              <p className="text-foreground">{link?.decision_reason ?? 'This request ended.'}</p>
              {editable && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <BusyButton busy={v.busy === 'parent_link'} onClick={() => guard(async () => {
                    setCapError(null);
                    try { await v.requestParentIdLink(); } catch (e) { setCapError(errMsg(e)); throw e; }
                  })}>Ask again</BusyButton>
                  <Button variant="outline" className="min-h-11" onClick={pickOwn}>Use my own ID</Button>
                </div>
              )}
            </>
          ) : (
            editable && (
              <BusyButton className="w-full sm:w-auto" busy={v.busy === 'parent_link'} onClick={() => guard(async () => {
                setCapError(null);
                try { await v.requestParentIdLink(); } catch (e) { setCapError(errMsg(e)); throw e; }
              })}>
                Ask {parentName}
              </BusyButton>
            )
          )}
          {capError && (
            <div className="space-y-1">
              <p className="text-destructive">{capError}</p>
              {editable && <Button variant="link" className="h-auto min-h-11 px-0" onClick={pickOwn}>Use my own ID</Button>}
            </div>
          )}
        </div>
      )}

      <Dialog open={captureOpen} onOpenChange={(o) => { setCaptureOpen(o); if (!o) v.refresh(); }}>
        <DialogContent className="max-h-[90vh] max-w-[calc(100vw-1rem)] overflow-y-auto p-3 sm:max-w-lg sm:p-6">
          <DialogHeader><DialogTitle>National ID photos</DialogTitle></DialogHeader>
          <IdentityPhotoCapture />
        </DialogContent>
      </Dialog>
    </>
  );
}

function PassportStep({ v, vetting, editable, guard }: StepProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const path = vetting.passport_photo.path;
  const url = useQuery({
    queryKey: ['agent-vetting-own-passport', path],
    enabled: !!path,
    staleTime: 4 * 60_000,
    queryFn: () => identityPhotoUrl(path),
  });
  return (
    <>
      {url.data && <img src={url.data} alt="Your passport photo" className="h-32 w-28 rounded-lg border border-border object-cover" />}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {editable && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setError(null);
              guard(async () => {
                try { await v.savePassportPhoto(f); } catch (err) { setError(errMsg(err)); }
              });
            }} />
          <BusyButton className="w-full sm:w-auto" busy={v.busy === 'passport_photo'} onClick={() => fileRef.current?.click()}>
            {path ? 'Retake passport photo' : 'Take passport photo'}
          </BusyButton>
        </>
      )}
    </>
  );
}

function NextOfKinStep({ v, vetting, editable, guard }: StepProps) {
  const nok = vetting.next_of_kin;
  const [editing, setEditing] = useState(nok.source !== 'parent_agent');
  const [name, setName] = useState(nok.source === 'custom' ? nok.name ?? '' : '');
  const [phone, setPhone] = useState(nok.source === 'custom' ? nok.phone ?? '' : '');
  const [rel, setRel] = useState(nok.source === 'custom' ? nok.relationship ?? '' : '');

  if (nok.source === 'parent_agent' && !editing) {
    return (
      <div className="text-sm">
        <p className="text-foreground">{nok.name}, {nok.phone}, Parent agent</p>
        {editable && <Button variant="link" className="h-auto min-h-11 px-0" onClick={() => setEditing(true)}>Change</Button>}
      </div>
    );
  }
  if (!editable) {
    return nok.name ? <p className="text-sm text-foreground">{nok.name}, {nok.phone}{nok.relationship ? `, ${nok.relationship}` : ''}</p> : null;
  }
  return (
    <>
      {vetting.parent_agent && (
        <BusyButton variant="outline" className="w-full sm:w-auto" busy={v.busy === 'next_of_kin'}
          onClick={() => guard(async () => { await v.saveNextOfKin({ useParent: true }); setEditing(false); })}>
          Use my parent agent
        </BusyButton>
      )}
      <div className="space-y-3">
        <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-h-11" /></div>
        <div className="space-y-1.5"><Label>Phone</Label><Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} className="min-h-11" /></div>
        <div className="space-y-1.5"><Label>Relationship</Label><Input value={rel} onChange={(e) => setRel(e.target.value)} maxLength={40} placeholder="e.g. Sister" className="min-h-11" /></div>
      </div>
      <BusyButton className="w-full sm:w-auto" busy={v.busy === 'next_of_kin'} disabled={!name.trim() || !phone.trim()}
        onClick={() => guard(() => v.saveNextOfKin({ name: name.trim(), phone: phone.trim(), relationship: rel.trim() }))}>
        Save
      </BusyButton>
    </>
  );
}

type StepProps = {
  v: V;
  vetting: AgentVetting;
  editable: boolean;
  /** Runs an action, warning first when it would reopen a verified record. Errors become toasts. */
  guard: (fn: () => Promise<unknown>) => void;
};

const STEP_BODY: Record<VettingStepKey, (p: StepProps) => JSX.Element> = {
  phone: PhoneStep,
  email: EmailStep,
  residence: ResidenceStep,
  location: LocationStep,
  national_id: NationalIdStep,
  passport_photo: PassportStep,
  next_of_kin: NextOfKinStep,
};

// ---------------------------------------------------------------------------

export default function AgentVerification() {
  const v = useAgentVetting();
  const navigate = useNavigate();
  const vetting = v.vetting;
  const [open, setOpen] = useState<VettingStepKey | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [pending, setPending] = useState<(() => Promise<unknown>) | null>(null);
  const cards = useRef<Partial<Record<VettingStepKey, HTMLDivElement | null>>>({});

  const steps = useMemo(() => (vetting ? vettingChecklist(vetting) : []), [vetting]);
  const progress = vettingProgress(steps);

  useEffect(() => {
    if (open === null && steps.length) setOpen(steps.find((s) => !s.done)?.key ?? null);
    // only on first load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);

  const runSafe = (fn: () => Promise<unknown>) => {
    fn().catch((e) => toast.error(errMsg(e)));
  };
  const guard = (fn: () => Promise<unknown>) => {
    if (vetting?.status === 'verified') setPending(() => fn);
    else runSafe(fn);
  };

  const goTo = (key: VettingStepKey) => {
    setOpen(key);
    requestAnimationFrame(() => cards.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const onSubmit = async () => {
    setResult(null);
    try {
      setResult(await v.submit());
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const header = (
    <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
      <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate('/dashboard/agent')} aria-label="Back">
        <ArrowLeft className="h-5 w-5" />
      </Button>
      <h1 className="text-base font-semibold text-foreground">Agent verification</h1>
    </div>
  );

  if (v.isLoading) {
    return (
      <div className="min-h-screen bg-background">
        {header}
        <div className="mx-auto max-w-5xl space-y-3 p-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          {Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (v.error || !vetting) {
    return (
      <div className="min-h-screen bg-background">
        {header}
        <div className="mx-auto max-w-md space-y-3 p-6 text-center">
          <p className="text-sm text-foreground">{v.error?.message ?? 'We could not load your verification.'}</p>
          <Button className="min-h-11" onClick={() => v.refresh()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
        </div>
      </div>
    );
  }

  const editable = canEditVetting(vetting.status);

  if (result?.success) {
    return (
      <div className="min-h-screen bg-background">
        {header}
        <div className="mx-auto flex max-w-md flex-col items-center gap-4 p-8 text-center">
          <CheckCircle2 className="h-14 w-14 text-success" />
          <p className="text-lg font-semibold text-foreground">Sent to Agent Ops. We'll let you know when you're verified.</p>
          <Button className="min-h-11 w-full" onClick={() => navigate('/dashboard/agent')}>Back to dashboard</Button>
        </div>
      </div>
    );
  }

  const statusTone =
    vetting.status === 'verified' ? 'bg-success/15 text-success border-success/30'
      : vetting.status === 'rejected' ? 'bg-destructive/10 text-destructive border-destructive/30'
        : vetting.status === 'submitted' ? 'bg-primary/10 text-primary border-primary/30'
          : 'bg-muted text-muted-foreground border-border';

  const summary = (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant="outline" className={cn('text-xs', statusTone)}>{VETTING_STATUS_LABEL[vetting.status]}</Badge>
        <span className="text-sm text-muted-foreground">{progress.done} of {progress.total} done</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
      </div>
      {!vetting.enforced && vetting.enforce_from && (
        <p className="text-sm text-muted-foreground">
          From {format(new Date(vetting.enforce_from), 'd MMM yyyy')}, you need to be verified to add tenants.
        </p>
      )}
      {vetting.status === 'rejected' && vetting.review_note && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-semibold text-destructive">What to fix</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{vetting.review_note}</p>
        </div>
      )}
      {!editable && <p className="text-sm text-foreground">Agent Ops is reviewing your details. We'll let you know.</p>}
      {result && !result.success && (
        <div className="rounded-lg border border-border bg-muted/50 p-3">
          <p className="text-sm font-semibold text-foreground">{result.message}</p>
          <ul className="mt-2 space-y-1">
            {result.missing.map((m, i) => {
              const key = stepForMissing(m);
              return (
                <li key={i}>
                  {key ? (
                    <button type="button" className="min-h-9 text-left text-sm text-primary underline-offset-4 hover:underline" onClick={() => goTo(key)}>{m}</button>
                  ) : (
                    <span className="text-sm text-foreground">{m}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {editable && (
        <BusyButton className="hidden w-full md:flex" busy={v.busy === 'submit'} onClick={onSubmit}>
          {v.busy === 'submit' ? 'Checking your location…' : 'Submit for review'}
        </BusyButton>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-28 md:pb-8">
      {header}
      <div className="mx-auto grid max-w-5xl gap-4 p-4 md:grid-cols-[1fr_320px]">
        <div className="space-y-3 md:order-1">
          <div className="md:hidden">{summary}</div>
          {steps.map((s) => {
            const Body = STEP_BODY[s.key];
            return (
              <StepCard key={s.key} step={s} open={open === s.key}
                onToggle={() => setOpen(open === s.key ? null : s.key)}
                cardRef={(el) => { cards.current[s.key] = el; }}>
                <Body v={v} vetting={vetting} editable={editable} guard={guard} />
              </StepCard>
            );
          })}
        </div>
        <div className="hidden md:order-2 md:block">
          <div className="sticky top-16">{summary}</div>
        </div>
      </div>

      {editable && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 p-3 backdrop-blur md:hidden">
          <BusyButton className="w-full" busy={v.busy === 'submit'} onClick={onSubmit}>
            {v.busy === 'submit' ? 'Checking your location…' : 'Submit for review'}
          </BusyButton>
        </div>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Change your verified details?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing this sends your verification back to Agent Ops for review. You can't add tenants until they approve it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => { const fn = pending; setPending(null); if (fn) runSafe(fn); }}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

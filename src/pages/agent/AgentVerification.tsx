import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Circle, Loader2, MapPin, ShieldCheck, Camera, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAgentVetting } from '@/hooks/useAgentVetting';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import IdentityPhotoCapture from '@/components/wallet/IdentityPhotoCapture';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import { ugLocationLabel, type UgLocationSelection } from '@/hooks/useUgLocations';
import VettingMap from '@/components/agent-vetting/VettingMap';
import {
  VETTING_STATUS_LABEL, canEditVetting, vettingChecklist, vettingProgress,
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

export default function AgentVerification() {
  const v = useAgentVetting();
  const navigate = useNavigate();
  const [submitResult, setSubmitResult] = useState<{ ok: true } | { ok: false; message: string; missing: string[] } | null>(null);
  const [confirmAction, setConfirmAction] = useState<null | (() => void)>(null);
  const cardRefs = useRef<Partial<Record<VettingStepKey, HTMLDivElement | null>>>({});

  const vetting = v.vetting;
  const steps = useMemo(() => (vetting ? vettingChecklist(vetting) : []), [vetting]);
  const progress = vettingProgress(steps);
  const editable = vetting ? canEditVetting(vetting.status) : false;

  /** Wraps a write; warns first when the record is already verified. */
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
      const r = await v.submit();
      setSubmitResult(r.success ? { ok: true } : { ok: false, message: r.message, missing: r.missing });
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const scrollTo = (k: VettingStepKey | null) => {
    if (k) cardRefs.current[k]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen bg-background pb-28 md:pb-8">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate('/dashboard/agent')} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">Agent verification</h1>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-3 py-4">
        {v.isLoading ? (
          <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
        ) : v.error || !vetting ? (
          <div className="rounded-xl border border-border bg-card p-4 space-y-3">
            <p className="text-sm">{v.error?.message ?? 'Could not load your verification.'}</p>
            <Button className="min-h-11" onClick={() => v.refresh()}>Retry</Button>
          </div>
        ) : submitResult?.ok ? (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-6 text-center space-y-3">
            <ShieldCheck className="mx-auto h-10 w-10 text-primary" />
            <p className="text-base font-semibold">Sent to Agent Ops. We'll let you know when you're verified.</p>
            <Button className="min-h-11" onClick={() => navigate('/dashboard/agent')}>Back to dashboard</Button>
          </div>
        ) : (
          <div className="md:grid md:grid-cols-[1fr_300px] md:gap-4">
            <div className="space-y-3">
              <StatusHeader vetting={vetting} done={progress.done} total={progress.total} />
              {!editable && (
                <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
                  Agent Ops is reviewing your details. We'll let you know.
                </p>
              )}
              {steps.map((s) => (
                <div key={s.key} ref={(el) => (cardRefs.current[s.key] = el)} className="scroll-mt-20">
                  <StepCard label={s.label} done={s.done} hint={s.hint}>
                    <StepBody stepKey={s.key} v={v} vetting={vetting} editable={editable} guard={guard} act={act} />
                  </StepCard>
                </div>
              ))}
            </div>

            {editable && (
              <aside className="md:sticky md:top-20 md:self-start">
                {submitResult && !submitResult.ok && (
                  <div className="mt-3 md:mt-0 rounded-xl border border-border bg-card p-3 space-y-2">
                    <p className="text-sm font-semibold">{submitResult.message}</p>
                    <ul className="space-y-1">
                      {submitResult.missing.map((m, i) => (
                        <li key={i}>
                          <button className="text-left text-sm text-primary underline-offset-2 hover:underline min-h-11" onClick={() => scrollTo(stepForMissing(m))}>
                            {m}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background p-3 md:static md:mt-3 md:border-0 md:p-0">
                  <div className="mx-auto max-w-5xl md:max-w-none">
                    <p className="hidden md:block mb-2 text-sm text-muted-foreground">{progress.done} of {progress.total} done</p>
                    <Button className="w-full min-h-12" onClick={() => guard(onSubmit)} disabled={v.busy === 'submit'}>
                      {v.busy === 'submit' ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Checking your location…</> : 'Submit for review'}
                    </Button>
                  </div>
                </div>
              </aside>
            )}
          </div>
        )}
      </main>

      <AlertDialog open={!!confirmAction} onOpenChange={(o) => !o && setConfirmAction(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Change your verified details?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing this sends your verification back to Agent Ops for review. You can't add tenants until they approve it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <AlertDialogAction className="min-h-11" onClick={() => { const f = confirmAction; setConfirmAction(null); f?.(); }}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusHeader({ vetting, done, total }: { vetting: AgentVetting; done: number; total: number }) {
  const rejected = vetting.status === 'rejected';
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge variant={rejected ? 'destructive' : vetting.status === 'verified' ? 'default' : 'secondary'}>
          {VETTING_STATUS_LABEL[vetting.status]}
        </Badge>
        <span className="text-sm text-muted-foreground">{done} of {total} done</span>
      </div>
      {!vetting.enforced && vetting.enforce_from && (
        <p className="text-sm text-muted-foreground">
          From {new Date(vetting.enforce_from).toLocaleDateString('en-GB', { dateStyle: 'medium' })}, you need to be verified to add tenants.
        </p>
      )}
      {rejected && vetting.review_note && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-semibold text-destructive">What to fix</p>
          <p className="text-sm whitespace-pre-wrap">{vetting.review_note}</p>
        </div>
      )}
    </div>
  );
}

function StepCard({ label, done, hint, children }: { label: string; done: boolean; hint: string | null; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        {done ? <Check className="h-5 w-5 text-primary" /> : <Circle className="h-5 w-5 text-muted-foreground" />}
        <h2 className="text-base font-semibold">{label}</h2>
      </div>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
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
      <Input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-11" />
      <Button className="min-h-11" disabled={busy || code.length !== 6} onClick={() => onConfirm(code)}>
        <Spin on={busy} />{label}
      </Button>
    </div>
  );
}

function PhoneStep({ v, vetting, editable, guard, act }: BodyProps) {
  const [sent, setSent] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{vetting.phone.value ?? 'No phone number on file'}</p>
      {vetting.phone.verified_at && <p className="text-sm text-muted-foreground">Confirmed {fmt(vetting.phone.verified_at)}</p>}
      {editable && !vetting.phone.verified_at && (
        <>
          <Button variant="outline" className="min-h-11" disabled={v.busy === 'phone_send'}
            onClick={() => guard(async () => { if (await act(() => v.sendPhoneCode(), 'Code sent')) setSent(true); })}>
            <Spin on={v.busy === 'phone_send'} />{sent ? 'Send again' : 'Send code'}
          </Button>
          {sent && <CodeRow busy={v.busy === 'phone_confirm'} onConfirm={(c) => act(() => v.confirmPhoneCode(c), 'Phone confirmed')} />}
        </>
      )}
      <Link to="/settings" className="inline-block text-sm text-primary min-h-11 py-3">Change my number</Link>
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
      <Input type="email" placeholder="you@example.com" value={address} onChange={(e) => setAddress(e.target.value)} className="min-h-11" />
      <Button variant="outline" className="min-h-11" disabled={v.emailSending || !address.trim()}
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
  const [town, setTown] = useState(r.town ?? '');
  const [city, setCity] = useState(r.city ?? '');
  const saved = [r.village, r.parish, r.sub_county, r.district, r.region].filter(Boolean).join(', ');
  return (
    <div className="space-y-2">
      {saved && <p className="text-sm"><span className="text-muted-foreground">Saved: </span>{saved}{r.town ? ` · ${r.town}` : ''}{r.city ? ` · ${r.city}` : ''}</p>}
      {editable && (
        <>
          <UgLocationPicker value={loc} onChange={setLoc} label="District to village" required />
          {loc && <p className="text-sm text-muted-foreground">{ugLocationLabel(loc)}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Town (optional)" value={town} onChange={(e) => setTown(e.target.value)} className="min-h-11" />
            <Input placeholder="City (optional)" value={city} onChange={(e) => setCity(e.target.value)} className="min-h-11" />
          </div>
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
  const has = g.lat !== null && g.lng !== null;
  return (
    <div className="space-y-2">
      {has && (
        <>
          <p className="text-sm font-mono">{g.lat!.toFixed(5)}, {g.lng!.toFixed(5)}</p>
          <p className="text-sm text-muted-foreground">
            {g.accuracy_m != null && <>Accurate to {Math.round(g.accuracy_m)} m · </>}{fmt(g.captured_at)}
          </p>
          <VettingMap points={[{ lat: g.lat!, lng: g.lng!, label: 'You', tone: 'primary' }]} height={140} />
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
  const parentName = parent?.name ?? 'your parent agent';

  const openCapture = () => guard(() => setCaptureOpen(true));
  const closeCapture = () => { setCaptureOpen(false); v.refresh(); };

  const ended = link?.status && ['rejected_by_owner', 'rejected_by_staff', 'expired', 'cancelled_by_requester'].includes(link.status);

  return (
    <div className="space-y-3">
      {editable && id.can_use_parent && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant={!usingParent ? 'default' : 'outline'} className="min-h-11" disabled={v.busy === 'id_source'}
            onClick={() => guard(() => act(() => v.chooseIdSource('own')))}>My own National ID</Button>
          <Button variant={usingParent ? 'default' : 'outline'} className="min-h-11" disabled={v.busy === 'id_source'}
            onClick={() => guard(() => act(() => v.chooseIdSource('parent')))}>Use my parent agent's ID</Button>
        </div>
      )}

      {!usingParent ? (
        <div className="space-y-2">
          {id.nin_masked ? (
            <>
              <p className="text-sm font-mono">{id.nin_masked}</p>
              <p className="text-sm text-muted-foreground">
                Front {id.has_front ? '✓' : '—'} · Back {id.has_back ? '✓' : '—'}
              </p>
            </>
          ) : null}
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
          {editable && (
            <Button variant="outline" className="min-h-11" onClick={openCapture}>
              <Camera className="h-4 w-4 mr-2" />{id.nin_masked ? 'Re-upload ID photos' : 'Add my National ID'}
            </Button>
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
        <DialogContent className="max-h-[90vh] overflow-y-auto">
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
  const path = vetting.passport_photo.path;
  const { data: url } = useQuery({
    queryKey: ['agent-vetting-passport-url', path],
    enabled: !!path,
    staleTime: 4 * 60_000,
    queryFn: () => identityPhotoUrl(path),
  });

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      await v.savePassportPhoto(f);
      toast.success('Passport photo saved');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="space-y-2">
      {url && <img src={url} alt="Passport photo" className="h-32 w-28 rounded-lg border border-border object-cover" />}
      {editable && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden"
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Button variant="outline" className="min-h-11" disabled={v.busy === 'passport_photo'} onClick={() => guard(() => fileRef.current?.click())}>
            {v.busy === 'passport_photo' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
            {path ? 'Take again' : 'Take passport photo'}
          </Button>
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
      <Input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} className="min-h-11" />
      <Input placeholder="Phone number" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="min-h-11" />
      <Input placeholder="Relationship (e.g. sister)" value={relationship} onChange={(e) => setRelationship(e.target.value)} className="min-h-11" />
      <Button className="min-h-11" disabled={v.busy === 'next_of_kin' || !name.trim() || !phone.trim()}
        onClick={() => guard(() => act(() => v.saveNextOfKin({ name: name.trim(), phone: phone.trim(), relationship: relationship.trim() }), 'Saved'))}>
        <Spin on={v.busy === 'next_of_kin'} />Save
      </Button>
    </div>
  );
}

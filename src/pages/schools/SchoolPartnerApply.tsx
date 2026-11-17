import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, CheckCircle2, Loader2, LogIn, MapPin, Phone, Send, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import { UG_REGIONS, useUgDistricts } from '@/hooks/useUgLocations';
import { captureSmartLocation } from '@/hooks/useSmartLocation';
import { SCHOOL_LEVELS, SCHOOL_OWNERSHIP } from '@/lib/welileSchools';
import { cn } from '@/lib/utils';
import {
  CONTACT_ROLES, OFFERS_OPTIONS, applicationErrorMessage, applicationErrors, emptyApplication, fetchMyApplications,
  isOpenApplication, ownerStatusLabel, submitApplication, withdrawApplication,
  type ApplicationDraft, type MyApplication,
} from '@/lib/welileSchoolsApplications';

const LEVELS = [...SCHOOL_LEVELS, 'Mixed / K-12'];
const APPLY_PATH = '/schools/apply';

/**
 * /schools/apply — a school owner applies to partner with Welile. Agent Ops reviews the application
 * and sends a Welile agent to inspect the school and set up the partnership.
 */
export default function SchoolPartnerApply() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  return (
    <div className="min-h-screen bg-background pb-10">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11 rounded-full" aria-label="Back to Welile Schools" onClick={() => navigate('/schools?role=school')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <WelileSchoolsBrand />
        </div>
      </header>

      <main className="mx-auto max-w-xl space-y-4 px-3 pt-3">
        <div className="rounded-3xl bg-gradient-to-br from-primary to-primary/80 p-4 text-primary-foreground shadow-sm">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15"><Building2 className="h-6 w-6" aria-hidden /></span>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight">Apply to partner with Welile</h1>
              <p className="text-sm text-primary-foreground/85">Tell us about your school. Welile reviews it and sends an agent to visit and set up the partnership.</p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : !user ? (
          <section className="space-y-3 rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
            <h2 className="text-base font-semibold">Sign in to apply</h2>
            <p className="text-sm text-muted-foreground">Use your phone number. Welile uses your account to keep you updated on the application.</p>
            <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(APPLY_PATH)}`)}>
              <LogIn className="h-5 w-5" />Sign in to apply
            </Button>
          </section>
        ) : (
          <SignedInApply userId={user.id} />
        )}
      </main>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-primary/10 text-primary',
  agent_assigned: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  inspecting: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  declined: 'bg-destructive/10 text-destructive',
  withdrawn: 'bg-muted text-muted-foreground',
};

function toneFor(a: MyApplication) {
  if (a.status === 'inspecting' && a.partnership_status === 'approved') return STATUS_TONE.approved;
  if (a.status === 'inspecting' && (a.partnership_status === 'rejected' || a.partnership_status === 'suspended')) return STATUS_TONE.declined;
  return STATUS_TONE[a.status];
}

function SignedInApply({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['welile-school-applications-mine', userId], queryFn: fetchMyApplications, retry: 1 });
  const [showForm, setShowForm] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const list = mine.data ?? [];
  const hasAny = list.length > 0;
  const formOpen = showForm || (!hasAny && !mine.isLoading && !sent);

  const withdraw = async (a: MyApplication) => {
    try {
      await withdrawApplication(a.id);
      toast.success('Application withdrawn');
      qc.invalidateQueries({ queryKey: ['welile-school-applications-mine', userId] });
    } catch (e) {
      toast.error('Could not withdraw', { description: applicationErrorMessage(e) });
    }
  };

  if (mine.isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      {sent && (
        <p className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
          <span><span className="font-semibold">Application sent.</span> Welile will review it and send an agent to visit {sent}. You can follow it here.</span>
        </p>
      )}

      {hasAny && (
        <section aria-labelledby="ws-my-applications" className="space-y-2">
          <h2 id="ws-my-applications" className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your applications</h2>
          {list.map((a) => (
            <div key={a.id} className="space-y-2 rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{a.school_name}</p>
                  <p className="truncate text-xs text-muted-foreground">{[a.school_level, a.town, a.district].filter(Boolean).join(' · ')}</p>
                </div>
                <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', toneFor(a))}>{ownerStatusLabel(a)}</span>
              </div>
              {a.assigned_agent_name && (a.status === 'agent_assigned' || a.status === 'inspecting') && (
                <div className="flex items-center gap-2 rounded-2xl bg-muted/60 p-3 text-sm">
                  <Users className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">Your Welile agent: <span className="font-semibold">{a.assigned_agent_name}</span></span>
                  {a.assigned_agent_phone && (
                    <Button asChild size="sm" variant="outline" className="h-9 shrink-0 gap-1 rounded-full">
                      <a href={`tel:${a.assigned_agent_phone}`}><Phone className="h-4 w-4" />Call</a>
                    </Button>
                  )}
                </div>
              )}
              {a.status === 'declined' && a.ops_note && <p className="text-xs text-muted-foreground">Reason: {a.ops_note}</p>}
              {isOpenApplication(a.status) && (
                <Button variant="ghost" size="sm" className="h-9 gap-1 px-2 text-muted-foreground" onClick={() => void withdraw(a)}>
                  <X className="h-4 w-4" />Withdraw application
                </Button>
              )}
            </div>
          ))}
          {!formOpen && (
            <Button variant="outline" className="min-h-[48px] w-full rounded-2xl" onClick={() => { setShowForm(true); setSent(null); }}>
              Apply for another school
            </Button>
          )}
        </section>
      )}

      {mine.error && <p className="rounded-2xl bg-muted/60 p-3 text-sm text-muted-foreground">{applicationErrorMessage(mine.error)}</p>}

      {formOpen && (
        <ApplicationForm
          userId={userId}
          onSent={(schoolName) => {
            setSent(schoolName);
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ['welile-school-applications-mine', userId] });
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onCancel={hasAny ? () => setShowForm(false) : undefined}
        />
      )}
    </div>
  );
}

function Field({ label, htmlFor, error, hint, children }: { label: string; htmlFor?: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Select({ id, value, onChange, options, placeholder, invalid }: {
  id: string; value: string; onChange: (v: string) => void; options: readonly (string | { value: string; label: string })[]; placeholder: string; invalid?: boolean;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={cn('h-12 w-full rounded-2xl border border-input bg-background px-3 text-base', !value && 'text-muted-foreground', invalid && 'border-destructive')}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => typeof o === 'string'
        ? <option key={o} value={o}>{o}</option>
        : <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-3xl border border-border/60 bg-card p-4 shadow-sm">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ApplicationForm({ userId, onSent, onCancel }: { userId: string; onSent: (schoolName: string) => void; onCancel?: () => void }) {
  const [d, setD] = useState<ApplicationDraft>(emptyApplication);
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const { data: allDistricts = [] } = useUgDistricts();
  const set = (patch: Partial<ApplicationDraft>) => setD((x) => ({ ...x, ...patch }));
  const errors = applicationErrors(d);
  const err = (k: keyof ApplicationDraft) => (tried ? errors[k] : undefined);
  const inputCls = (k: keyof ApplicationDraft) => cn('h-12 rounded-2xl text-base', err(k) && 'border-destructive');

  // Fill the owner's own name and phone from their account, once.
  useEffect(() => {
    supabase.from('profiles').select('full_name, phone, email').eq('id', userId).maybeSingle().then(({ data }) => {
      if (!data) return;
      setD((x) => ({
        ...x,
        contact_name: x.contact_name || data.full_name || '',
        contact_phone: x.contact_phone || data.phone || '',
        contact_email: x.contact_email || (data.email && !/@welile\.(user|agent)$/i.test(data.email) ? data.email : ''),
      }));
    });
  }, [userId]);

  const districtOptions = allDistricts.filter((x) => !d.region || x.region === d.region).map((x) => x.name).sort((a, b) => a.localeCompare(b));
  const chooseDistrict = (name: string) => set({ district: name, region: allDistricts.find((x) => x.name === name)?.region ?? d.region });

  const pinMyLocation = async () => {
    setGpsBusy(true);
    const r = await captureSmartLocation();
    setGpsBusy(false);
    if (!r.ok) { toast.error('Could not get your location. You can skip this; the agent will pin the school on the visit.'); return; }
    set({ latitude: r.latitude, longitude: r.longitude, gps_accuracy_m: Math.round(r.accuracy) });
  };

  const send = async () => {
    setTried(true);
    const keys = Object.keys(errors) as (keyof ApplicationDraft)[];
    if (keys.length) {
      toast.error('Check the highlighted fields');
      document.getElementById(`wsa-${keys[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setSending(true);
    try {
      const row = await submitApplication(d);
      onSent(row.school_name);
    } catch (e) {
      toast.error('Could not send the application', { description: applicationErrorMessage(e) });
    } finally {
      setSending(false);
    }
  };

  const pinned = d.latitude != null && d.longitude != null;

  return (
    <div className="space-y-4">
      <Section title="Your school">
        <Field label="School name" htmlFor="wsa-school_name" error={err('school_name')}>
          <Input id="wsa-school_name" className={inputCls('school_name')} placeholder="e.g. Kampala Parents School" value={d.school_name} onChange={(e) => set({ school_name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="School level" htmlFor="wsa-school_level" error={err('school_level')}>
            <Select id="wsa-school_level" value={d.school_level} onChange={(v) => set({ school_level: v })} options={LEVELS} placeholder="Choose level" invalid={!!err('school_level')} />
          </Field>
          <Field label="Ownership (optional)" htmlFor="wsa-ownership">
            <Select id="wsa-ownership" value={d.ownership} onChange={(v) => set({ ownership: v })} options={SCHOOL_OWNERSHIP} placeholder="Choose ownership" />
          </Field>
          <Field label="Day or boarding (optional)" htmlFor="wsa-offers">
            <Select id="wsa-offers" value={d.offers} onChange={(v) => set({ offers: v as ApplicationDraft['offers'] })} options={OFFERS_OPTIONS} placeholder="Choose" />
          </Field>
          <Field label="Number of students (optional)" htmlFor="wsa-estimated_enrollment" error={err('estimated_enrollment')}>
            <Input id="wsa-estimated_enrollment" inputMode="numeric" className={inputCls('estimated_enrollment')} placeholder="e.g. 450" value={d.estimated_enrollment} onChange={(e) => set({ estimated_enrollment: e.target.value })} />
          </Field>
          <Field label="Registration number (optional)" htmlFor="wsa-registration_number" hint="Ministry of Education registration, if you have it">
            <Input id="wsa-registration_number" className="h-12 rounded-2xl text-base" value={d.registration_number} onChange={(e) => set({ registration_number: e.target.value })} />
          </Field>
          <Field label="Year founded (optional)" htmlFor="wsa-year_founded" error={err('year_founded')}>
            <Input id="wsa-year_founded" inputMode="numeric" className={inputCls('year_founded')} placeholder="e.g. 2005" value={d.year_founded} onChange={(e) => set({ year_founded: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section title="Where it is">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Region" htmlFor="wsa-region">
            <Select id="wsa-region" value={d.region} onChange={(v) => set({ region: v, district: allDistricts.find((x) => x.name === d.district)?.region === v ? d.district : '' })} options={UG_REGIONS} placeholder="Region" />
          </Field>
          <Field label="District" htmlFor="wsa-district" error={err('district')}>
            <Select id="wsa-district" value={d.district} onChange={chooseDistrict} options={districtOptions} placeholder="District" invalid={!!err('district')} />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Town or trading centre (optional)" htmlFor="wsa-town">
            <Input id="wsa-town" className="h-12 rounded-2xl text-base" value={d.town} onChange={(e) => set({ town: e.target.value })} />
          </Field>
          <Field label="Village or cell (optional)" htmlFor="wsa-village">
            <Input id="wsa-village" className="h-12 rounded-2xl text-base" value={d.village} onChange={(e) => set({ village: e.target.value })} />
          </Field>
        </div>
        <Field label="Directions for the agent (optional)" htmlFor="wsa-directions">
          <Textarea id="wsa-directions" rows={2} className="rounded-2xl text-base" placeholder="e.g. Opposite the health centre, 200 m off the main road" value={d.directions} onChange={(e) => set({ directions: e.target.value })} />
        </Field>
        {pinned ? (
          <div className="flex items-center gap-2 rounded-2xl border border-primary/40 bg-primary/5 p-3 text-sm">
            <MapPin className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1">Location saved{d.gps_accuracy_m != null ? ` (±${d.gps_accuracy_m} m)` : ''}</span>
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => set({ latitude: null, longitude: null, gps_accuracy_m: null })}>Remove</Button>
          </div>
        ) : (
          <Button type="button" variant="outline" className="min-h-[48px] w-full gap-2 rounded-2xl" disabled={gpsBusy} onClick={() => void pinMyLocation()}>
            {gpsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            I am at the school: use my location (optional)
          </Button>
        )}
      </Section>

      <Section title="Who Welile should talk to">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Your name" htmlFor="wsa-contact_name" error={err('contact_name')}>
            <Input id="wsa-contact_name" className={inputCls('contact_name')} value={d.contact_name} onChange={(e) => set({ contact_name: e.target.value })} />
          </Field>
          <Field label="Your role at the school" htmlFor="wsa-contact_role">
            <Select id="wsa-contact_role" value={d.contact_role} onChange={(v) => set({ contact_role: v })} options={CONTACT_ROLES} placeholder="Choose role" />
          </Field>
          <Field label="Your phone number" htmlFor="wsa-contact_phone" error={err('contact_phone')}>
            <Input id="wsa-contact_phone" type="tel" inputMode="tel" className={inputCls('contact_phone')} placeholder="07XX XXX XXX" value={d.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} />
          </Field>
          <Field label="Email (optional)" htmlFor="wsa-contact_email" error={err('contact_email')}>
            <Input id="wsa-contact_email" type="email" inputMode="email" className={inputCls('contact_email')} value={d.contact_email} onChange={(e) => set({ contact_email: e.target.value })} />
          </Field>
          <Field label="Head teacher's name (optional)" htmlFor="wsa-head_name">
            <Input id="wsa-head_name" className="h-12 rounded-2xl text-base" value={d.head_name} onChange={(e) => set({ head_name: e.target.value })} />
          </Field>
          <Field label="Head teacher's phone (optional)" htmlFor="wsa-head_phone" error={err('head_phone')}>
            <Input id="wsa-head_phone" type="tel" inputMode="tel" className={inputCls('head_phone')} value={d.head_phone} onChange={(e) => set({ head_phone: e.target.value })} />
          </Field>
          <Field label="Bursar's name (optional)" htmlFor="wsa-bursar_name">
            <Input id="wsa-bursar_name" className="h-12 rounded-2xl text-base" value={d.bursar_name} onChange={(e) => set({ bursar_name: e.target.value })} />
          </Field>
          <Field label="Bursar's phone (optional)" htmlFor="wsa-bursar_phone" error={err('bursar_phone')}>
            <Input id="wsa-bursar_phone" type="tel" inputMode="tel" className={inputCls('bursar_phone')} value={d.bursar_phone} onChange={(e) => set({ bursar_phone: e.target.value })} />
          </Field>
        </div>
        <Field label="Anything else Welile should know (optional)" htmlFor="wsa-note">
          <Textarea id="wsa-note" rows={3} className="rounded-2xl text-base" placeholder="e.g. Best time to visit, number of families struggling with fees" value={d.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </Section>

      <p className="px-1 text-xs text-muted-foreground">
        Term dates, fees per class and the account Welile pays into are agreed with the agent on the visit.
      </p>

      <div className="space-y-2">
        <Button className="min-h-[52px] w-full gap-2 rounded-2xl text-base" disabled={sending} onClick={() => void send()}>
          {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          {sending ? 'Sending' : 'Submit application'}
        </Button>
        {onCancel && <Button variant="ghost" className="min-h-[48px] w-full rounded-2xl" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

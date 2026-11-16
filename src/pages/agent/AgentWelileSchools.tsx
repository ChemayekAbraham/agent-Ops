import { safeUUID } from '@/lib/safeUUID';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GraduationCap, Lock, LockOpen, MapPin, Loader2, Smartphone, Gift, MessageCircle, MessageSquare, Copy, CheckCircle2, CloudOff, Send, RotateCcw, ChevronRight, LogIn, LogOut, Repeat, ChevronDown, Camera, Search, ScanLine } from 'lucide-react';
import SchoolPartnershipPanel from '@/components/welile-schools/SchoolPartnershipPanel';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import StudentPhotoCapture from '@/components/welile-schools/StudentPhotoCapture';
import StudentProfileSummary from '@/components/welile-schools/StudentProfileSummary';
import SchoolFeesRequest from '@/components/welile-schools/SchoolFeesRequest';
import StickyCta from '@/components/welile-schools/StickyCta';
import StudentQrScanner from '@/components/welile-schools/StudentQrScanner';
import ScannedStudentCard from '@/components/welile-schools/ScannedStudentCard';
import { flushPendingPhotos, uploadStudentPhoto } from '@/lib/welileSchoolsPhoto';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import { UG_REGIONS, useUgDistricts, type UgLocationSelection } from '@/hooks/useUgLocations';
import { CountryCombobox } from '@/components/ui/country-combobox';
import { captureSmartLocation } from '@/hooks/useSmartLocation';
import {
  SCHOOL_LEVELS, SCHOOL_OWNERSHIP, FACILITY_TYPES, PROFILE_ROLES, GATE_ROLES, roleGroup, roleLabel,
  buildSchoolSignupLink, buildSignupMessage, toIntlDigits, smartphoneFields,
  readLockedSchool, writeLockedSchool, saveProfile, flushPendingProfiles, readPendingProfiles, markSignupSent,
  saveGateLog, flipGateLogDirection, flushPendingGateLogs, readPendingGateLogs, readLocalGateLogs, writeLocalGateLogs,
  computeGateMovementSummary, formatEatTime, classLevelsFor, isListedClass, isTertiaryLearner,
  type SchoolRow, type SchoolProfileRow, type SchoolGateLogRow,
} from '@/lib/welileSchools';

const db = supabase as any;

/** One titled group of form fields, as a rounded card like a phone settings section. */
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="space-y-3 rounded-3xl border border-border/70 bg-card p-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-sm">{label}</Label>{children}</div>;
}

/** Class picker grouped nursery to university, the school's own level first. A native select, so phones show their own picker. */
function ClassGradeSelect({ schoolLevel, value, onChange }: { schoolLevel?: string | null; value: string; onChange: (v: string) => void }) {
  const groups = classLevelsFor(schoolLevel);
  return (
    <div className="relative">
      <select aria-label="Class, grade or year" value={value} onChange={(e) => onChange(e.target.value)}
        className={cn('flex h-14 w-full appearance-none rounded-lg border border-input bg-background px-4 pr-10 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring', !value && 'text-muted-foreground')}>
        <option value="" disabled>Choose class</option>
        {value && !isListedClass(value) && <optgroup label="Saved earlier"><option value={value}>{value}</option></optgroup>}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.classes.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </optgroup>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  );
}

function Chips({ options, value, onChange }: { options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <Button key={o} type="button" variant="outline" aria-pressed={value === o} onClick={() => onChange(o)}
          className={cn('min-h-[44px] px-3 rounded-xl border text-sm', value === o
            // Keep the chosen chip purple on hover/tap too (phones keep :hover after a tap).
            ? 'bg-primary text-primary-foreground border-primary hover:bg-primary hover:text-primary-foreground active:bg-primary'
            : 'bg-card border-border')}>
          {o}
        </Button>
      ))}
    </div>
  );
}

const EMPTY_SCHOOL: Partial<SchoolRow> = { country: 'Uganda', school_level: 'Primary', ownership: 'Government', gate_name: 'Main Gate' };

export default function AgentWelileSchools() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  // Opened from the Welile Schools home (/schools): ?mode= picks the tab, ?new=1 starts a new school.
  const [params] = useSearchParams();
  const startNew = params.get('new') === '1';
  const initialMode = params.get('mode');
  const [locked, setLocked] = useState<SchoolRow | null>(() => (startNew ? null : readLockedSchool()));
  const [draft, setDraft] = useState<Partial<SchoolRow>>(EMPTY_SCHOOL);
  const [creating, setCreating] = useState(startNew);
  const [dirRegion, setDirRegion] = useState<string | null>(null);
  const [dirDistrict, setDirDistrict] = useState<string | null>(null);
  const [dirSearch, setDirSearch] = useState('');
  const [savingSchool, setSavingSchool] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(() => readPendingProfiles().length);
  const [gatePendingCount, setGatePendingCount] = useState(() => readPendingGateLogs().length);
  const [mode, setMode] = useState<'gate' | 'register' | 'fees' | 'partner'>(() => (initialMode === 'register' || initialMode === 'partner' || initialMode === 'fees' ? initialMode : 'gate'));

  const { data: schools = [] } = useQuery({
    queryKey: ['welile-schools-list'],
    queryFn: async () => {
      const { data, error } = await db.from('welile_schools').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data as SchoolRow[];
    },
  });

  useEffect(() => {
    const flush = () => {
      flushPendingProfiles().then((n) => {
        setPendingCount(readPendingProfiles().length);
        if (n) toast.success(`${n} saved registration${n > 1 ? 's' : ''} sent`);
        // Photos link to their profile by client_ref, so they go once the profiles are up.
        return flushPendingPhotos();
      }).then((n) => { if (n) toast.success(`${n} student photo${n > 1 ? 's' : ''} uploaded`); });
      flushPendingGateLogs().then((n) => {
        setGatePendingCount(readPendingGateLogs().length);
        if (n) toast.success(`${n} saved gate log${n > 1 ? 's' : ''} sent`);
      });
    };
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);

  const dirDistricts = useMemo(() => [...new Set(schools.filter(s => s.region === dirRegion && s.district).map(s => s.district as string))].sort(), [schools, dirRegion]);
  const shownSchools = useMemo(() => { const q = dirSearch.trim().toLowerCase(); return schools.filter(s => (!dirRegion || s.region === dirRegion) && (!dirDistrict || s.district === dirDistrict) && (!q || [s.name, s.village].some(v => v?.toLowerCase().includes(q)))); }, [schools, dirRegion, dirDistrict, dirSearch]);
  const startBot = () => { setDraft({ ...EMPTY_SCHOOL, ...(dirRegion ? { region: dirRegion } : {}), ...(dirDistrict ? { district: dirDistrict } : {}) }); setCreating(true); };
  const lockSchool = (s: SchoolRow | null) => { setLocked(s); writeLockedSchool(s); };

  const captureGps = async () => {
    setGpsBusy(true);
    const result = await captureSmartLocation();
    setGpsBusy(false);
    if (!result.ok) { toast.error('Could not get GPS — enter coordinates or skip for now'); return false; }
    setDraft((d) => ({ ...d, latitude: result.latitude, longitude: result.longitude, gps_accuracy_m: Math.round(result.accuracy), gps_source: 'device' }));
    return true;
  };

  const createSchool = async () => {
    if (!draft.name || draft.name.trim().length < 2) { toast.error('Enter the school name'); return; }
    setSavingSchool(true);
    const { data, error } = await db.from('welile_schools').insert({
      ...draft, name: draft.name.trim(), created_by: user?.id,
      gps_source: draft.latitude != null ? (draft.gps_source ?? 'manual') : null,
    }).select().single();
    setSavingSchool(false);
    if (error) { toast.error('Could not save school', { description: error.message }); return; }
    lockSchool(data as SchoolRow);
    setCreating(false);
    setDraft(EMPTY_SCHOOL);
    qc.invalidateQueries({ queryKey: ['welile-schools-list'] });
    toast.success('School saved and locked');
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate('/schools')} aria-label="Back to Welile Schools home"><ArrowLeft className="h-5 w-5" /></Button>
          <WelileSchoolsBrand />
          {pendingCount + gatePendingCount > 0 && <Badge variant="outline" className="gap-1"><CloudOff className="h-3 w-3" />{pendingCount + gatePendingCount} waiting</Badge>}
        </div>
        {locked && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <Lock className="h-4 w-4 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{locked.name}</p>
              <p className="text-xs text-muted-foreground truncate">{[locked.gate_name, locked.village, locked.district].filter(Boolean).join(' · ')}</p>
            </div>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => lockSchool(null)}><LockOpen className="h-4 w-4 mr-1" />Change</Button>
          </div>
        )}
      </header>

      <main className="max-w-xl mx-auto p-3 space-y-4">
        {!locked && !creating && (
          <Card className="p-4 space-y-3">
            <h2 className="font-semibold">Choose the school you are at</h2>
            <Button className="w-full min-h-[48px] gap-2 whitespace-normal" onClick={startBot}><MessageCircle className="h-5 w-5 shrink-0" />Register a new school</Button>
            {schools.length > 0 && <p className="text-sm text-muted-foreground">Or pick a registered school:</p>}
            <div className="flex flex-wrap gap-2">{[null, ...UG_REGIONS].map(reg => <Button key={reg ?? 'all'} size="sm" variant={dirRegion === reg ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => { setDirRegion(reg); setDirDistrict(null); }}>{reg ?? 'All'}</Button>)}</div>
            {dirRegion && dirDistricts.length > 0 && <div className="flex flex-wrap gap-2">{dirDistricts.map(dist => <Button key={dist} size="sm" variant={dirDistrict === dist ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setDirDistrict(dirDistrict === dist ? null : dist)}>{dist}</Button>)}</div>}
            <Input aria-label="Search schools" placeholder="Search school name or village..." value={dirSearch} onChange={e => setDirSearch(e.target.value)} />
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {shownSchools.map((s) => (
                <button key={s.id} onClick={() => lockSchool(s)} className="w-full text-left p-3 rounded-xl border border-border min-h-[52px]">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{[s.school_level, s.district, s.village].filter(Boolean).join(' · ')}</p>
                </button>
              ))}
            </div>
          </Card>
        )}

        {!locked && creating && (
          <SchoolRegistration draft={draft} setDraft={setDraft} captureGps={captureGps} gpsBusy={gpsBusy} saving={savingSchool} onSave={createSchool} onCancel={() => setCreating(false)} />
        )}

        {locked && user && (
          <>
            {mode === 'partner' ? (
              <SchoolPartnershipPanel school={locked} />
            ) : mode === 'gate' ? (
              <DailyGateLogView school={locked} agentId={user.id} onQueued={() => setGatePendingCount(readPendingGateLogs().length)} onSwitchToRegister={() => setMode('register')} />
            ) : (
              <>
                {/* The agent's two jobs for a student: put them on the system, or ask Welile to pay their fees. */}
                <div className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1" role="tablist" aria-label="What do you want to do?">
                  {([['register', 'Register student'], ['fees', 'Request fees']] as const).map(([k, label]) => (
                    <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)}
                      className={cn('min-h-[44px] rounded-full px-2 text-sm font-semibold transition-colors', mode === k ? 'bg-primary text-primary-foreground shadow' : 'text-muted-foreground')}>
                      {label}
                    </button>
                  ))}
                </div>
                {mode === 'fees' ? (
                  <SchoolFeesRequest school={locked} onRegisterStudent={() => setMode('register')} />
                ) : (
                  <GateRegistration school={locked} agentId={user.id} onQueued={() => { setPendingCount(readPendingProfiles().length); setGatePendingCount(readPendingGateLogs().length); }} />
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const GATE_OPTIONS = ['Main Gate', 'Primary Gate', 'Back Gate', 'Admin Gate'] as const;

/** A native select styled like the app's inputs, so phones open their own picker. */
function NativeSelect({ label, value, placeholder, options, onChange, invalid }: { label: string; value: string; placeholder: string; options: readonly string[]; onChange: (v: string) => void; invalid?: boolean }) {
  return (
    <div className="relative">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined}
        className={cn('flex h-12 w-full appearance-none rounded-2xl border bg-background px-4 pr-10 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring',
          invalid ? 'border-destructive' : 'border-input', !value && 'text-muted-foreground')}>
        <option value="" disabled>{placeholder}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
    </div>
  );
}

/** One-line pill row (single choice), scrolls sideways instead of wrapping. */
function PillRow({ label, options, value, onChange }: { label: string; options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
          className={cn('min-h-[40px] shrink-0 rounded-full px-3.5 text-sm font-medium transition-colors',
            value === o ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/70')}>
          {o}
        </button>
      ))}
    </div>
  );
}

/** A numbered form card with a tick once its required fields are filled. */
function StepCard({ n, title, hint, done, optional, children }: { n: number; title: string; hint?: string; done: boolean; optional?: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-border/70 bg-card p-4 space-y-3" aria-label={title}>
      <div className="flex items-center gap-3">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary')}>
          {done ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold leading-tight">{title}{optional ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">Optional</span> : null}</h3>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Register a new school at the gate: one short form in app-style cards (school, type, location,
 * gate GPS, head teacher) with the save button pinned to the bottom of the screen.
 */
export function SchoolRegistration({ draft, setDraft, captureGps, gpsBusy, saving, onSave, onCancel }: {
  draft: Partial<SchoolRow>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<SchoolRow>>>;
  captureGps: () => Promise<boolean | undefined>;
  gpsBusy: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [ugSchoolLoc, setUgSchoolLoc] = useState<UgLocationSelection | null>(null);
  const [manualGps, setManualGps] = useState(false);
  const [otherCountry, setOtherCountry] = useState(draft.country !== 'Uganda');
  const [customGate, setCustomGate] = useState(!!draft.gate_name && !(GATE_OPTIONS as readonly string[]).includes(draft.gate_name));
  const [showContact, setShowContact] = useState(!!(draft.head_name || draft.head_phone || draft.estimated_enrollment != null));
  const [tried, setTried] = useState(false);
  const { data: allDistricts = [] } = useUgDistricts();
  const update = (key: keyof SchoolRow, value: string | number | null) => setDraft(d => ({ ...d, [key]: value }));

  const levels = [...SCHOOL_LEVELS, 'Mixed / K-12'];
  const pinned = draft.latitude != null && draft.longitude != null && Number.isFinite(draft.latitude) && Number.isFinite(draft.longitude);
  const coordinateText = pinned ? `${draft.latitude?.toFixed(5)}, ${draft.longitude?.toFixed(5)}${draft.gps_accuracy_m != null ? ` (±${draft.gps_accuracy_m}m)` : ''}` : '';
  const districtOptions = allDistricts.filter(d => !draft.region || d.region === draft.region).map(d => d.name).sort((a, b) => a.localeCompare(b));

  const nameOk = (draft.name?.trim().length ?? 0) >= 2;
  const typeOk = !!draft.school_level && !!draft.ownership;
  const locationOk = otherCountry ? !!draft.country && draft.country !== 'Uganda' : !!(draft.region && draft.district);
  const doneCount = [nameOk, typeOk, locationOk].filter(Boolean).length;

  const reset = () => { setDraft({ ...EMPTY_SCHOOL }); setUgSchoolLoc(null); setOtherCountry(false); setCustomGate(false); setManualGps(false); setShowContact(false); setTried(false); };
  const pickLocation = (sel: UgLocationSelection | null) => {
    setUgSchoolLoc(sel);
    setDraft(d => ({ ...d, country: 'Uganda', region: sel?.region ?? d.region ?? null, district: sel?.district ?? d.district ?? null, sub_county: sel?.subcounty ?? null, parish: sel?.parish ?? null, village: sel?.village ?? null, town: d.town || sel?.county || null }));
  };
  const chooseCountryMode = (other: boolean) => {
    if (other === otherCountry) return;
    setOtherCountry(other); setUgSchoolLoc(null);
    setDraft(d => ({ ...d, country: other ? '' : 'Uganda', region: null, district: null, sub_county: null, parish: null, village: null, town: null }));
  };
  const chooseRegion = (reg: string) => {
    if (reg === draft.region) return;
    setUgSchoolLoc(null);
    setDraft(d => ({ ...d, region: reg, district: null, sub_county: null, parish: null, village: null }));
  };
  const chooseDistrict = (dist: string) => {
    if (dist === draft.district) return;
    const reg = allDistricts.find(d => d.name === dist)?.region ?? draft.region ?? null;
    setUgSchoolLoc(null);
    setDraft(d => ({ ...d, region: reg, district: dist, sub_county: null, parish: null, village: null }));
  };
  const clearGps = () => setDraft(d => ({ ...d, latitude: null, longitude: null, gps_accuracy_m: null, gps_source: null }));
  const submit = () => {
    setTried(true);
    if (!nameOk) { toast.error('Enter the school name'); return; }
    if (!locationOk) { toast.error('Choose the school location'); return; }
    onSave();
  };

  return (
    <section className="space-y-3 min-w-0">
      {/* Title card: what this is, how far along, start over, cancel. */}
      <div className="rounded-3xl bg-gradient-to-br from-primary to-primary/80 p-4 text-primary-foreground shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary-foreground/15"><GraduationCap className="h-6 w-6" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-tight">Register a school</h2>
            <p className="text-xs text-primary-foreground/80">Fill this in standing at the school gate.</p>
          </div>
          <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0 rounded-full text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground" aria-label="Start Over" title="Start Over" disabled={saving || gpsBusy} onClick={reset}><RotateCcw className="h-4 w-4" /></Button>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-primary-foreground/20" aria-hidden>
            <div className="h-full rounded-full bg-primary-foreground transition-all" style={{ width: `${(doneCount / 3) * 100}%` }} />
          </div>
          <span className="text-xs font-medium">{doneCount} of 3 required</span>
        </div>
      </div>

      <StepCard n={1} title="School" hint="Name and the gate you are at" done={nameOk}>
        <Input aria-label="School name" aria-invalid={tried && !nameOk || undefined} className={cn('h-12 rounded-2xl text-base', tried && !nameOk && 'border-destructive')} placeholder="e.g. Kampala Parents School" value={draft.name ?? ''} onChange={e => update('name', e.target.value)} />
        {tried && !nameOk ? <p className="text-xs text-destructive">Enter the school name</p> : null}
        <PillRow label="Gate" options={[...GATE_OPTIONS, 'Other gate']} value={customGate ? 'Other gate' : (draft.gate_name || 'Main Gate')}
          onChange={v => { if (v === 'Other gate') { setCustomGate(true); update('gate_name', ''); } else { setCustomGate(false); update('gate_name', v); } }} />
        {customGate ? <Input aria-label="Gate name" className="h-12 rounded-2xl text-base" placeholder="Name of this gate" value={draft.gate_name ?? ''} onChange={e => update('gate_name', e.target.value)} /> : null}
      </StepCard>

      <StepCard n={2} title="Type of school" done={typeOk}>
        <NativeSelect label="School level" placeholder="Choose level" value={draft.school_level ?? ''} options={levels} onChange={v => update('school_level', v)} />
        <PillRow label="Ownership" options={SCHOOL_OWNERSHIP} value={draft.ownership ?? ''} onChange={v => update('ownership', v)} />
      </StepCard>

      <StepCard n={3} title="Location" hint={otherCountry ? 'Country the school is in' : 'Region and district, then the village'} done={locationOk}>
        <div className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1" role="group" aria-label="Country">
          {([[false, '🇺🇬 Uganda'], [true, '🌍 Other country']] as const).map(([other, label]) => (
            <button key={label} type="button" aria-pressed={otherCountry === other} onClick={() => chooseCountryMode(other)}
              className={cn('min-h-[40px] rounded-full text-sm font-semibold transition-colors', otherCountry === other ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')}>
              {label}
            </button>
          ))}
        </div>
        {otherCountry ? (
          <CountryCombobox value={draft.country || ''} onChange={value => { if (value === 'Uganda') chooseCountryMode(false); else update('country', value); }} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <NativeSelect label="Region" placeholder="Region" value={draft.region ?? ''} options={UG_REGIONS} onChange={chooseRegion} invalid={tried && !draft.region} />
              <NativeSelect label="District" placeholder="District" value={draft.district ?? ''} options={draft.district && !districtOptions.includes(draft.district) ? [draft.district, ...districtOptions] : districtOptions} onChange={chooseDistrict} invalid={tried && !draft.district} />
            </div>
            {draft.district ? <UgLocationPicker label="Cell / village (optional)" districtName={draft.district} value={ugSchoolLoc} onChange={pickLocation} /> : null}
          </>
        )}
        {tried && !locationOk ? <p className="text-xs text-destructive">Choose the school location</p> : null}
        <Input aria-label="Town / City (optional)" className="h-12 rounded-2xl text-base" placeholder="Town or city (optional)" value={draft.town ?? ''} onChange={e => update('town', e.target.value)} />
      </StepCard>

      <StepCard n={4} title="Gate GPS" hint="Stand at the gate, then capture" done={pinned} optional>
        {pinned ? (
          <div className="flex items-center gap-3 rounded-2xl bg-primary/5 p-3">
            <MapPin className="h-5 w-5 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium break-words">{coordinateText}</p>
              <a className="text-xs text-primary underline" href={`https://www.google.com/maps?q=${draft.latitude},${draft.longitude}`} target="_blank" rel="noreferrer">View on Google Maps</a>
            </div>
            <Button variant="ghost" size="sm" className="shrink-0 rounded-full" onClick={clearGps}>Clear</Button>
          </div>
        ) : (
          <Button className="h-12 w-full gap-2 rounded-2xl text-base" disabled={gpsBusy} onClick={() => { void captureGps(); }}>
            {gpsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}{gpsBusy ? 'Getting location…' : 'Capture Gate GPS Now'}
          </Button>
        )}
        <button type="button" className="text-xs font-medium text-primary underline-offset-2 hover:underline" aria-expanded={manualGps} onClick={() => setManualGps(v => !v)}>
          {manualGps ? 'Hide coordinates' : 'Enter coordinates manually'}
        </button>
        {manualGps ? (
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Latitude" placeholder="Latitude" className="h-12 rounded-2xl" type="number" step="any" min={-90} max={90} inputMode="decimal" value={draft.latitude ?? ''} onChange={e => setDraft(d => ({ ...d, latitude: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} />
            <Input aria-label="Longitude" placeholder="Longitude" className="h-12 rounded-2xl" type="number" step="any" min={-180} max={180} inputMode="decimal" value={draft.longitude ?? ''} onChange={e => setDraft(d => ({ ...d, longitude: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} />
          </div>
        ) : null}
      </StepCard>

      <StepCard n={5} title="Head teacher & enrolment" done={!!(draft.head_name || draft.estimated_enrollment != null)} optional>
        {showContact ? (
          <div className="space-y-3">
            <Input aria-label="Headteacher name" className="h-12 rounded-2xl text-base" placeholder="Head teacher's name" value={draft.head_name ?? ''} onChange={e => update('head_name', e.target.value)} />
            <Input aria-label="Headteacher phone" className="h-12 rounded-2xl text-base" placeholder="Phone number" inputMode="tel" value={draft.head_phone ?? ''} onChange={e => update('head_phone', e.target.value)} />
            <Input aria-label="Estimated enrolment" className="h-12 rounded-2xl text-base" placeholder="Learners enrolled (about)" type="number" min={0} inputMode="numeric" value={draft.estimated_enrollment ?? ''} onChange={e => update('estimated_enrollment', e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))))} />
            <PillRow label="Enrolment estimate" options={['~200', '~500', '~1,000', '~2,000+']} value={draft.estimated_enrollment != null ? ({ 200: '~200', 500: '~500', 1000: '~1,000', 2000: '~2,000+' } as Record<number, string>)[draft.estimated_enrollment] ?? '' : ''}
              onChange={v => update('estimated_enrollment', ({ '~200': 200, '~500': 500, '~1,000': 1000, '~2,000+': 2000 } as Record<string, number>)[v])} />
          </div>
        ) : (
          <button type="button" onClick={() => setShowContact(true)} className="flex min-h-[48px] w-full items-center justify-between rounded-2xl bg-muted/50 px-4 text-sm font-medium">
            Add head teacher details<ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
          </button>
        )}
      </StepCard>

      <Button variant="ghost" className="h-11 w-full rounded-2xl text-muted-foreground" disabled={saving} onClick={onCancel}>Cancel registration</Button>

      <StickyCta className="bg-background shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.25)]">
        <Button className="h-12 w-full gap-2 rounded-2xl text-base" disabled={saving} onClick={submit}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}Register School & Lock Gate
        </Button>
      </StickyCta>
    </section>
  );
}

const MISSING_TEXT = {
  photo: "Take the student's photo first",
  name: 'Enter the full name',
  facility: 'Choose the facility type',
  phone: 'Answer: has a smartphone?',
} as const;

function MissingNote({ show, text }: { show: boolean; text: string }) {
  return show ? <p role="alert" className="text-xs font-medium text-destructive">{text}</p> : null;
}

function GateRegistration({ school, agentId, onQueued }: { school: SchoolRow; agentId: string; onQueued: () => void }) {
  // Only students are registered for now; the other roles stay in PROFILE_ROLES for later.
  const role = 'pupil';
  const [f, setF] = useState<Partial<SchoolProfileRow>>({});
  const [hasPhone, setHasPhone] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<{ row: SchoolProfileRow; saved: boolean } | null>(null);
  const [count, setCount] = useState(0);
  const [logEntry, setLogEntry] = useState(true);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraProblem, setCameraProblem] = useState<string | null>(null);
  // After a save the form is replaced by the student's profile summary until "Register the next student".
  const [summary, setSummary] = useState<{ photoUrl: string | null } | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const group = roleGroup(role);
  const tertiary = group === 'pupil' && isTertiaryLearner(f.class_grade, school.school_level);
  const set = (k: keyof SchoolProfileRow) => (e: React.ChangeEvent<HTMLInputElement>) => setF((d) => ({ ...d, [k]: e.target.value }));
  const num = (v: unknown) => (v === '' || v == null ? null : Number(String(v).replace(/\D/g, '')) || null);

  // The first required answer still missing; shown in red and scrolled into view on Save.
  const [flagged, setFlagged] = useState<null | 'photo' | 'name' | 'facility' | 'phone'>(null);
  const firstMissing = (): typeof flagged => {
    if (group === 'pupil' && !photo && !cameraProblem) return 'photo';
    if (group !== 'asset' && !f.full_name?.trim()) return 'name';
    if (group === 'asset' && !f.facility_type) return 'facility';
    if (group !== 'asset' && hasPhone === null) return 'phone';
    return null;
  };
  // The red mark clears by itself once that answer is given.
  const missing = flagged && firstMissing() === flagged ? flagged : null;

  const submit = async () => {
    const gap = firstMissing();
    if (gap) {
      setFlagged(gap);
      toast.error(MISSING_TEXT[gap]);
      document.getElementById(`wsr-${gap}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setSaving(true);
    // Whatever happens below, the spinner stops and the agent is told the outcome.
    try {
    const id = safeUUID();
    const row: SchoolProfileRow = {
      ...f, id, client_ref: id, school_id: school.id, registered_by: agentId, role,
      age: num(f.age), years_at_school: num(f.years_at_school), facility_capacity: num(f.facility_capacity),
      date_of_birth: f.date_of_birth || null,
      ...(group === 'asset' ? { has_smartphone: null, needs_free_smartphone: false, smartphone_status: null } : smartphoneFields(hasPhone)),
    };
    // Upload the face photo first so the profile is saved with its path; offline, it waits on the phone.
    if (group === 'pupil' && photo) row.photo_path = await uploadStudentPhoto(school.id, id, id, photo.blob);
    const res = await saveProfile(row);
    if (res.error) {
      // Refused by the server: keep everything the agent typed so they can fix it and try again.
      toast.error('Could not register this student', { description: res.error });
      return;
    }
    if (group !== 'asset' && logEntry) {
      const gid = safeUUID();
      const gateRes = await saveGateLog({
        id: gid, client_ref: gid, school_id: school.id, profile_id: row.id,
        direction: 'in', person_name: row.full_name!, role_type: row.role,
        phone: row.phone || row.guardian_phone || null,
        class_or_department: row.class_grade || row.subject_department || null,
        gate_name: school.gate_name || 'Main Gate', purpose_or_note: 'Registered at gate',
        pickup_guardian_name: row.guardian_name || null, pickup_guardian_phone: row.guardian_phone || null,
        agent_id: agentId, recorded_at: new Date().toISOString(),
      });
      if (!gateRes.saved) onQueued();
    }
    setLast(res);
    setCount((c) => c + 1);
    const who = group === 'asset' ? (f.facility_type || 'Facility') : (f.full_name?.trim() || 'Person');
    if (!res.saved) { onQueued(); toast.message('Saved on this phone', { description: `${who} will upload automatically when you are back online.` }); }
    else toast.success('Registration successful', { description: `${who} is registered at ${school.name}.` });
    // The summary keeps the photo's preview URL; it is released on "Register the next student".
    setSummary({ photoUrl: group === 'pupil' ? photo?.url ?? null : null });
    setF({}); setHasPhone(null); setPhoto(null);
    // The summary replaces the form; bring its top into view after saving at the bottom.
    topRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (e) {
      console.error('[welile-schools] save student failed', e);
      toast.error('Could not register this student', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const registerNext = () => {
    if (summary?.photoUrl) URL.revokeObjectURL(summary.photoUrl);
    setSummary(null);
    topRef.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <div ref={topRef} className="space-y-4 scroll-mt-32">
      {summary && last ? (
        <>
          <StudentProfileSummary row={last.row} saved={last.saved} photoUrl={summary.photoUrl} school={school} onNext={registerNext} />
          {last.row.has_smartphone && <SignupLinkCard row={last.row} saved={last.saved} school={school} agentId={agentId} />}
          {last.row.needs_free_smartphone && (
            <Card className="p-3 border-primary/40 bg-primary/5 flex gap-2"><Gift className="h-5 w-5 text-primary shrink-0" /><p className="text-sm">{last.row.full_name} is in the Free Smartphone queue.</p></Card>
          )}
        </>
      ) : (
      <>
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <h2 className="text-lg font-bold leading-tight">Register a student</h2>
          <p className="text-xs text-muted-foreground">With their parent or guardian's details.</p>
        </div>
        <Badge variant="secondary" className="shrink-0 rounded-full">{count} this session</Badge>
      </div>

      <FormSection title={group === 'asset' ? 'Facility' : 'Student'}>
        {group === 'asset' ? (
          <>
            <div id="wsr-facility" className="scroll-mt-40 space-y-1">
              <Field label="Facility type"><Chips options={FACILITY_TYPES} value={f.facility_type ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_type: v }))} /></Field>
              <MissingNote show={missing === 'facility'} text={MISSING_TEXT.facility} />
            </div>
            <Field label="Condition"><Chips options={['Good', 'Fair', 'Poor']} value={f.facility_condition ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_condition: v }))} /></Field>
            <Field label="Capacity"><Input inputMode="numeric" value={(f.facility_capacity as any) ?? ''} onChange={set('facility_capacity')} /></Field>
          </>
        ) : (
          <>
            {group === 'pupil' && (
              <div id="wsr-photo" className="scroll-mt-40 space-y-2">
                {photo ? (
                  <div className="flex items-center gap-3 rounded-2xl bg-muted/50 p-3">
                    <img src={photo.url} alt="Student photo" className="h-16 w-16 shrink-0 rounded-2xl object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-sm font-semibold"><CheckCircle2 className="h-4 w-4 text-emerald-600" />Photo taken</p>
                      <p className="text-xs text-muted-foreground">Saved with this student.</p>
                    </div>
                    <Button variant="outline" size="sm" className="min-h-[40px] rounded-full" onClick={() => setCameraOpen(true)}>Retake</Button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCameraOpen(true)}
                    className={cn('flex min-h-[80px] w-full items-center gap-3 rounded-2xl border-2 border-dashed bg-primary/5 p-3 text-left hover:bg-primary/10', missing === 'photo' ? 'border-destructive' : 'border-primary/50')}>
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Camera className="h-5 w-5" /></span>
                    <span>
                      <span className="block font-semibold">Take the student's photo</span>
                      <span className="block text-sm text-muted-foreground">Fit their face inside the oval on screen.</span>
                    </span>
                  </button>
                )}
                <MissingNote show={missing === 'photo'} text={MISSING_TEXT.photo} />
                {cameraProblem && !photo && <p className="text-xs text-amber-700 dark:text-amber-400">{cameraProblem} You can save without a photo for now.</p>}
                <StudentPhotoCapture open={cameraOpen} studentName={f.full_name} onClose={() => setCameraOpen(false)}
                  onUnavailable={(reason) => { setCameraOpen(false); setCameraProblem(reason); }}
                  onCapture={(blob) => setPhoto((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; })} />
              </div>
            )}
            <div id="wsr-name" className="scroll-mt-40 space-y-1">
              <Field label="Full name"><Input aria-label="Student full name" aria-invalid={missing === 'name'} className={cn(missing === 'name' && 'border-destructive')} value={f.full_name ?? ''} onChange={set('full_name')} /></Field>
              <MissingNote show={missing === 'name'} text={MISSING_TEXT.name} />
            </div>
            <Field label="Gender"><Chips options={['Female', 'Male']} value={f.gender ?? ''} onChange={(v) => setF((d) => ({ ...d, gender: v }))} /></Field>
            {group === 'pupil' && (
              <div className="grid grid-cols-2 gap-2">
                <div className={tertiary ? 'col-span-2' : ''}>
                  <Field label="Class / Grade / Year"><ClassGradeSelect schoolLevel={school.school_level} value={f.class_grade ?? ''}
                    onChange={(v) => setF((d) => ({
                      ...d, class_grade: v,
                      // Drop answers the newly chosen level does not ask for.
                      ...(isTertiaryLearner(v, school.school_level) ? { stream: null, boarding_status: null } : { phone: null, whatsapp: null, email: null }),
                    }))} /></Field>
                </div>
                {/* No streams or dormitories beyond secondary school. */}
                {!tertiary && (
                  <Field label="Stream / Dormitory"><Input value={f.stream ?? ''} onChange={set('stream')} /></Field>
                )}
              </div>
            )}
            {/* Only once a class is chosen, and only for nursery to secondary (not vocational / university). */}
            {group === 'pupil' && !!f.class_grade && !tertiary && <Field label="Day or boarding"><Chips options={['Day', 'Boarding']} value={f.boarding_status ?? ''} onChange={(v) => setF((d) => ({ ...d, boarding_status: v }))} /></Field>}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Date of birth"><Input type="date" value={f.date_of_birth ?? ''} onChange={set('date_of_birth')} /></Field>
              <Field label="Age"><Input inputMode="numeric" value={(f.age as any) ?? ''} onChange={set('age')} /></Field>
              {/* A learner's own contacts only from vocational / university level; younger students are reached through the guardian. */}
              {(group !== 'pupil' || tertiary) && (
                <>
                  <Field label="Phone (optional)"><Input inputMode="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
                  <Field label="WhatsApp (optional)"><Input inputMode="tel" value={f.whatsapp ?? ''} onChange={set('whatsapp')} /></Field>
                </>
              )}
            </div>
            {(group !== 'pupil' || tertiary) && <Field label="Email (optional)"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>}
            <Field label="National ID / School ID / Admission No."><Input value={f.id_number ?? ''} onChange={set('id_number')} /></Field>
            {(group === 'teacher' || group === 'staff') && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Subject / department / role"><Input value={f.subject_department ?? ''} onChange={set('subject_department')} /></Field>
                <Field label="Staff ID"><Input value={f.staff_id ?? ''} onChange={set('staff_id')} /></Field>
                <Field label="Years at school"><Input inputMode="numeric" value={(f.years_at_school as any) ?? ''} onChange={set('years_at_school')} /></Field>
                <Field label="Next of kin / residence"><Input value={f.next_of_kin ?? ''} onChange={set('next_of_kin')} /></Field>
              </div>
            )}
            {group === 'parent' && <Field label="Occupation"><Input value={f.guardian_occupation ?? ''} onChange={set('guardian_occupation')} /></Field>}
          </>
        )}
      </FormSection>

      {group === 'pupil' && (
        <FormSection title="Parent or guardian">
          <Field label="Full name"><Input value={f.guardian_name ?? ''} onChange={set('guardian_name')} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone"><Input inputMode="tel" value={f.guardian_phone ?? ''} onChange={set('guardian_phone')} /></Field>
            <Field label="WhatsApp"><Input inputMode="tel" value={f.guardian_whatsapp ?? ''} onChange={set('guardian_whatsapp')} /></Field>
          </div>
          <Field label="Occupation"><Input value={f.guardian_occupation ?? ''} onChange={set('guardian_occupation')} /></Field>
          <HomeVillagePicker onPick={(v) => setF((d) => ({ ...d, residence_village: v }))} />
          <Field label="Needs fee / rent support?"><Chips options={['Yes', 'No']} value={f.fee_support_need == null ? '' : f.fee_support_need ? 'Yes' : 'No'} onChange={(v) => setF((d) => ({ ...d, fee_support_need: v === 'Yes' }))} /></Field>
        </FormSection>
      )}

      {group !== 'asset' && (
        <FormSection title="Phone and gate">
          <div id="wsr-phone" className="scroll-mt-40 space-y-2">
            <Label className="text-sm">Has a smartphone?</Label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" aria-pressed={hasPhone === true} onClick={() => setHasPhone(true)} className={cn('flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-center text-sm font-medium', hasPhone === true ? 'border-primary bg-primary text-primary-foreground' : missing === 'phone' ? 'border-destructive bg-background' : 'border-border bg-background')}>
                <Smartphone className="h-5 w-5" />Yes, has one
              </button>
              <button type="button" aria-pressed={hasPhone === false} onClick={() => setHasPhone(false)} className={cn('flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-center text-sm font-medium', hasPhone === false ? 'border-primary bg-primary text-primary-foreground' : missing === 'phone' ? 'border-destructive bg-background' : 'border-border bg-background')}>
                <Gift className="h-5 w-5" />No, needs a free one
              </button>
            </div>
            <MissingNote show={missing === 'phone'} text={MISSING_TEXT.phone} />
          </div>
          {hasPhone === false && (
            <div className="space-y-2 rounded-2xl bg-primary/5 p-3">
              <p className="text-sm font-semibold">Welile will provide a FREE Smartphone so they can access Welile App.</p>
              <Field label="Basic phone or guardian / head teacher number"><Input inputMode="tel" value={f.smartphone_contact_phone ?? ''} onChange={set('smartphone_contact_phone')} /></Field>
              <Field label="Preferred handover point"><Input placeholder={school.gate_name ?? 'Main Gate'} value={f.smartphone_handover_point ?? ''} onChange={set('smartphone_handover_point')} /></Field>
              <Field label="ID / school verification"><Chips options={['Verified', 'Not verified']} value={f.smartphone_verification_status ?? ''} onChange={(v) => setF((d) => ({ ...d, smartphone_verification_status: v }))} /></Field>
            </div>
          )}
          {/* A switch row, like a phone's settings list. */}
          <button type="button" role="switch" aria-checked={logEntry} onClick={() => setLogEntry((v) => !v)}
            className="flex min-h-[52px] w-full items-center gap-3 rounded-2xl bg-muted/50 px-3 text-left text-sm">
            <LogIn className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">Log as entered at the gate now</span>
              <span className="block text-xs text-muted-foreground">Records an IN at {school.gate_name || 'Main Gate'}</span>
            </span>
            <span className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', logEntry ? 'bg-primary' : 'bg-muted-foreground/30')} aria-hidden>
              <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-background shadow transition-all', logEntry ? 'left-[22px]' : 'left-0.5')} />
            </span>
          </button>
        </FormSection>
      )}

      {/* Save stays on screen while the agent scrolls the form. */}
      <div className="sticky bottom-0 z-10 -mx-3 border-t border-border/60 bg-background/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <Button className="min-h-[52px] w-full rounded-2xl text-base" onClick={submit} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save student</Button>
      </div>
      </>
      )}
    </div>
  );
}

export function SignupLinkCard({ row, saved, school, agentId }: { row: SchoolProfileRow; saved: boolean; school: Pick<SchoolRow, 'id' | 'name'>; agentId: string }) {
  const link = useMemo(() => buildSchoolSignupLink(agentId, school.id, row.id), [agentId, school.id, row.id]);
  const msg = buildSignupMessage(row.full_name, school.name, link);
  const phone = toIntlDigits(row.whatsapp || row.phone || row.guardian_whatsapp || row.guardian_phone);
  const [sent, setSent] = useState(!!row.signup_link_sent);
  const mark = (c: 'whatsapp' | 'sms' | 'copy') => { if (saved) markSignupSent(row.id, c).then(() => setSent(true)); };
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-primary" /><p className="text-sm font-semibold flex-1">Send sign-up link to {row.full_name}</p>{sent && <CheckCircle2 className="h-4 w-4 text-primary" />}</div>
      <div className="grid grid-cols-3 gap-2">
        <Button asChild variant="outline" className="min-h-[44px]" onClick={() => mark('whatsapp')}>
          <a href={`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 mr-1" />WhatsApp</a>
        </Button>
        <Button asChild variant="outline" className="min-h-[44px]" onClick={() => mark('sms')}>
          <a href={`sms:${phone ? '+' + phone : ''}?body=${encodeURIComponent(msg)}`}><MessageSquare className="h-4 w-4 mr-1" />SMS</a>
        </Button>
        <Button variant="outline" className="min-h-[44px]" onClick={() => { navigator.clipboard?.writeText(link); toast.success('Link copied'); mark('copy'); }}><Copy className="h-4 w-4 mr-1" />Copy</Button>
      </div>
      {!saved && <p className="text-xs text-muted-foreground">Saved on this phone; the sent mark is recorded once it uploads.</p>}
    </Card>
  );
}

export { roleLabel };

/** Home cell / village from the shared Uganda location list (no free text). */
function HomeVillagePicker({ onPick }: { onPick: (village: string) => void }) {
  const [sel, setSel] = useState<UgLocationSelection | null>(null);
  return (
    <UgLocationPicker
      label="Home cell / village"
      value={sel}
      onChange={(s) => { setSel(s); onPick(s ? s.fullPath || s.village : ''); }}
    />
  );
}

export function RegionDistrictBrowser({ region, district, onRegion, onDistrict }: { region: string | null; district: string | null; onRegion: (r: string) => void; onDistrict: (d: string, r: string | null) => void }) {
  const { data: all = [] } = useUgDistricts();
  const [filterText, setFilterText] = useState('');
  const q = filterText.trim().toLowerCase();
  const list = all.filter(d => (!region || d.region === region) && (!q || d.name.toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  return <div className="space-y-3">
    <p className="text-xs font-medium text-muted-foreground">1. Select Region</p>
    <div className="grid grid-cols-2 gap-2">{UG_REGIONS.map(r => <Button key={r} variant={region === r ? 'default' : 'outline'} className="min-h-11" aria-pressed={region === r} onClick={() => onRegion(r)}>{r} ({all.filter(d => d.region === r).length})</Button>)}</div>
    {(region || q) && <>
      <p className="text-xs font-medium text-muted-foreground">2. Select District{region ? ` in ${region}` : ''}</p>
      <Input aria-label="Filter districts" placeholder="Search or filter district..." value={filterText} onChange={e => setFilterText(e.target.value)} />
      <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">{list.map(d => <Button key={d.id} size="sm" variant={district === d.name ? 'default' : 'outline'} className="min-h-[40px]" aria-pressed={district === d.name} onClick={() => onDistrict(d.name, d.region)}>{d.name}</Button>)}{list.length === 0 && <p className="text-xs text-muted-foreground">No matching district</p>}</div>
    </>}
    {district && <p className="text-xs font-medium text-muted-foreground">3. Sub-county / Parish / Village (optional)</p>}
  </div>;
}

const GATE_IN_NOTES = ['Morning arrival', 'Returned to school', 'Parent visit', 'Supply delivery', 'Official visit'];
const GATE_OUT_NOTES = ['Going home', 'Picked up by parent', 'Permission slip', 'Official duty', 'Completed visit'];

export function DailyGateLogView({ school, agentId, onQueued, onSwitchToRegister }: { school: SchoolRow; agentId: string; onQueued: () => void; onSwitchToRegister: () => void }) {
  const [logs, setLogs] = useState<SchoolGateLogRow[]>(() => readLocalGateLogs(school.id));
  const [profiles, setProfiles] = useState<SchoolProfileRow[]>([]);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [role, setRole] = useState<string>('pupil');
  const [f, setF] = useState({ person_name: '', class_or_department: '', phone: '', purpose_or_note: '', pickup_guardian_name: '', pickup_guardian_phone: '' });
  const [saving, setSaving] = useState(false);
  const [rosterFilter, setRosterFilter] = useState<'all' | 'inside' | 'pupil' | 'staff' | 'parent'>('all');
  const [rosterSearch, setRosterSearch] = useState('');
  // Scan a student's QR code: open camera → show their card → one tap records IN or OUT.
  const [tab, setTab] = useState('roster');
  const [scanOpen, setScanOpen] = useState(false);
  const [scanned, setScanned] = useState<SchoolProfileRow | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const refresh = () => setLogs(readLocalGateLogs(school.id));

  const onStudentScanned = async (profileId: string) => {
    setScanOpen(false);
    let p: SchoolProfileRow | null = profiles.find((x) => x.id === profileId) ?? null;
    if (!p) {
      setLookingUp(true);
      const { data } = await db.from('welile_school_profiles').select('*').eq('id', profileId).maybeSingle();
      setLookingUp(false);
      p = (data as SchoolProfileRow | null) ?? readPendingProfiles().find((x) => x.id === profileId) ?? null;
    }
    if (!p) { toast.error('Student not found', { description: 'This code is not linked to a student you can see. Register them first.' }); return; }
    if (p.school_id !== school.id) { toast.error('Student is registered at another school', { description: `${p.full_name ?? 'This student'} is not on ${school.name}'s list.` }); return; }
    setScanned(p);
  };

  const recordScanned = async (dir: 'in' | 'out') => {
    if (!scanned) return;
    const res = await record({
      direction: dir, role_type: scanned.role, person_name: scanned.full_name || 'Unknown', profile_id: scanned.id,
      phone: scanned.phone || scanned.guardian_phone || null,
      class_or_department: scanned.class_grade || scanned.subject_department || null,
      purpose_or_note: 'Scanned QR code',
      pickup_guardian_name: scanned.guardian_name || null, pickup_guardian_phone: scanned.guardian_phone || null,
    });
    if (res.saved) toast.success(dir === 'in' ? `🟢 ${scanned.full_name} recorded ENTERING` : `🔴 ${scanned.full_name} recorded LEAVING`);
  };

  useEffect(() => {
    db.from('welile_school_gate_logs').select('*').eq('school_id', school.id).order('recorded_at', { ascending: false }).limit(1000)
      .then(({ data }: { data: SchoolGateLogRow[] | null }) => {
        if (!data) return;
        const merged = [...readLocalGateLogs(school.id)];
        data.forEach((l) => { if (!merged.some((m) => m.id === l.id)) merged.push(l); });
        writeLocalGateLogsOnly(merged);
        refresh();
      });
    db.from('welile_school_profiles').select('*').eq('school_id', school.id).order('created_at', { ascending: false }).limit(2000)
      .then(({ data }: { data: SchoolProfileRow[] | null }) => {
        const pending = readPendingProfiles().filter((p) => p.school_id === school.id);
        const all = [...(data ?? [])];
        pending.forEach((p) => { if (!all.some((a) => a.id === p.id)) all.push(p); });
        setProfiles(all.filter((p) => p.role !== 'asset'));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [school.id]);

  const summary = useMemo(() => computeGateMovementSummary(logs), [logs]);

  const record = async (entry: Partial<SchoolGateLogRow> & { person_name: string; role_type: string; direction: 'in' | 'out'; profile_id?: string | null }) => {
    const id = safeUUID();
    const row: SchoolGateLogRow = {
      id, client_ref: id, school_id: school.id, agent_id: agentId,
      gate_name: school.gate_name || 'Main Gate', recorded_at: new Date().toISOString(),
      phone: null, class_or_department: null, purpose_or_note: null,
      pickup_guardian_name: null, pickup_guardian_phone: null,
      ...entry,
    };
    const res = await saveGateLog(row);
    refresh();
    if (!res.saved) { onQueued(); toast.message('No connection — gate log saved on this phone, will send automatically'); }
    return res;
  };

  const submitQuick = async () => {
    if (!f.person_name.trim()) { toast.error('Enter the full name'); return; }
    setSaving(true);
    await record({
      direction, role_type: role, person_name: f.person_name.trim(),
      phone: f.phone.trim() || null,
      class_or_department: f.class_or_department.trim() || null,
      purpose_or_note: f.purpose_or_note || null,
      pickup_guardian_name: f.pickup_guardian_name.trim() || null,
      pickup_guardian_phone: f.pickup_guardian_phone.trim() || null,
    });
    setSaving(false);
    toast.success(direction === 'in' ? `🟢 ${f.person_name.trim()} recorded ENTERING ${school.gate_name || 'Main Gate'}` : `🔴 ${f.person_name.trim()} recorded LEAVING ${school.gate_name || 'Main Gate'}`);
    setF({ person_name: '', class_or_department: '', phone: '', purpose_or_note: '', pickup_guardian_name: '', pickup_guardian_phone: '' });
  };

  const mark = async (p: SchoolProfileRow, dir: 'in' | 'out') => {
    const res = await record({
      direction: dir, role_type: p.role, person_name: p.full_name || 'Unknown', profile_id: p.id,
      phone: p.phone || p.guardian_phone || null,
      class_or_department: p.class_grade || p.subject_department || null,
      pickup_guardian_name: p.guardian_name || null, pickup_guardian_phone: p.guardian_phone || null,
    });
    if (res.saved) toast.success(dir === 'in' ? `🟢 ${p.full_name} marked IN` : `🔴 ${p.full_name} marked OUT`);
  };

  const flip = async (log: SchoolGateLogRow) => {
    const res = await flipGateLogDirection(log);
    refresh();
    if (!res.saved) onQueued();
    toast.success(`${log.person_name} corrected to ${res.row.direction === 'in' ? '🟢 IN' : '🔴 OUT'}`);
  };

  const needle = rosterSearch.trim().toLowerCase();
  const roster = profiles.filter((p) => {
    const st = summary.personStatus[p.id];
    if (rosterFilter === 'inside' && st?.direction !== 'in') return false;
    if (rosterFilter === 'pupil' && roleGroup(p.role) !== 'pupil') return false;
    if (rosterFilter === 'staff' && !['teacher', 'staff'].includes(roleGroup(p.role))) return false;
    if (rosterFilter === 'parent' && roleGroup(p.role) !== 'parent') return false;
    if (!needle) return true;
    return [p.full_name, p.class_grade, p.subject_department, p.phone, p.guardian_phone].some((v) => v?.toLowerCase().includes(needle));
  });

  const groups = [
    { label: 'Pupils', g: summary.byGroup.pupil },
    { label: 'Staff', g: summary.byGroup.staff },
    { label: 'Visitors', g: summary.byGroup.visitor },
  ];

  return (
    <div className="space-y-4">
      {/* Today at the gate: one card with the three totals and who is inside by group. */}
      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="grid grid-cols-3 divide-x divide-border/60 text-center">
          <div><p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{summary.enteredToday}</p><p className="text-xs text-muted-foreground">In today</p></div>
          <div><p className="text-2xl font-bold tabular-nums text-destructive">{summary.exitedToday}</p><p className="text-xs text-muted-foreground">Out today</p></div>
          <div><p className="text-2xl font-bold tabular-nums">{summary.currentlyInside}</p><p className="text-xs text-muted-foreground">Inside now</p></div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {groups.map(({ label, g }) => (
            <div key={label} className="rounded-xl bg-muted/50 px-2 py-1.5 text-center" title={`${g.in} in · ${g.out} out today`}>
              <p className="text-sm font-semibold tabular-nums">{g.inside}</p>
              <p className="text-[11px] text-muted-foreground">{label} inside</p>
            </div>
          ))}
        </div>
      </section>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="grid h-11 w-full grid-cols-3 rounded-full bg-muted p-1">
          <TabsTrigger value="roster" className="rounded-full">Roster</TabsTrigger>
          <TabsTrigger value="new" className="rounded-full">New entry</TabsTrigger>
          <TabsTrigger value="timeline" className="rounded-full">Timeline{summary.todayLogs.length ? ` (${summary.todayLogs.length})` : ''}</TabsTrigger>
        </TabsList>

        {/* Roster: tap a registered person in or out. One button, based on where they are now. */}
        <TabsContent value="roster" className="mt-3 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input aria-label="Search roster" placeholder="Search name, class or phone" className="h-12 rounded-full pl-9" value={rosterSearch} onChange={(e) => setRosterSearch(e.target.value)} />
          </div>
          <div className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]">
            {([['all', 'All'], ['inside', 'Inside'], ['pupil', 'Pupils'], ['staff', 'Staff'], ['parent', 'Parents & suppliers']] as const).map(([k, label]) => (
              <button key={k} type="button" aria-pressed={rosterFilter === k} onClick={() => setRosterFilter(k)}
                className={cn('min-h-[36px] shrink-0 rounded-full px-3.5 text-sm font-medium transition-colors', rosterFilter === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-muted/70')}>
                {label}
              </button>
            ))}
          </div>
          <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
            {roster.map((p) => {
              const st = summary.personStatus[p.id];
              const inside = st?.direction === 'in';
              return (
                <div key={p.id} className="flex items-center gap-3 p-3">
                  <span className={cn('relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-bold text-muted-foreground')}>
                    {(p.full_name || '?').trim().charAt(0).toUpperCase()}
                    <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card', inside ? 'bg-emerald-500' : st?.direction === 'out' ? 'bg-destructive' : 'bg-muted-foreground/40')} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.full_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {inside ? `Inside since ${formatEatTime(st.recorded_at)}` : st?.direction === 'out' ? `Left at ${formatEatTime(st.recorded_at)}` : 'Not recorded today'}
                      {p.class_grade || p.subject_department ? ` · ${p.class_grade || p.subject_department}` : ` · ${roleLabel(p.role)}`}
                    </p>
                  </div>
                  {inside ? (
                    <Button size="sm" variant="outline" className="min-h-[40px] shrink-0 gap-1 rounded-full border-destructive/40 text-destructive hover:bg-destructive/5 hover:text-destructive" aria-label={`Mark ${p.full_name} OUT`} onClick={() => mark(p, 'out')}>
                      <LogOut className="h-4 w-4" />Out
                    </Button>
                  ) : (
                    <Button size="sm" className="min-h-[40px] shrink-0 gap-1 rounded-full bg-emerald-600 text-white hover:bg-emerald-700" aria-label={`Mark ${p.full_name} IN`} onClick={() => mark(p, 'in')}>
                      <LogIn className="h-4 w-4" />In
                    </Button>
                  )}
                </div>
              );
            })}
            {!roster.length && (
              <div className="space-y-2 p-4 text-center">
                <p className="text-sm text-muted-foreground">No registered people match.</p>
                <Button variant="outline" size="sm" className="min-h-[40px] rounded-full" onClick={onSwitchToRegister}>Register a student</Button>
              </div>
            )}
          </div>
        </TabsContent>

        {/* New entry: someone not on the roster (visitor, supplier, or not registered yet). */}
        <TabsContent value="new" className="mt-3 space-y-3">
          {/* Fastest way for a registered student: scan their QR code, check the photo, tap once. */}
          {scanned ? (
            <ScannedStudentCard student={scanned} now={summary.personStatus[scanned.id] ?? null} onRecord={recordScanned}
              onScanNext={() => { setScanned(null); setScanOpen(true); }} onDone={() => setScanned(null)} />
          ) : (
            <button type="button" onClick={() => setScanOpen(true)} disabled={lookingUp}
              className="flex min-h-[72px] w-full items-center gap-3 rounded-3xl border-2 border-dashed border-primary/50 bg-primary/5 p-3 text-left hover:bg-primary/10 disabled:opacity-60">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                {lookingUp ? <Loader2 className="h-5 w-5 animate-spin" /> : <ScanLine className="h-5 w-5" />}
              </span>
              <span>
                <span className="block font-semibold">{lookingUp ? 'Finding the student…' : 'Scan student QR code'}</span>
                <span className="block text-sm text-muted-foreground">See their photo and details, then record IN or OUT in one tap.</span>
              </span>
            </button>
          )}
          <StudentQrScanner open={scanOpen} onClose={() => setScanOpen(false)} onStudent={(id) => { void onStudentScanned(id); }} />
          {/* The typed form is hidden while a scanned student's card is open, so only one record button shows. */}
          {!scanned && (<>
          <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Or record someone without a code</p>
          <div className="grid grid-cols-2 gap-1 rounded-full bg-muted p-1" role="group" aria-label="Direction">
            <button type="button" aria-pressed={direction === 'in'} onClick={() => setDirection('in')}
              className={cn('flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors', direction === 'in' ? 'bg-emerald-600 text-white shadow' : 'text-muted-foreground')}>
              <LogIn className="h-4 w-4" />Entering
            </button>
            <button type="button" aria-pressed={direction === 'out'} onClick={() => setDirection('out')}
              className={cn('flex min-h-[44px] items-center justify-center gap-1.5 rounded-full text-sm font-semibold transition-colors', direction === 'out' ? 'bg-destructive text-destructive-foreground shadow' : 'text-muted-foreground')}>
              <LogOut className="h-4 w-4" />Leaving
            </button>
          </div>
          <div className="space-y-3 rounded-3xl border border-border/70 bg-card p-4">
            <Field label="Who is it?">
              <div className="relative">
                <select aria-label="Who is it?" value={role} onChange={(e) => setRole(e.target.value)}
                  className="flex h-12 w-full appearance-none rounded-lg border border-input bg-background px-4 pr-10 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring">
                  {GATE_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              </div>
            </Field>
            <Field label="Full name"><Input aria-label="Gate person name" placeholder="Type full name" value={f.person_name} onChange={(e) => setF((d) => ({ ...d, person_name: e.target.value }))} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Class / dept."><Input placeholder="e.g. P.5, S.2" value={f.class_or_department} onChange={(e) => setF((d) => ({ ...d, class_or_department: e.target.value }))} /></Field>
              <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={(e) => setF((d) => ({ ...d, phone: e.target.value }))} /></Field>
            </div>
            <Field label="Reason (optional)"><Chips options={direction === 'in' ? GATE_IN_NOTES : GATE_OUT_NOTES} value={f.purpose_or_note} onChange={(v) => setF((d) => ({ ...d, purpose_or_note: d.purpose_or_note === v ? '' : v }))} /></Field>
            {(role === 'pupil' || direction === 'out') && (
              <div className="grid grid-cols-2 gap-2">
                <Field label={direction === 'out' ? 'Picked up by' : 'Came with'}><Input placeholder="Guardian name" value={f.pickup_guardian_name} onChange={(e) => setF((d) => ({ ...d, pickup_guardian_name: e.target.value }))} /></Field>
                <Field label="Guardian phone"><Input inputMode="tel" value={f.pickup_guardian_phone} onChange={(e) => setF((d) => ({ ...d, pickup_guardian_phone: e.target.value }))} /></Field>
              </div>
            )}
          </div>
          <div className="sticky bottom-0 z-10 -mx-3 border-t border-border/60 bg-background/95 px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
            <Button className={cn('min-h-[52px] w-full gap-2 rounded-2xl text-base', direction === 'in' ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90')} disabled={saving} onClick={submitQuick}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : direction === 'in' ? <LogIn className="h-5 w-5" /> : <LogOut className="h-5 w-5" />}
              {direction === 'in' ? 'Record entry' : 'Record exit'}
            </Button>
          </div>
          </>)}
        </TabsContent>

        {/* Timeline: today's movements, newest first, with a one-tap correction. */}
        <TabsContent value="timeline" className="mt-3">
          <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/70 bg-card">
            {summary.todayLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 p-3">
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', log.direction === 'in' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive')}>
                  {log.direction === 'in' ? <LogIn className="h-4 w-4" aria-label="In" /> : <LogOut className="h-4 w-4" aria-label="Out" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{log.person_name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {formatEatTime(log.recorded_at)} · {roleLabel(log.role_type)}
                    {log.purpose_or_note ? ` · ${log.purpose_or_note}` : ''}
                    {log.pickup_guardian_name ? ` · with ${log.pickup_guardian_name}` : ''}
                  </p>
                </div>
                <Button size="icon" variant="ghost" className="h-10 w-10 shrink-0 rounded-full text-muted-foreground" title="Recorded the wrong way? Flip IN/OUT" aria-label={`Flip direction for ${log.person_name}`} onClick={() => flip(log)}>
                  <Repeat className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {!summary.todayLogs.length && <p className="p-4 text-center text-sm text-muted-foreground">No gate movements recorded yet today.</p>}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function writeLocalGateLogsOnly(rows: SchoolGateLogRow[]) {
  const others = readLocalGateLogs().filter((l) => !rows.some((r) => r.id === l.id));
  writeLocalGateLogs([...others, ...rows]);
}

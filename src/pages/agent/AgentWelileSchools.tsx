import { safeUUID } from '@/lib/safeUUID';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GraduationCap, Lock, LockOpen, MapPin, Loader2, Smartphone, Gift, MessageCircle, MessageSquare, Copy, CheckCircle2, CloudOff, Bot, ClipboardList, Pencil, Send, RotateCcw, Sparkles, ChevronRight, LogIn, LogOut, Repeat, ChevronDown, Camera, Search } from 'lucide-react';
import SchoolPartnershipPanel from '@/components/welile-schools/SchoolPartnershipPanel';
import WelileSchoolsBrand from '@/components/welile-schools/WelileSchoolsBrand';
import StudentPhotoCapture from '@/components/welile-schools/StudentPhotoCapture';
import StudentProfileSummary from '@/components/welile-schools/StudentProfileSummary';
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
          className={cn('min-h-[44px] px-3 rounded-xl border text-sm', value === o ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border')}>
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
  const [mode, setMode] = useState<'gate' | 'register' | 'partner'>(() => (initialMode === 'register' || initialMode === 'partner' ? initialMode : 'gate'));

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
            <Button className="w-full min-h-[48px] gap-2 whitespace-normal" onClick={startBot}><MessageCircle className="h-5 w-5 shrink-0" />Register a School with Welile Bot</Button>
            <Button variant="ghost" className="w-full min-h-[44px]" onClick={startBot}>+ Register a new school</Button>
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
              <GateRegistration school={locked} agentId={user.id} onQueued={() => { setPendingCount(readPendingProfiles().length); setGatePendingCount(readPendingGateLogs().length); }} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

export function SchoolRegistration({ draft, setDraft, captureGps, gpsBusy, saving, onSave, onCancel }: {
  draft: Partial<SchoolRow>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<SchoolRow>>>;
  captureGps: () => Promise<boolean | undefined>;
  gpsBusy: boolean;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState<number[]>([]);
  const [ugSchoolLoc, setUgSchoolLoc] = useState<UgLocationSelection | null>(null);
  const [manualGps, setManualGps] = useState(false);
  const [otherCountry, setOtherCountry] = useState(draft.country !== 'Uganda');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' }); }, [step, mode, completed]);
  const update = (key: keyof SchoolRow, value: string | number | null) => setDraft(d => ({ ...d, [key]: value }));
  const locationPath = [draft.country, draft.region, draft.district, draft.sub_county, draft.parish, draft.village].filter(Boolean).join(' → ');
  const pinned = draft.latitude != null && draft.longitude != null && Number.isFinite(draft.latitude) && Number.isFinite(draft.longitude);
  const coordinateText = pinned ? `${draft.latitude?.toFixed(5)}, ${draft.longitude?.toFixed(5)}${draft.gps_accuracy_m != null ? ` (±${draft.gps_accuracy_m}m)` : ''}` : 'GPS skipped for now';
  const finish = (n: number) => {
    if (n === 1 && (draft.name?.trim().length ?? 0) < 2) { toast.error('Enter the school name'); return; }
    if (n === 3 && (draft.country === 'Uganda' ? !(ugSchoolLoc || (draft.region && draft.district)) : !draft.country || draft.country === 'Uganda')) { toast.error('Choose the school location'); return; }
    setCompleted(c => [...new Set([...c, n])]);
    setStep(n + 1);
  };
  const reset = () => { setDraft({ ...EMPTY_SCHOOL }); setUgSchoolLoc(null); setOtherCountry(false); setCompleted([]); setStep(1); setManualGps(false); };
  const pickLocation = (sel: UgLocationSelection | null) => {
    setUgSchoolLoc(sel);
    setDraft(d => ({ ...d, country: 'Uganda', region: sel?.region ?? d.region ?? null, district: sel?.district ?? d.district ?? null, sub_county: sel?.subcounty ?? null, parish: sel?.parish ?? null, village: sel?.village ?? null, town: d.town || sel?.county || null }));
  };
  const chooseCountryMode = (other: boolean) => {
    setOtherCountry(other); setUgSchoolLoc(null);
    setDraft(d => ({ ...d, country: other ? '' : 'Uganda', region: null, district: null, sub_county: null, parish: null, village: null, town: null }));
  };
  const prompts = [
    <>👋 Hi! I'm the Welile Schools Bot. Let's register this school right at the gate. First, what is the <strong>name of the school</strong>?</>,
    <>Got it — <strong>{draft.name}</strong>! 🏫 What <strong>level</strong> and <strong>ownership</strong> is this school?</>,
    <>🗺️ Where is <strong>{draft.name}</strong> located? Browse by <strong>Region → District</strong> or search the village/cell:</>,
    <>📍 Great — <strong>{draft.name}</strong> is in <strong>{[draft.village, draft.district, draft.region ? `${draft.region} Region` : null].filter(Boolean).join(', ') || draft.country || 'this location'}</strong>! Now stand at the <strong>{draft.gate_name || 'Main Gate'}</strong> and tap below to capture the exact Gate GPS coordinates.</>,
    <>👤 Almost done! Who is the <strong>Headteacher or main contact</strong> at <strong>{draft.name}</strong>, and roughly how many learners are enrolled? (You can also tap Skip)</>,
    <>✨ Here is the summary for <strong>{draft.name}</strong>. Everything look good?</>,
  ];
  const replies = [ `${draft.name} (${draft.gate_name || 'Main Gate'})`, `${draft.school_level} • ${draft.ownership}`, locationPath, pinned ? `📍 Gate GPS pinned: ${coordinateText}` : coordinateText, [draft.head_name, draft.head_phone, draft.estimated_enrollment != null ? `${draft.estimated_enrollment.toLocaleString()} learners` : null].filter(Boolean).join(' • ') || 'Contact details skipped for now' ];
  const levels = [...SCHOOL_LEVELS, 'Mixed / K-12'];
  const coords = <div className="grid grid-cols-2 gap-2">
    <Field label="Latitude"><Input type="number" step="any" min={-90} max={90} inputMode="decimal" value={draft.latitude ?? ''} onChange={e => setDraft(d => ({ ...d, latitude: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} /></Field>
    <Field label="Longitude"><Input type="number" step="any" min={-180} max={180} inputMode="decimal" value={draft.longitude ?? ''} onChange={e => setDraft(d => ({ ...d, longitude: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} /></Field>
  </div>;
  const gps = <div className="space-y-3">
    <Button className="min-h-12 w-full gap-2" disabled={gpsBusy} onClick={async () => { if (await captureGps()) { if (mode === 'chat') finish(4); } }}>{gpsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}Capture Gate GPS Now</Button>
    {pinned && <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1 text-sm"><p className="text-primary font-medium break-words">📍 {coordinateText}</p>{[draft.district, draft.region].filter(Boolean).length > 0 && <p className="text-xs text-muted-foreground">{[draft.district, draft.region].filter(Boolean).join(', ')}</p>}<a className="text-primary underline inline-flex items-center gap-1 min-h-11" href={`https://www.google.com/maps?q=${draft.latitude},${draft.longitude}`} target="_blank" rel="noreferrer"><MapPin className="h-4 w-4" />View on Google Maps</a></div>}
    <Button variant="ghost" className="min-h-11 w-full" aria-expanded={manualGps} onClick={() => setManualGps(v => !v)}>Enter coordinates manually</Button>
    {manualGps && <div className="space-y-2">{coords}{mode === 'chat' && <Button variant="outline" className="w-full min-h-11" disabled={!pinned || Math.abs(draft.latitude ?? 0) > 90 || Math.abs(draft.longitude ?? 0) > 180} onClick={() => finish(4)}>Confirm coordinates <ChevronRight className="h-4 w-4" /></Button>}</div>}
    {mode === 'chat' && <Button variant="ghost" className="min-h-11 w-full" onClick={() => { setDraft(d => ({ ...d, latitude: null, longitude: null, gps_accuracy_m: null, gps_source: null })); finish(4); }}>Skip GPS for now</Button>}
  </div>;
  const location = <div className="space-y-3">
    <div className="flex flex-wrap gap-2"><Button variant={!otherCountry ? 'default' : 'outline'} className="min-h-11" onClick={() => { if (otherCountry) chooseCountryMode(false); }}>🇺🇬 Uganda</Button><Button variant={otherCountry ? 'default' : 'outline'} className="min-h-11" onClick={() => { if (!otherCountry) chooseCountryMode(true); }}>🌍 Other Country</Button></div>
    {otherCountry ? <CountryCombobox value={draft.country || ''} onChange={value => { if (value === 'Uganda') chooseCountryMode(false); else update('country', value); }} /> : <><RegionDistrictBrowser region={draft.region ?? null} district={draft.district ?? null} onRegion={reg => { if (reg !== draft.region) { setUgSchoolLoc(null); setDraft(d => ({ ...d, region: reg, district: null, sub_county: null, parish: null, village: null })); } }} onDistrict={(dist, reg) => { if (dist !== draft.district) setUgSchoolLoc(null); setDraft(d => ({ ...d, region: reg ?? d.region ?? null, district: dist, ...(dist !== d.district ? { sub_county: null, parish: null, village: null } : {}) })); }} /><UgLocationPicker label="Search or browse school cell / village" districtName={draft.district || null} value={ugSchoolLoc} onChange={pickLocation} /></>}
    <Field label="Town / City (optional)"><Input value={draft.town ?? ''} onChange={e => update('town', e.target.value)} /></Field>
    {mode === 'chat' && <Button className="w-full min-h-11" onClick={() => finish(3)}>Confirm Location <ChevronRight className="h-4 w-4" /></Button>}
  </div>;
  const contact = <div className="space-y-3">
    <Field label="Headteacher name"><Input value={draft.head_name ?? ''} onChange={e => update('head_name', e.target.value)} /></Field>
    <Field label="Headteacher phone"><Input inputMode="tel" value={draft.head_phone ?? ''} onChange={e => update('head_phone', e.target.value)} /></Field>
    <Field label="Estimated enrolment"><Input type="number" min={0} inputMode="numeric" value={draft.estimated_enrollment ?? ''} onChange={e => update('estimated_enrollment', e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))))} /></Field>
    <div className="flex flex-wrap gap-2">{[200, 500, 1000, 2000].map(n => <Button key={n} variant="outline" className="min-h-11" onClick={() => update('estimated_enrollment', n)}>~{n.toLocaleString()}{n === 2000 ? '+' : ''}</Button>)}</div>
    {mode === 'chat' && <><Button className="min-h-11 w-full" onClick={() => finish(5)}>Continue <ChevronRight className="h-4 w-4" /></Button><Button variant="ghost" className="min-h-11 w-full" onClick={() => { setDraft(d => ({ ...d, head_name: null, head_phone: null, estimated_enrollment: null })); finish(5); }}>Skip for now</Button></>}
  </div>;
  const name = <form className="space-y-3" onSubmit={e => { e.preventDefault(); finish(1); }}>
    <div className="flex gap-2"><Input aria-label="School name" className="min-h-12 flex-1 min-w-0" placeholder="Type school name e.g. Kampala Parents School..." value={draft.name ?? ''} onChange={e => update('name', e.target.value)} /><Button type="submit" size="icon" className="h-12 w-12 shrink-0" aria-label="Send school name"><Send className="h-5 w-5" /></Button></div>
    <Field label="Gate name"><Input value={draft.gate_name ?? ''} onChange={e => update('gate_name', e.target.value)} /></Field>
    <Chips options={['Main Gate', 'Primary Gate', 'Back Gate', 'Admin Gate']} value={draft.gate_name || 'Main Gate'} onChange={v => update('gate_name', v)} />
  </form>;
  const level = <div className="space-y-3"><Field label="School level"><Chips options={levels} value={draft.school_level ?? ''} onChange={v => update('school_level', v)} /></Field><Field label="Ownership"><Chips options={SCHOOL_OWNERSHIP} value={draft.ownership ?? ''} onChange={v => update('ownership', v)} /></Field>{mode === 'chat' && <Button className="min-h-11 w-full" onClick={() => finish(2)}>Continue <ChevronRight className="h-4 w-4" /></Button>}</div>;
  const summary = <div className="space-y-3">
    <div className="divide-y divide-border">{[
      { n: 1, label: 'School & gate', value: replies[0] },
      { n: 2, label: 'Level & ownership', value: replies[1] },
      { n: 3, label: 'Location', value: locationPath || 'Not selected' },
      { n: 4, label: 'Gate GPS', value: coordinateText },
      { n: 5, label: 'Contact & enrolment', value: replies[4] },
    ].map(row => <Button key={row.n} variant="ghost" className="h-auto min-h-14 w-full justify-between whitespace-normal gap-2 rounded-none px-0 py-3 text-left" onClick={() => setStep(row.n)}><span className="min-w-0"><span className="block text-xs text-muted-foreground">{row.label}</span><span className="block text-sm break-words">{row.value}</span></span><Pencil className="h-4 w-4 shrink-0" /></Button>)}</div>
    <div className="flex flex-wrap gap-2"><Badge variant="secondary">{draft.school_level}</Badge><Badge variant="outline">{draft.ownership}</Badge></div>
    {pinned && <a className="text-sm text-primary underline inline-flex items-center gap-1 min-h-11" href={`https://www.google.com/maps?q=${draft.latitude},${draft.longitude}`} target="_blank" rel="noreferrer"><MapPin className="h-4 w-4" />View gate on Google Maps</a>}
    <Button className="w-full min-h-12 whitespace-normal gap-2" disabled={saving} onClick={onSave}>{saving ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}Register School & Lock Gate</Button>
    <Button variant="ghost" className="w-full min-h-11 gap-2" onClick={() => setStep(1)}><Pencil className="h-4 w-4" />Edit answers</Button>
  </div>;
  const content = [name, level, location, gps, contact, summary];
  return <section className="space-y-4 min-w-0">
    <div className="sticky top-14 z-10 bg-background/95 backdrop-blur border-b border-border py-3 space-y-3">
      <div className="flex gap-3 items-center"><div className="relative p-3 rounded-full bg-primary/10 text-primary"><Bot className="h-6 w-6" /><GraduationCap className="h-3 w-3 absolute bottom-0 right-0" /></div><div className="min-w-0 flex-1"><h2 className="font-semibold text-base">Welile Schools Bot</h2><p className="text-xs text-muted-foreground">Step-by-step school gate onboarding • {navigator.onLine ? 'Online' : 'Offline'}</p></div><Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Start Over" title="Start Over" disabled={saving || gpsBusy} onClick={reset}><RotateCcw className="h-4 w-4" /></Button></div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Registration mode"><Button variant={mode === 'chat' ? 'default' : 'outline'} aria-pressed={mode === 'chat'} className="min-h-11 gap-2" onClick={() => setMode('chat')}><Bot className="h-4 w-4" />Chat Bot</Button><Button variant={mode === 'form' ? 'default' : 'outline'} aria-pressed={mode === 'form'} className="min-h-11 gap-2" onClick={() => setMode('form')}><ClipboardList className="h-4 w-4" />Classic Form</Button></div>
      {mode === 'chat' && <div className="space-y-2"><p className="text-xs text-muted-foreground">Step {step} of 6</p><div className="grid grid-cols-6 gap-1" aria-label={`Step ${step} of 6`}>{[1, 2, 3, 4, 5, 6].map(n => <div key={n} className={cn('h-1 rounded-full', n <= step ? 'bg-primary' : 'bg-muted')} />)}</div></div>}
    </div>
    {mode === 'chat' ? <div className="space-y-5" aria-label="School registration conversation">
      {[1, 2, 3, 4, 5, 6].filter(n => completed.includes(n) || n === step).map(n => <div key={n} className="space-y-3">
        <div className="flex gap-2 items-start"><span className="p-1.5 rounded-full bg-primary/10 text-primary shrink-0"><Bot className="h-4 w-4" /></span><div className="flex-1 min-w-0 bg-muted/60 border border-border rounded-2xl rounded-tl-sm p-4 text-sm leading-relaxed space-y-4"><p>{prompts[n - 1]}</p>{n === step && content[n - 1]}</div></div>
        {completed.includes(n) && n !== step && n < 6 && <div className="flex justify-end pl-8"><div className="max-w-full bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-3 flex items-start gap-2"><p className="text-sm break-words min-w-0">{replies[n - 1]}</p><Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground" title={`Edit step ${n}`} aria-label={`Edit step ${n}`} onClick={() => setStep(n)}><Pencil className="h-4 w-4" /></Button></div></div>}
      </div>)}
      <div ref={end} />
    </div> : <div className="space-y-5"><h3 className="font-semibold">Register a new school</h3><Field label="School name"><Input value={draft.name ?? ''} onChange={e => update('name', e.target.value)} /></Field><Field label="Gate name"><Input value={draft.gate_name ?? ''} onChange={e => update('gate_name', e.target.value)} /></Field>{level}{location}{gps}{contact}<Button className="min-h-12 w-full gap-2" disabled={saving} onClick={onSave}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Register School & Lock Gate</Button></div>}
    <Button variant="ghost" className="min-h-11 w-full" disabled={saving} onClick={onCancel}>Cancel registration</Button>
  </section>;
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

  const submit = async () => {
    if (group !== 'asset' && !f.full_name?.trim()) { toast.error('Enter the full name'); return; }
    if (group === 'asset' && !f.facility_type) { toast.error('Choose the facility type'); return; }
    if (group !== 'asset' && hasPhone === null) { toast.error('Answer: has a smartphone?'); return; }
    if (group === 'pupil' && !photo && !cameraProblem) { toast.error("Take the student's photo"); return; }
    setSaving(true);
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
    setSaving(false);
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
            <Field label="Facility type"><Chips options={FACILITY_TYPES} value={f.facility_type ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_type: v }))} /></Field>
            <Field label="Condition"><Chips options={['Good', 'Fair', 'Poor']} value={f.facility_condition ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_condition: v }))} /></Field>
            <Field label="Capacity"><Input inputMode="numeric" value={(f.facility_capacity as any) ?? ''} onChange={set('facility_capacity')} /></Field>
          </>
        ) : (
          <>
            {group === 'pupil' && (
              <div className="space-y-2">
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
                    className="flex min-h-[80px] w-full items-center gap-3 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5 p-3 text-left hover:bg-primary/10">
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Camera className="h-5 w-5" /></span>
                    <span>
                      <span className="block font-semibold">Take the student's photo</span>
                      <span className="block text-sm text-muted-foreground">Fit their face inside the oval on screen.</span>
                    </span>
                  </button>
                )}
                {cameraProblem && !photo && <p className="text-xs text-amber-700 dark:text-amber-400">{cameraProblem} You can save without a photo for now.</p>}
                <StudentPhotoCapture open={cameraOpen} studentName={f.full_name} onClose={() => setCameraOpen(false)}
                  onUnavailable={(reason) => { setCameraOpen(false); setCameraProblem(reason); }}
                  onCapture={(blob) => setPhoto((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) }; })} />
              </div>
            )}
            <Field label="Full name"><Input value={f.full_name ?? ''} onChange={set('full_name')} /></Field>
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
            {group === 'pupil' && !tertiary && <Field label="Day or boarding"><Chips options={['Day', 'Boarding']} value={f.boarding_status ?? ''} onChange={(v) => setF((d) => ({ ...d, boarding_status: v }))} /></Field>}
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
          <div className="space-y-2">
            <Label className="text-sm">Has a smartphone?</Label>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setHasPhone(true)} className={cn('flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-center text-sm font-medium', hasPhone === true ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background')}>
                <Smartphone className="h-5 w-5" />Yes, has one
              </button>
              <button type="button" onClick={() => setHasPhone(false)} className={cn('flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-2xl border px-2 text-center text-sm font-medium', hasPhone === false ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background')}>
                <Gift className="h-5 w-5" />No, needs a free one
              </button>
            </div>
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

  const refresh = () => setLogs(readLocalGateLogs(school.id));

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

      <Tabs defaultValue="roster" className="w-full">
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

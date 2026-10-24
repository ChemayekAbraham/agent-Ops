import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GraduationCap, Lock, LockOpen, MapPin, Loader2, Smartphone, Gift, MessageCircle, MessageSquare, Copy, CheckCircle2, CloudOff, Bot, ClipboardList, Pencil, Send, RotateCcw, Sparkles, ChevronRight, LogIn, LogOut, Repeat } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  saveGateLog, flipGateLogDirection, flushPendingGateLogs, readPendingGateLogs, readLocalGateLogs,
  computeGateMovementSummary, formatEatTime,
  type SchoolRow, type SchoolProfileRow, type SchoolGateLogRow,
} from '@/lib/welileSchools';

const db = supabase as any;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-sm">{label}</Label>{children}</div>;
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
  const [locked, setLocked] = useState<SchoolRow | null>(() => readLockedSchool());
  const [draft, setDraft] = useState<Partial<SchoolRow>>(EMPTY_SCHOOL);
  const [creating, setCreating] = useState(false);
  const [dirRegion, setDirRegion] = useState<string | null>(null);
  const [dirDistrict, setDirDistrict] = useState<string | null>(null);
  const [dirSearch, setDirSearch] = useState('');
  const [savingSchool, setSavingSchool] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [pendingCount, setPendingCount] = useState(() => readPendingProfiles().length);

  const { data: schools = [] } = useQuery({
    queryKey: ['welile-schools-list'],
    queryFn: async () => {
      const { data, error } = await db.from('welile_schools').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data as SchoolRow[];
    },
  });

  useEffect(() => {
    const flush = () => flushPendingProfiles().then((n) => {
      setPendingCount(readPendingProfiles().length);
      if (n) toast.success(`${n} saved registration${n > 1 ? 's' : ''} sent`);
    });
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
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate('/dashboard/agent')} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
          <GraduationCap className="h-5 w-5 text-primary" />
          <h1 className="text-base font-bold flex-1">Welile Schools</h1>
          {pendingCount > 0 && <Badge variant="outline" className="gap-1"><CloudOff className="h-3 w-3" />{pendingCount} waiting</Badge>}
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

        {locked && user && <GateRegistration school={locked} agentId={user.id} onQueued={() => setPendingCount(readPendingProfiles().length)} />}
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
  const [role, setRole] = useState<string>('pupil');
  const [f, setF] = useState<Partial<SchoolProfileRow>>({});
  const [hasPhone, setHasPhone] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<{ row: SchoolProfileRow; saved: boolean } | null>(null);
  const [count, setCount] = useState(0);
  const group = roleGroup(role);
  const set = (k: keyof SchoolProfileRow) => (e: React.ChangeEvent<HTMLInputElement>) => setF((d) => ({ ...d, [k]: e.target.value }));
  const num = (v: unknown) => (v === '' || v == null ? null : Number(String(v).replace(/\D/g, '')) || null);

  const submit = async () => {
    if (group !== 'asset' && !f.full_name?.trim()) { toast.error('Enter the full name'); return; }
    if (group === 'asset' && !f.facility_type) { toast.error('Choose the facility type'); return; }
    if (group !== 'asset' && hasPhone === null) { toast.error('Answer: has a smartphone?'); return; }
    setSaving(true);
    const id = crypto.randomUUID();
    const row: SchoolProfileRow = {
      ...f, id, client_ref: id, school_id: school.id, registered_by: agentId, role,
      age: num(f.age), years_at_school: num(f.years_at_school), facility_capacity: num(f.facility_capacity),
      date_of_birth: f.date_of_birth || null,
      ...(group === 'asset' ? { has_smartphone: null, needs_free_smartphone: false, smartphone_status: null } : smartphoneFields(hasPhone)),
    };
    const res = await saveProfile(row);
    setSaving(false);
    setLast(res);
    setCount((c) => c + 1);
    if (!res.saved) { onQueued(); toast.message('No connection — saved on this phone, will send automatically'); }
    else toast.success(group === 'asset' ? 'Facility registered' : `${f.full_name} registered`);
    setF({}); setHasPhone(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3 p-4 bg-primary/5 border-l-4 border-primary rounded-lg">
        <Bot className="h-6 w-6 text-primary shrink-0" />
        <div><p className="text-sm font-semibold">🎉 {school.name} is locked!</p><p className="text-sm text-muted-foreground">Who are you registering at the gate right now?</p></div>
      </div>
      {last && last.row.has_smartphone && <SignupLinkCard row={last.row} saved={last.saved} school={school} agentId={agentId} />}
      {last && last.row.needs_free_smartphone && (
        <Card className="p-3 border-primary/40 bg-primary/5 flex gap-2"><Gift className="h-5 w-5 text-primary shrink-0" /><p className="text-sm">{last.row.full_name} is in the Free Smartphone queue.</p></Card>
      )}

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-semibold">Register at the gate</h2><Badge variant="secondary">{count} this session</Badge></div>
        <div className="grid grid-cols-2 gap-2">
          {PROFILE_ROLES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRole(r.key)}
              className={cn('min-h-[52px] px-2 rounded-xl border text-sm font-medium', role === r.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border')}>
              {r.label}
            </button>
          ))}
        </div>

        {group === 'asset' ? (
          <>
            <Field label="Facility type"><Chips options={FACILITY_TYPES} value={f.facility_type ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_type: v }))} /></Field>
            <Field label="Condition"><Chips options={['Good', 'Fair', 'Poor']} value={f.facility_condition ?? ''} onChange={(v) => setF((d) => ({ ...d, facility_condition: v }))} /></Field>
            <Field label="Capacity"><Input inputMode="numeric" value={(f.facility_capacity as any) ?? ''} onChange={set('facility_capacity')} /></Field>
          </>
        ) : (
          <>
            <Field label="Full name"><Input value={f.full_name ?? ''} onChange={set('full_name')} /></Field>
            <Field label="Gender"><Chips options={['Female', 'Male']} value={f.gender ?? ''} onChange={(v) => setF((d) => ({ ...d, gender: v }))} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Date of birth"><Input type="date" value={f.date_of_birth ?? ''} onChange={set('date_of_birth')} /></Field>
              <Field label="Age"><Input inputMode="numeric" value={(f.age as any) ?? ''} onChange={set('age')} /></Field>
              <Field label="Phone"><Input inputMode="tel" value={f.phone ?? ''} onChange={set('phone')} /></Field>
              <Field label="WhatsApp"><Input inputMode="tel" value={f.whatsapp ?? ''} onChange={set('whatsapp')} /></Field>
            </div>
            <Field label="Email (optional)"><Input type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
            <Field label="National ID / School ID / Admission No."><Input value={f.id_number ?? ''} onChange={set('id_number')} /></Field>

            {group === 'pupil' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Class / Grade / Year"><Input value={f.class_grade ?? ''} onChange={set('class_grade')} /></Field>
                  <Field label="Stream / Dormitory"><Input value={f.stream ?? ''} onChange={set('stream')} /></Field>
                </div>
                <Field label="Day or boarding"><Chips options={['Day', 'Boarding']} value={f.boarding_status ?? ''} onChange={(v) => setF((d) => ({ ...d, boarding_status: v }))} /></Field>
                <Field label="Parent / guardian full name"><Input value={f.guardian_name ?? ''} onChange={set('guardian_name')} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Guardian phone"><Input inputMode="tel" value={f.guardian_phone ?? ''} onChange={set('guardian_phone')} /></Field>
                  <Field label="Guardian WhatsApp"><Input inputMode="tel" value={f.guardian_whatsapp ?? ''} onChange={set('guardian_whatsapp')} /></Field>
                  <Field label="Parent occupation"><Input value={f.guardian_occupation ?? ''} onChange={set('guardian_occupation')} /></Field>
                  <div className="col-span-2">
                    <HomeVillagePicker onPick={(v) => setF((d) => ({ ...d, residence_village: v }))} />
                  </div>
                </div>
                <Field label="Needs fee / rent support?"><Chips options={['Yes', 'No']} value={f.fee_support_need == null ? '' : f.fee_support_need ? 'Yes' : 'No'} onChange={(v) => setF((d) => ({ ...d, fee_support_need: v === 'Yes' }))} /></Field>
              </>
            )}
            {(group === 'teacher' || group === 'staff') && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Subject / department / role"><Input value={f.subject_department ?? ''} onChange={set('subject_department')} /></Field>
                <Field label="Staff ID"><Input value={f.staff_id ?? ''} onChange={set('staff_id')} /></Field>
                <Field label="Years at school"><Input inputMode="numeric" value={(f.years_at_school as any) ?? ''} onChange={set('years_at_school')} /></Field>
                <Field label="Next of kin / residence"><Input value={f.next_of_kin ?? ''} onChange={set('next_of_kin')} /></Field>
              </div>
            )}
            {group === 'parent' && <Field label="Occupation"><Input value={f.guardian_occupation ?? ''} onChange={set('guardian_occupation')} /></Field>}

            <div className="space-y-2">
              <Label className="text-sm font-semibold">Has a smartphone?</Label>
              <div className="grid grid-cols-1 gap-2">
                <button type="button" onClick={() => setHasPhone(true)} className={cn('min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', hasPhone === true ? 'bg-primary text-primary-foreground border-primary' : 'border-border')}>
                  <Smartphone className="h-4 w-4" />Yes — has a smartphone
                </button>
                <button type="button" onClick={() => setHasPhone(false)} className={cn('min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', hasPhone === false ? 'bg-primary text-primary-foreground border-primary' : 'border-border')}>
                  <Gift className="h-4 w-4" />No — needs a free Welile smartphone
                </button>
              </div>
            </div>
            {hasPhone === false && (
              <Card className="p-3 bg-primary/5 border-primary/40 space-y-2">
                <p className="text-sm font-semibold">Welile will provide a FREE Smartphone so they can access Welile App.</p>
                <Field label="Basic phone or guardian / head teacher number"><Input inputMode="tel" value={f.smartphone_contact_phone ?? ''} onChange={set('smartphone_contact_phone')} /></Field>
                <Field label="Preferred handover point"><Input placeholder={school.gate_name ?? 'Main Gate'} value={f.smartphone_handover_point ?? ''} onChange={set('smartphone_handover_point')} /></Field>
                <Field label="ID / school verification"><Chips options={['Verified', 'Not verified']} value={f.smartphone_verification_status ?? ''} onChange={(v) => setF((d) => ({ ...d, smartphone_verification_status: v }))} /></Field>
              </Card>
            )}
          </>
        )}
        <Button className="w-full min-h-[52px] text-base" onClick={submit} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save & next person</Button>
      </Card>
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

function RegionDistrictBrowser({ region, district, onRegion, onDistrict }: { region: string | null; district: string | null; onRegion: (r: string) => void; onDistrict: (d: string, r: string | null) => void }) {
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

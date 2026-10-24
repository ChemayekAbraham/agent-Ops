import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Stethoscope, Lock, LockOpen, MapPin, Loader2, Smartphone, Gift, MessageCircle, MessageSquare, Copy, CheckCircle2, CloudOff, Bot, ClipboardList, Pencil, Send, RotateCcw, Sparkles, ChevronRight, LogIn, LogOut, Repeat, Receipt, RefreshCw, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import UgLocationPicker from '@/components/location/UgLocationPicker';
import { UG_REGIONS, type UgLocationSelection } from '@/hooks/useUgLocations';
import { CountryCombobox } from '@/components/ui/country-combobox';
import { captureSmartLocation } from '@/hooks/useSmartLocation';
import { RegionDistrictBrowser } from '@/pages/agent/AgentWelileSchools';
import {
  MEDICAL_FACILITY_TYPES, MEDICAL_OWNERSHIP_OPTIONS, MEDICAL_ENTRY_POINTS, MEDICAL_DEPARTMENTS, MEDICAL_PROFILE_ROLES, MEDICAL_GATE_ROLES,
  VISIT_PURPOSE_PRESETS, TX_IN_CATEGORIES, TX_OUT_CATEGORIES, PAYMENT_METHODS, MEDICAL_ASSET_TYPES,
  medicalRoleGroup, medicalRoleLabel, facilityTypeLabel, ownershipLabel, txCategoryLabel, paymentMethodLabel,
  generateReceiptNumber, buildMedicineSignupLink, buildMedicineSignupMessage, medicineSmartphoneFields, toIntlDigits, formatEatTime,
  readLockedFacility, writeLockedFacility,
  saveMedicalProfile, flushPendingMedicalProfiles, readPendingMedicalProfiles, markMedicalSignupSent,
  saveMedicalGateLog, flipMedicalGateLogDirection, flushPendingMedicalGateLogs, readPendingMedicalGateLogs, readLocalMedicalGateLogs, writeLocalMedicalGateLogs,
  saveMedicalTransaction, flushPendingMedicalTransactions, readPendingMedicalTransactions, readLocalMedicalTransactions, writeLocalMedicalTransactions,
  computeMedicalGateSummary, computeMedicalTxSummary,
  type MedicalFacilityRow, type MedicalProfileRow, type MedicalGateLogRow, type MedicalTransactionRow,
} from '@/lib/welileMedicine';

const db = supabase as any;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-sm">{label}</Label>{children}</div>;
}

function Chips<T extends string>({ options, value, onChange }: { options: readonly { key: T; label: string }[] | readonly T[]; value: string; onChange: (v: T) => void }) {
  const opts = (options as readonly (T | { key: T; label: string })[]).map((o) => (typeof o === 'string' ? { key: o, label: o } : o));
  return (
    <div className="flex flex-wrap gap-2">
      {opts.map((o) => (
        <Button key={o.key} type="button" variant="outline" aria-pressed={value === o.key} onClick={() => onChange(o.key)}
          className={cn('min-h-[44px] px-3 rounded-xl border text-sm', value === o.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border')}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

const EMPTY_FACILITY: Partial<MedicalFacilityRow> = { country: 'Uganda', facility_type: 'clinic', ownership: 'private', entry_point_name: 'Main Gate' };
const DIRECTORY_TYPES = MEDICAL_FACILITY_TYPES.filter((t) => ['hospital', 'clinic', 'pharmacy', 'medical_center', 'diagnostic_lab'].includes(t.key));

export default function AgentWelileMedicine() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [locked, setLocked] = useState<MedicalFacilityRow | null>(() => readLockedFacility());
  const [draft, setDraft] = useState<Partial<MedicalFacilityRow>>(EMPTY_FACILITY);
  const [creating, setCreating] = useState(false);
  const [dirType, setDirType] = useState<string | null>(null);
  const [dirRegion, setDirRegion] = useState<string | null>(null);
  const [dirDistrict, setDirDistrict] = useState<string | null>(null);
  const [dirSearch, setDirSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);
  const countPending = () => readPendingMedicalProfiles().length + readPendingMedicalGateLogs().length + readPendingMedicalTransactions().length;
  const [pending, setPending] = useState(countPending);
  const [tab, setTab] = useState<'gate' | 'tx' | 'register'>('gate');
  const [version, setVersion] = useState(0);
  const onQueued = () => { setPending(countPending()); setVersion((v) => v + 1); };

  const { data: facilities = [] } = useQuery({
    queryKey: ['welile-medicine-list'],
    queryFn: async () => {
      const { data, error } = await db.from('welile_medical_facilities').select('*').order('created_at', { ascending: false }).limit(300);
      if (error) throw error;
      return data as MedicalFacilityRow[];
    },
  });

  useEffect(() => {
    const flush = async () => {
      const a = await flushPendingMedicalProfiles();
      const b = await flushPendingMedicalGateLogs();
      const c = await flushPendingMedicalTransactions();
      setPending(countPending());
      if (a + b + c) toast.success(`${a + b + c} saved record${a + b + c > 1 ? 's' : ''} sent`);
    };
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, []);

  const dirDistricts = useMemo(() => [...new Set(facilities.filter((f) => f.region === dirRegion && f.district).map((f) => f.district as string))].sort(), [facilities, dirRegion]);
  const shown = useMemo(() => {
    const q = dirSearch.trim().toLowerCase();
    return facilities.filter((f) => (!dirType || f.facility_type === dirType) && (!dirRegion || f.region === dirRegion) && (!dirDistrict || f.district === dirDistrict) && (!q || [f.facility_name, f.cell_or_village].some((v) => v?.toLowerCase().includes(q))));
  }, [facilities, dirType, dirRegion, dirDistrict, dirSearch]);
  const startBot = () => { setDraft({ ...EMPTY_FACILITY, ...(dirRegion ? { region: dirRegion } : {}), ...(dirDistrict ? { district: dirDistrict } : {}) }); setCreating(true); };
  const lock = (f: MedicalFacilityRow | null) => { setLocked(f); writeLockedFacility(f); setTab('gate'); };

  const captureGps = async () => {
    setGpsBusy(true);
    const r = await captureSmartLocation();
    setGpsBusy(false);
    if (!r.ok) { toast.error('Could not get GPS — enter coordinates or skip for now'); return false; }
    setDraft((d) => ({ ...d, gps_lat: r.latitude, gps_lng: r.longitude, gps_accuracy_m: Math.round(r.accuracy), gps_source: 'device' }));
    return true;
  };

  const createFacility = async () => {
    if (!draft.facility_name || draft.facility_name.trim().length < 2) { toast.error('Enter the facility name'); return; }
    if (!user) return;
    setSaving(true);
    const { data, error } = await db.from('welile_medical_facilities').insert({
      ...draft, facility_name: draft.facility_name.trim(), registered_by_agent_id: user.id,
      gps_source: draft.gps_lat != null ? (draft.gps_source ?? 'manual') : null,
    }).select().single();
    setSaving(false);
    if (error) { toast.error('Could not save facility', { description: error.message }); return; }
    lock(data as MedicalFacilityRow);
    setCreating(false);
    setDraft(EMPTY_FACILITY);
    qc.invalidateQueries({ queryKey: ['welile-medicine-list'] });
    toast.success('🎉 Facility registered and locked');
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <header className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b border-border">
        <div className="flex items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="icon" className="h-11 w-11" onClick={() => navigate('/dashboard/agent')} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
          <Stethoscope className="h-5 w-5 text-primary" />
          <h1 className="text-base font-bold flex-1">Welile Medicine</h1>
          {pending > 0 && <Badge variant="outline" className="gap-1"><CloudOff className="h-3 w-3" />{pending} waiting</Badge>}
        </div>
        {locked && (
          <div className="flex items-center gap-2 px-3 pb-2">
            <Lock className="h-4 w-4 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{locked.facility_name}</p>
              <p className="text-xs text-muted-foreground truncate">{[facilityTypeLabel(locked.facility_type), locked.entry_point_name, locked.district].filter(Boolean).join(' · ')}</p>
            </div>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => lock(null)}><LockOpen className="h-4 w-4 mr-1" />Change</Button>
          </div>
        )}
      </header>

      <main className="max-w-xl mx-auto p-3 space-y-4">
        {!locked && !creating && (
          <Card className="p-4 space-y-3">
            <h2 className="font-semibold">Choose the Clinic, Pharmacy, Hospital or Medical Center you are at</h2>
            <Button className="w-full min-h-[48px] gap-2 whitespace-normal" onClick={startBot}><MessageCircle className="h-5 w-5 shrink-0" />Register a Facility with Welile Medicine Bot</Button>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={dirType === null ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setDirType(null)}>All</Button>
              {DIRECTORY_TYPES.map((t) => <Button key={t.key} size="sm" variant={dirType === t.key ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setDirType(t.key)}>{t.label}</Button>)}
            </div>
            <p className="text-xs font-medium text-muted-foreground">Browse by Region → District</p>
            <div className="flex flex-wrap gap-2">{[null, ...UG_REGIONS].map((reg) => <Button key={reg ?? 'all'} size="sm" variant={dirRegion === reg ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => { setDirRegion(reg); setDirDistrict(null); }}>{reg ?? 'All'}</Button>)}</div>
            {dirRegion && dirDistricts.length > 0 && <div className="flex flex-wrap gap-2">{dirDistricts.map((d) => <Button key={d} size="sm" variant={dirDistrict === d ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setDirDistrict(dirDistrict === d ? null : d)}>{d}</Button>)}</div>}
            <Input aria-label="Search facilities" placeholder="Search facility name..." value={dirSearch} onChange={(e) => setDirSearch(e.target.value)} />
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {shown.map((f) => (
                <button key={f.id} onClick={() => lock(f)} className="w-full text-left p-3 rounded-xl border border-border min-h-[52px]">
                  <p className="text-sm font-medium">{f.facility_name}</p>
                  <p className="text-xs text-muted-foreground">{[facilityTypeLabel(f.facility_type), f.district, f.cell_or_village].filter(Boolean).join(' · ')}</p>
                </button>
              ))}
              {!shown.length && <p className="text-sm text-muted-foreground">No facilities match yet — register one with the bot.</p>}
            </div>
          </Card>
        )}

        {!locked && creating && (
          <FacilityRegistration draft={draft} setDraft={setDraft} captureGps={captureGps} gpsBusy={gpsBusy} saving={saving} onSave={createFacility} onCancel={() => setCreating(false)} />
        )}

        {locked && user && (
          <>
            <LiveCounterStrip facilityId={locked.id} version={version} />
            <div className="grid grid-cols-3 gap-2" role="group" aria-label="Facility workspace">
              <Button variant={tab === 'gate' ? 'default' : 'outline'} aria-pressed={tab === 'gate'} className="min-h-12 text-xs whitespace-normal h-auto py-2" onClick={() => setTab('gate')}>🚪 People IN / OUT & Transactions</Button>
              <Button variant={tab === 'tx' ? 'default' : 'outline'} aria-pressed={tab === 'tx'} className="min-h-12 text-xs whitespace-normal h-auto py-2" onClick={() => setTab('tx')}>🧾 Receipts & Transactions (IN / OUT)</Button>
              <Button variant={tab === 'register' ? 'default' : 'outline'} aria-pressed={tab === 'register'} className="min-h-12 text-xs whitespace-normal h-auto py-2" onClick={() => setTab('register')}>➕ Register Profile & Smartphone Link</Button>
            </div>
            {tab === 'gate' && <GateView facility={locked} agentId={user.id} onQueued={onQueued} onRegister={() => setTab('register')} />}
            {tab === 'tx' && <TransactionsView facility={locked} agentId={user.id} onQueued={onQueued} />}
            {tab === 'register' && <ProfileRegistration facility={locked} agentId={user.id} onQueued={onQueued} />}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------- Facility registration bot ---------------- */

export function FacilityRegistration({ draft, setDraft, captureGps, gpsBusy, saving, onSave, onCancel }: {
  draft: Partial<MedicalFacilityRow>;
  setDraft: React.Dispatch<React.SetStateAction<Partial<MedicalFacilityRow>>>;
  captureGps: () => Promise<boolean | undefined>;
  gpsBusy: boolean; saving: boolean; onSave: () => void; onCancel: () => void;
}) {
  const [mode, setMode] = useState<'chat' | 'form'>('chat');
  const [step, setStep] = useState(1);
  const [completed, setCompleted] = useState<number[]>([]);
  const [ugLoc, setUgLoc] = useState<UgLocationSelection | null>(null);
  const [manualGps, setManualGps] = useState(false);
  const [otherCountry, setOtherCountry] = useState(draft.country !== 'Uganda');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' }); }, [step, mode, completed]);
  const update = (key: keyof MedicalFacilityRow, value: string | number | null) => setDraft((d) => ({ ...d, [key]: value }));
  const name = draft.facility_name || 'this facility';
  const path = [draft.country, draft.region, draft.district, draft.sub_county_or_town, draft.parish_or_ward, draft.cell_or_village].filter(Boolean).join(' → ');
  const pinned = draft.gps_lat != null && draft.gps_lng != null && Number.isFinite(draft.gps_lat) && Number.isFinite(draft.gps_lng);
  const coordText = pinned ? `${draft.gps_lat?.toFixed(5)}, ${draft.gps_lng?.toFixed(5)}${draft.gps_accuracy_m != null ? ` (±${draft.gps_accuracy_m}m)` : ''}` : 'GPS skipped for now';
  const finish = (n: number) => {
    if (n === 1 && (draft.facility_name?.trim().length ?? 0) < 2) { toast.error('Enter the facility name'); return; }
    if (n === 3 && (draft.country === 'Uganda' ? !(ugLoc || (draft.region && draft.district)) : !draft.country)) { toast.error('Choose the facility location'); return; }
    setCompleted((c) => [...new Set([...c, n])]);
    setStep(n + 1);
  };
  const reset = () => { setDraft({ ...EMPTY_FACILITY }); setUgLoc(null); setOtherCountry(false); setCompleted([]); setStep(1); setManualGps(false); };
  const pickLocation = (sel: UgLocationSelection | null) => {
    setUgLoc(sel);
    setDraft((d) => ({ ...d, country: 'Uganda', region: sel?.region ?? d.region ?? null, district: sel?.district ?? d.district ?? null, sub_county_or_town: sel?.subcounty ?? null, parish_or_ward: sel?.parish ?? null, cell_or_village: sel?.village ?? null }));
  };
  const chooseCountry = (other: boolean) => {
    setOtherCountry(other); setUgLoc(null);
    setDraft((d) => ({ ...d, country: other ? '' : 'Uganda', region: null, district: null, sub_county_or_town: null, parish_or_ward: null, cell_or_village: null }));
  };
  const prompts = [
    <>👋 Hi! I'm the Welile Medicine Bot. What is the <strong>name of the Clinic, Pharmacy, Hospital or Medical Center</strong>, and which entry point are you standing at?</>,
    <>Got it — <strong>{name}</strong>! 🏥 What <strong>type</strong> of facility is it, and who <strong>owns</strong> it?</>,
    <>🗺️ Where is <strong>{name}</strong>? Browse by <strong>Region → District</strong>, then pick the cell or village:</>,
    <>📍 <strong>{name}</strong> is in <strong>{[draft.cell_or_village, draft.district, draft.region ? `${draft.region} Region` : null].filter(Boolean).join(', ') || draft.country}</strong>. Stand at the <strong>{draft.entry_point_name}</strong> and capture the facility GPS.</>,
    <>👩‍⚕️ Who is the <strong>Medical Superintendent, Head Clinician or Pharmacist in charge</strong>, and about how many patients or customers come daily?</>,
    <>✨ Here is the summary for <strong>{name}</strong>. Everything look good?</>,
  ];
  const replies = [
    `${draft.facility_name} (${draft.entry_point_name})`,
    `${facilityTypeLabel(draft.facility_type ?? '')} • ${ownershipLabel(draft.ownership ?? '')}`,
    path,
    pinned ? `📍 Facility GPS pinned: ${coordText}` : coordText,
    [draft.in_charge_name, draft.in_charge_phone, draft.approx_daily_patients != null ? `~${draft.approx_daily_patients.toLocaleString()} daily` : null].filter(Boolean).join(' • ') || 'Contact skipped for now',
  ];
  const nameStep = <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); finish(1); }}>
    <div className="flex gap-2"><Input aria-label="Facility name" className="min-h-12 flex-1 min-w-0" placeholder="e.g. Mengo Hospital, Good Health Pharmacy..." value={draft.facility_name ?? ''} onChange={(e) => update('facility_name', e.target.value)} /><Button type="submit" size="icon" className="h-12 w-12 shrink-0" aria-label="Send facility name"><Send className="h-5 w-5" /></Button></div>
    <Field label="Entry point"><Chips options={MEDICAL_ENTRY_POINTS} value={draft.entry_point_name ?? ''} onChange={(v) => update('entry_point_name', v)} /></Field>
  </form>;
  const typeStep = <div className="space-y-3">
    <Field label="Facility type"><Chips options={MEDICAL_FACILITY_TYPES} value={draft.facility_type ?? ''} onChange={(v) => update('facility_type', v)} /></Field>
    <Field label="Ownership"><Chips options={MEDICAL_OWNERSHIP_OPTIONS} value={draft.ownership ?? ''} onChange={(v) => update('ownership', v)} /></Field>
    {mode === 'chat' && <Button className="min-h-11 w-full" onClick={() => finish(2)}>Continue <ChevronRight className="h-4 w-4" /></Button>}
  </div>;
  const locationStep = <div className="space-y-3">
    <div className="flex flex-wrap gap-2"><Button variant={!otherCountry ? 'default' : 'outline'} className="min-h-11" onClick={() => otherCountry && chooseCountry(false)}>🇺🇬 Uganda</Button><Button variant={otherCountry ? 'default' : 'outline'} className="min-h-11" onClick={() => !otherCountry && chooseCountry(true)}>🌍 Other Country</Button></div>
    {otherCountry ? <CountryCombobox value={draft.country || ''} onChange={(v) => { if (v === 'Uganda') chooseCountry(false); else update('country', v); }} /> : <>
      <RegionDistrictBrowser region={draft.region ?? null} district={draft.district ?? null}
        onRegion={(reg) => { if (reg !== draft.region) { setUgLoc(null); setDraft((d) => ({ ...d, region: reg, district: null, sub_county_or_town: null, parish_or_ward: null, cell_or_village: null })); } }}
        onDistrict={(dist, reg) => { if (dist !== draft.district) setUgLoc(null); setDraft((d) => ({ ...d, region: reg ?? d.region ?? null, district: dist, ...(dist !== d.district ? { sub_county_or_town: null, parish_or_ward: null, cell_or_village: null } : {}) })); }} />
      <UgLocationPicker label="Search or browse facility cell / village" districtName={draft.district || null} value={ugLoc} onChange={pickLocation} />
    </>}
    {mode === 'chat' && <Button className="w-full min-h-11" onClick={() => finish(3)}>Confirm Location <ChevronRight className="h-4 w-4" /></Button>}
  </div>;
  const gpsStep = <div className="space-y-3">
    <Button className="min-h-12 w-full gap-2" disabled={gpsBusy} onClick={async () => { if (await captureGps()) { if (mode === 'chat') finish(4); } }}>{gpsBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}Capture Facility GPS Now</Button>
    {pinned && <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-1 text-sm"><p className="text-primary font-medium break-words">📍 {coordText}</p>{[draft.district, draft.region].filter(Boolean).length > 0 && <p className="text-xs text-muted-foreground">Locked to {[draft.district, draft.region].filter(Boolean).join(', ')}</p>}<a className="text-primary underline inline-flex items-center gap-1 min-h-11" href={`https://www.google.com/maps?q=${draft.gps_lat},${draft.gps_lng}`} target="_blank" rel="noreferrer"><MapPin className="h-4 w-4" />View on Google Maps</a></div>}
    <Button variant="ghost" className="min-h-11 w-full" aria-expanded={manualGps} onClick={() => setManualGps((v) => !v)}>Enter coordinates manually</Button>
    {manualGps && <div className="space-y-2"><div className="grid grid-cols-2 gap-2">
      <Field label="Latitude"><Input type="number" step="any" inputMode="decimal" value={draft.gps_lat ?? ''} onChange={(e) => setDraft((d) => ({ ...d, gps_lat: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} /></Field>
      <Field label="Longitude"><Input type="number" step="any" inputMode="decimal" value={draft.gps_lng ?? ''} onChange={(e) => setDraft((d) => ({ ...d, gps_lng: e.target.value === '' ? null : Number(e.target.value), gps_accuracy_m: null, gps_source: 'manual' }))} /></Field>
    </div>{mode === 'chat' && <Button variant="outline" className="w-full min-h-11" disabled={!pinned || Math.abs(draft.gps_lat ?? 0) > 90 || Math.abs(draft.gps_lng ?? 0) > 180} onClick={() => finish(4)}>Confirm coordinates <ChevronRight className="h-4 w-4" /></Button>}</div>}
    {mode === 'chat' && <Button variant="ghost" className="min-h-11 w-full" onClick={() => { setDraft((d) => ({ ...d, gps_lat: null, gps_lng: null, gps_accuracy_m: null, gps_source: null })); finish(4); }}>Skip GPS for now</Button>}
  </div>;
  const contactStep = <div className="space-y-3">
    <Field label="In-charge name"><Input value={draft.in_charge_name ?? ''} onChange={(e) => update('in_charge_name', e.target.value)} /></Field>
    <Field label="In-charge phone"><Input inputMode="tel" value={draft.in_charge_phone ?? ''} onChange={(e) => update('in_charge_phone', e.target.value)} /></Field>
    <Field label="Approx. daily patients / customers"><Input type="number" min={0} inputMode="numeric" value={draft.approx_daily_patients ?? ''} onChange={(e) => update('approx_daily_patients', e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))))} /></Field>
    <div className="flex flex-wrap gap-2">{[50, 150, 500, 1000].map((n) => <Button key={n} variant="outline" className="min-h-11" onClick={() => update('approx_daily_patients', n)}>~{n.toLocaleString()}</Button>)}</div>
    {mode === 'chat' && <><Button className="min-h-11 w-full" onClick={() => finish(5)}>Continue <ChevronRight className="h-4 w-4" /></Button><Button variant="ghost" className="min-h-11 w-full" onClick={() => { setDraft((d) => ({ ...d, in_charge_name: null, in_charge_phone: null, approx_daily_patients: null })); finish(5); }}>Skip for now</Button></>}
  </div>;
  const summaryStep = <div className="space-y-3">
    <div className="divide-y divide-border">{[
      { n: 1, label: 'Facility & entry point', value: replies[0] },
      { n: 2, label: 'Type & ownership', value: replies[1] },
      { n: 3, label: 'Location', value: path || 'Not selected' },
      { n: 4, label: 'Facility GPS', value: coordText },
      { n: 5, label: 'In-charge & daily volume', value: replies[4] },
    ].map((row) => <Button key={row.n} variant="ghost" className="h-auto min-h-14 w-full justify-between whitespace-normal gap-2 rounded-none px-0 py-3 text-left" onClick={() => setStep(row.n)}><span className="min-w-0"><span className="block text-xs text-muted-foreground">{row.label}</span><span className="block text-sm break-words">{row.value}</span></span><Pencil className="h-4 w-4 shrink-0" /></Button>)}</div>
    <Button className="w-full min-h-12 whitespace-normal gap-2" disabled={saving} onClick={onSave}>{saving ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : <CheckCircle2 className="h-4 w-4 shrink-0" />}Register Facility & Lock Gate</Button>
  </div>;
  const content = [nameStep, typeStep, locationStep, gpsStep, contactStep, summaryStep];
  return <section className="space-y-4 min-w-0">
    <div className="sticky top-14 z-10 bg-background/95 backdrop-blur border-b border-border py-3 space-y-3">
      <div className="flex gap-3 items-center"><div className="relative p-3 rounded-full bg-primary/10 text-primary"><Bot className="h-6 w-6" /><Stethoscope className="h-3 w-3 absolute bottom-0 right-0" /></div><div className="min-w-0 flex-1"><h2 className="font-semibold text-base">Welile Medicine Bot</h2><p className="text-xs text-muted-foreground">Step-by-step facility onboarding • {navigator.onLine ? 'Online' : 'Offline'}</p></div><Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label="Start Over" disabled={saving || gpsBusy} onClick={reset}><RotateCcw className="h-4 w-4" /></Button></div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Registration mode"><Button variant={mode === 'chat' ? 'default' : 'outline'} aria-pressed={mode === 'chat'} className="min-h-11 gap-2" onClick={() => setMode('chat')}><Bot className="h-4 w-4" />Chat Bot</Button><Button variant={mode === 'form' ? 'default' : 'outline'} aria-pressed={mode === 'form'} className="min-h-11 gap-2" onClick={() => setMode('form')}><ClipboardList className="h-4 w-4" />Classic Form</Button></div>
      {mode === 'chat' && <div className="space-y-2"><p className="text-xs text-muted-foreground">Step {step} of 6</p><div className="grid grid-cols-6 gap-1">{[1, 2, 3, 4, 5, 6].map((n) => <div key={n} className={cn('h-1 rounded-full', n <= step ? 'bg-primary' : 'bg-muted')} />)}</div></div>}
    </div>
    {mode === 'chat' ? <div className="space-y-5" aria-label="Facility registration conversation">
      {[1, 2, 3, 4, 5, 6].filter((n) => completed.includes(n) || n === step).map((n) => <div key={n} className="space-y-3">
        <div className="flex gap-2 items-start"><span className="p-1.5 rounded-full bg-primary/10 text-primary shrink-0"><Bot className="h-4 w-4" /></span><div className="flex-1 min-w-0 bg-muted/60 border border-border rounded-2xl rounded-tl-sm p-4 text-sm leading-relaxed space-y-4"><p>{prompts[n - 1]}</p>{n === step && content[n - 1]}</div></div>
        {completed.includes(n) && n !== step && n < 6 && <div className="flex justify-end pl-8"><div className="max-w-full bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-3 flex items-start gap-2"><p className="text-sm break-words min-w-0">{replies[n - 1]}</p><Button variant="ghost" size="icon" className="h-11 w-11 shrink-0 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground" aria-label={`Edit step ${n}`} onClick={() => setStep(n)}><Pencil className="h-4 w-4" /></Button></div></div>}
      </div>)}
      <div ref={end} />
    </div> : <div className="space-y-5"><h3 className="font-semibold">Register a new facility</h3><Field label="Facility name"><Input value={draft.facility_name ?? ''} onChange={(e) => update('facility_name', e.target.value)} /></Field><Field label="Entry point"><Chips options={MEDICAL_ENTRY_POINTS} value={draft.entry_point_name ?? ''} onChange={(v) => update('entry_point_name', v)} /></Field>{typeStep}{locationStep}{gpsStep}{contactStep}<Button className="min-h-12 w-full gap-2" disabled={saving} onClick={onSave}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Register Facility & Lock Gate</Button></div>}
    <Button variant="ghost" className="min-h-11 w-full" disabled={saving} onClick={onCancel}>Cancel registration</Button>
  </section>;
}

/* ---------------- Live counter strip ---------------- */

function useFacilityRecords(facilityId: string, version: number) {
  const [logs, setLogs] = useState<MedicalGateLogRow[]>(() => readLocalMedicalGateLogs(facilityId));
  const [txs, setTxs] = useState<MedicalTransactionRow[]>(() => readLocalMedicalTransactions(facilityId));
  const refresh = () => { setLogs(readLocalMedicalGateLogs(facilityId)); setTxs(readLocalMedicalTransactions(facilityId)); };
  useEffect(() => {
    refresh();
    db.from('welile_medical_gate_logs').select('*').eq('facility_id', facilityId).order('recorded_at', { ascending: false }).limit(1000)
      .then(({ data }: { data: MedicalGateLogRow[] | null }) => {
        if (!data) return;
        const all = readLocalMedicalGateLogs();
        data.forEach((l) => { if (!all.some((m) => m.id === l.id)) all.push(l); });
        writeLocalMedicalGateLogs(all); refresh();
      });
    db.from('welile_medical_transactions').select('*').eq('facility_id', facilityId).order('recorded_at', { ascending: false }).limit(1000)
      .then(({ data }: { data: MedicalTransactionRow[] | null }) => {
        if (!data) return;
        const all = readLocalMedicalTransactions();
        data.forEach((t) => { if (!all.some((m) => m.id === t.id)) all.push(t); });
        writeLocalMedicalTransactions(all); refresh();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facilityId, version]);
  return { logs, txs, refresh };
}

function LiveCounterStrip({ facilityId, version }: { facilityId: string; version: number }) {
  const { logs, txs } = useFacilityRecords(facilityId, version);
  const g = computeMedicalGateSummary(logs);
  const t = computeMedicalTxSummary(txs);
  const tile = (label: string, v: string | number, cls = 'border-border bg-card') => (
    <div className={cn('rounded-xl border p-2 text-center min-w-0', cls)}><p className="text-base font-bold break-words">{v}</p><p className="text-[11px] font-medium">{label}</p></div>
  );
  return (
    <div className="space-y-2" aria-label="Today's live facility counter">
      <p className="text-xs font-semibold text-muted-foreground">Today's Live Facility Counter</p>
      <div className="grid grid-cols-4 gap-2">
        {tile('Entered IN', g.enteredToday, 'border-primary/40 bg-primary/5 text-primary')}
        {tile('Exited OUT', g.exitedToday, 'border-destructive/40 bg-destructive/5 text-destructive')}
        {tile('Currently Inside', g.currentlyInside)}
        {tile('Receipts Today', t.totalCountToday)}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tile('Money IN (UGX)', formatUGX(t.moneyInTodayUgx), 'border-primary/40 bg-primary/5 text-primary')}
        {tile('Money OUT (UGX)', formatUGX(t.moneyOutTodayUgx), 'border-destructive/40 bg-destructive/5 text-destructive')}
        {tile('Net Cashflow (UGX)', formatUGX(t.netCashflowTodayUgx))}
      </div>
    </div>
  );
}

/* ---------------- Receipt fields (shared) ---------------- */

interface TxDraft { tx_direction: 'in' | 'out'; receipt_number: string; category: string; amount: string; payment_method: string; payer_or_payee_name: string; payer_or_payee_phone: string; items_or_description: string }
const newTxDraft = (dir: 'in' | 'out' = 'in'): TxDraft => ({ tx_direction: dir, receipt_number: generateReceiptNumber(), category: dir === 'in' ? 'pharmacy_medicine' : 'drug_stock_supplier', amount: '', payment_method: 'cash', payer_or_payee_name: '', payer_or_payee_phone: '', items_or_description: '' });

function ReceiptFields({ tx, setTx, showParty, profiles }: { tx: TxDraft; setTx: React.Dispatch<React.SetStateAction<TxDraft>>; showParty: boolean; profiles?: MedicalProfileRow[] }) {
  const set = (k: keyof TxDraft) => (e: React.ChangeEvent<HTMLInputElement>) => setTx((d) => ({ ...d, [k]: e.target.value }));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant={tx.tx_direction === 'in' ? 'default' : 'outline'} className="min-h-12 whitespace-normal h-auto py-2 text-xs" onClick={() => setTx((d) => ({ ...d, tx_direction: 'in', category: 'pharmacy_medicine' }))}>🟢 Transaction IN (Patient Receipt / Medicine Sale / Consultation)</Button>
        <Button type="button" variant={tx.tx_direction === 'out' ? 'default' : 'outline'} className="min-h-12 whitespace-normal h-auto py-2 text-xs" onClick={() => setTx((d) => ({ ...d, tx_direction: 'out', category: 'drug_stock_supplier' }))}>🔴 Transaction OUT (Drug Restock / Supplier Payout / Expense / Refund)</Button>
      </div>
      <Field label="Receipt number">
        <div className="flex gap-2"><Input aria-label="Receipt number" value={tx.receipt_number} onChange={set('receipt_number')} /><Button type="button" variant="outline" size="icon" className="h-10 w-10 shrink-0" aria-label="New receipt number" onClick={() => setTx((d) => ({ ...d, receipt_number: generateReceiptNumber() }))}><RefreshCw className="h-4 w-4" /></Button></div>
      </Field>
      <Field label="Category"><Chips options={tx.tx_direction === 'in' ? TX_IN_CATEGORIES : TX_OUT_CATEGORIES} value={tx.category} onChange={(v) => setTx((d) => ({ ...d, category: v }))} /></Field>
      <Field label="Amount (UGX)"><Input aria-label="Amount UGX" inputMode="numeric" value={tx.amount} onChange={(e) => setTx((d) => ({ ...d, amount: e.target.value.replace(/\D/g, '') }))} /></Field>
      <div className="flex flex-wrap gap-2">{[5000, 10000, 25000, 50000, 100000].map((n) => <Button key={n} type="button" variant="outline" className="min-h-11" onClick={() => setTx((d) => ({ ...d, amount: String(n) }))}>{n.toLocaleString()}</Button>)}</div>
      <Field label="Payment method"><Chips options={PAYMENT_METHODS} value={tx.payment_method} onChange={(v) => setTx((d) => ({ ...d, payment_method: v }))} /></Field>
      {showParty && <>
        {profiles && profiles.length > 0 && <Field label="Quick pick from registered profiles">
          <select aria-label="Pick profile" className="h-11 w-full rounded-md border border-input bg-background px-2 text-sm" value="" onChange={(e) => { const p = profiles.find((x) => x.id === e.target.value); if (p) setTx((d) => ({ ...d, payer_or_payee_name: p.full_name, payer_or_payee_phone: p.phone ?? '' })); }}>
            <option value="">Choose a person…</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.full_name} · {medicalRoleLabel(p.role_type)}</option>)}
          </select>
        </Field>}
        <div className="grid grid-cols-2 gap-2">
          <Field label={tx.tx_direction === 'in' ? 'Payer name' : 'Payee name'}><Input value={tx.payer_or_payee_name} onChange={set('payer_or_payee_name')} /></Field>
          <Field label="Phone"><Input inputMode="tel" value={tx.payer_or_payee_phone} onChange={set('payer_or_payee_phone')} /></Field>
        </div>
      </>}
      <Field label="Items / medicine / service"><Input value={tx.items_or_description} onChange={set('items_or_description')} /></Field>
    </div>
  );
}

function txRowFrom(tx: TxDraft, facility: MedicalFacilityRow, agentId: string, extra: Partial<MedicalTransactionRow>): MedicalTransactionRow {
  const id = crypto.randomUUID();
  return {
    id, client_ref: id, facility_id: facility.id, agent_id: agentId, recorded_at: new Date().toISOString(),
    tx_direction: tx.tx_direction, receipt_number: tx.receipt_number.trim() || generateReceiptNumber(), category: tx.category,
    amount_ugx: Number(tx.amount) || 0, payment_method: tx.payment_method,
    payer_or_payee_name: tx.payer_or_payee_name.trim(), payer_or_payee_phone: tx.payer_or_payee_phone.trim() || null,
    items_or_description: tx.items_or_description.trim() || null, profile_id: null, gate_log_id: null,
    ...extra,
  };
}

function useFacilityProfiles(facilityId: string) {
  const [profiles, setProfiles] = useState<MedicalProfileRow[]>([]);
  useEffect(() => {
    db.from('welile_medical_profiles').select('*').eq('facility_id', facilityId).order('created_at', { ascending: false }).limit(2000)
      .then(({ data }: { data: MedicalProfileRow[] | null }) => {
        const all = [...(data ?? [])];
        readPendingMedicalProfiles().filter((p) => p.facility_id === facilityId).forEach((p) => { if (!all.some((a) => a.id === p.id)) all.push(p); });
        setProfiles(all.filter((p) => p.role_type !== 'facility_asset'));
      });
  }, [facilityId]);
  return profiles;
}

/* ---------------- Tab 1: People IN / OUT & Transactions ---------------- */

function GateView({ facility, agentId, onQueued, onRegister }: { facility: MedicalFacilityRow; agentId: string; onQueued: () => void; onRegister: () => void }) {
  const { logs, refresh } = useFacilityRecords(facility.id, 0);
  const profiles = useFacilityProfiles(facility.id);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [role, setRole] = useState<string>('patient');
  const [f, setF] = useState({ person_name: '', phone: '', department_or_ward: '', visit_purpose_or_note: '', attendant_or_kin_name: '', attendant_or_kin_phone: '' });
  const [attach, setAttach] = useState(false);
  const [tx, setTx] = useState<TxDraft>(() => newTxDraft());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [receiptFor, setReceiptFor] = useState<MedicalProfileRow | null>(null);
  const summary = useMemo(() => computeMedicalGateSummary(logs), [logs]);

  const record = async (entry: Partial<MedicalGateLogRow> & { person_name: string; role_type: string; direction: 'in' | 'out' }) => {
    const id = crypto.randomUUID();
    const row: MedicalGateLogRow = { id, client_ref: id, facility_id: facility.id, agent_id: agentId, entry_point_name: facility.entry_point_name, recorded_at: new Date().toISOString(), ...entry };
    const res = await saveMedicalGateLog(row);
    refresh();
    if (!res.saved) { onQueued(); toast.message('No connection — saved on this phone, will send automatically'); }
    return res;
  };
  const saveTx = async (row: MedicalTransactionRow) => {
    const res = await saveMedicalTransaction(row);
    onQueued();
    return res;
  };

  const submit = async () => {
    if (!f.person_name.trim()) { toast.error('Enter the person name'); return; }
    if (attach && !(Number(tx.amount) > 0)) { toast.error('Enter the receipt amount'); return; }
    setSaving(true);
    const g = await record({ direction, role_type: role, person_name: f.person_name.trim(), phone: f.phone.trim() || null, department_or_ward: f.department_or_ward || null, visit_purpose_or_note: f.visit_purpose_or_note || null, attendant_or_kin_name: f.attendant_or_kin_name.trim() || null, attendant_or_kin_phone: f.attendant_or_kin_phone.trim() || null });
    if (attach) await saveTx(txRowFrom({ ...tx, payer_or_payee_name: tx.payer_or_payee_name || f.person_name, payer_or_payee_phone: tx.payer_or_payee_phone || f.phone }, facility, agentId, { gate_log_id: g.row.id }));
    setSaving(false);
    toast.success(`${direction === 'in' ? '🟢' : '🔴'} ${f.person_name.trim()} recorded ${direction === 'in' ? 'ENTERING' : 'LEAVING'}${attach ? ' with receipt' : ''}`);
    setF({ person_name: '', phone: '', department_or_ward: '', visit_purpose_or_note: '', attendant_or_kin_name: '', attendant_or_kin_phone: '' });
    setTx(newTxDraft(tx.tx_direction)); setAttach(false);
  };

  const mark = async (p: MedicalProfileRow, dir: 'in' | 'out') => {
    const res = await record({ direction: dir, role_type: p.role_type, person_name: p.full_name, profile_id: p.id, phone: p.phone ?? null, department_or_ward: p.department_or_ward ?? null, attendant_or_kin_name: p.next_of_kin_name ?? null, attendant_or_kin_phone: p.next_of_kin_phone ?? null });
    if (res.saved) toast.success(`${dir === 'in' ? '🟢' : '🔴'} ${p.full_name} marked ${dir.toUpperCase()}`);
  };
  const flip = async (log: MedicalGateLogRow) => {
    const res = await flipMedicalGateLogDirection(log);
    refresh();
    if (!res.saved) onQueued();
    toast.success(`${log.person_name} corrected to ${res.row.direction === 'in' ? '🟢 IN' : '🔴 OUT'}`);
  };

  const needle = search.trim().toLowerCase();
  const roster = profiles.filter((p) => !needle || [p.full_name, p.phone, p.department_or_ward].some((v) => v?.toLowerCase().includes(needle)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge variant="secondary">Patients inside: {summary.byGroup.patient.inside}</Badge>
        <Badge variant="secondary">Staff inside: {summary.byGroup.staff.inside}</Badge>
        <Badge variant="secondary">Caregivers & suppliers inside: {summary.byGroup.visitor.inside}</Badge>
      </div>
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">Record person IN / OUT</h2>
        <div className="grid grid-cols-2 gap-2">
          <Button variant={direction === 'in' ? 'default' : 'outline'} aria-pressed={direction === 'in'} className="min-h-12 whitespace-normal" onClick={() => setDirection('in')}><LogIn className="h-4 w-4 shrink-0" />🟢 Entering Facility (IN)</Button>
          <Button variant={direction === 'out' ? 'default' : 'outline'} aria-pressed={direction === 'out'} className="min-h-12 whitespace-normal" onClick={() => setDirection('out')}><LogOut className="h-4 w-4 shrink-0" />🔴 Leaving Facility (OUT)</Button>
        </div>
        <Chips options={MEDICAL_GATE_ROLES} value={role} onChange={setRole} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Person name"><Input aria-label="Person name" value={f.person_name} onChange={(e) => setF((d) => ({ ...d, person_name: e.target.value }))} /></Field>
          <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={(e) => setF((d) => ({ ...d, phone: e.target.value }))} /></Field>
        </div>
        <Field label="Department / ward"><Chips options={MEDICAL_DEPARTMENTS} value={f.department_or_ward} onChange={(v) => setF((d) => ({ ...d, department_or_ward: d.department_or_ward === v ? '' : v }))} /></Field>
        <Field label="Visit purpose"><Chips options={VISIT_PURPOSE_PRESETS} value={f.visit_purpose_or_note} onChange={(v) => setF((d) => ({ ...d, visit_purpose_or_note: d.visit_purpose_or_note === v ? '' : v }))} /></Field>
        {role === 'patient' && <div className="grid grid-cols-2 gap-2">
          <Field label="Attendant / next of kin"><Input value={f.attendant_or_kin_name} onChange={(e) => setF((d) => ({ ...d, attendant_or_kin_name: e.target.value }))} /></Field>
          <Field label="Their phone"><Input inputMode="tel" value={f.attendant_or_kin_phone} onChange={(e) => setF((d) => ({ ...d, attendant_or_kin_phone: e.target.value }))} /></Field>
        </div>}
        <button type="button" aria-pressed={attach} onClick={() => setAttach((v) => !v)} className={cn('w-full min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', attach ? 'bg-primary/10 border-primary text-primary' : 'border-border')}>
          <Receipt className="h-4 w-4 shrink-0" />+ Attach Receipt / Transaction (IN or OUT)
        </button>
        {attach && <Card className="p-3 bg-muted/40"><ReceiptFields tx={tx} setTx={setTx} showParty={false} /></Card>}
        <Button className="w-full min-h-[52px] text-base" disabled={saving} onClick={submit}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{direction === 'in' ? 'Record Entry (IN)' : 'Record Exit (OUT)'}{attach ? ' + Receipt' : ''}</Button>
      </Card>

      {receiptFor && <QuickReceiptCard facility={facility} agentId={agentId} profile={receiptFor} onDone={() => { setReceiptFor(null); onQueued(); }} />}

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Roster check-in / check-out</h2><Button variant="ghost" size="sm" className="min-h-[44px]" onClick={onRegister}>+ New person</Button></div>
        <Input aria-label="Search roster" placeholder="Search name or phone..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {roster.map((p) => { const st = summary.personStatus[p.id]; return (
            <div key={p.id} className="flex items-center gap-2 p-2 rounded-xl border border-border">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium truncate">{p.full_name}</p><p className="text-xs text-muted-foreground truncate">{medicalRoleLabel(p.role_type)}{st ? ` · ${st.direction === 'in' ? '🟢 Inside' : '🔴 Left'} ${formatEatTime(st.recorded_at)}` : ''}</p></div>
              <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => mark(p, 'in')}>🟢 IN</Button>
              <Button size="sm" variant="outline" className="min-h-[44px]" onClick={() => mark(p, 'out')}>🔴 OUT</Button>
              <Button size="sm" variant="ghost" className="min-h-[44px]" onClick={() => setReceiptFor(p)}>+ Receipt</Button>
            </div>); })}
          {!roster.length && <p className="text-sm text-muted-foreground">No registered people yet.</p>}
        </div>
      </Card>

      <Card className="p-4 space-y-2">
        <h2 className="font-semibold">Today's Live Movement Timeline</h2>
        {summary.todayLogs.map((l) => (
          <div key={l.id} className="flex items-center gap-2 py-1 border-b border-border/50 last:border-0">
            <Badge variant={l.direction === 'in' ? 'default' : 'destructive'}>{l.direction === 'in' ? '🟢 IN' : '🔴 OUT'}</Badge>
            <div className="min-w-0 flex-1"><p className="text-sm truncate">{l.person_name}</p><p className="text-xs text-muted-foreground truncate">{formatEatTime(l.recorded_at)} · {medicalRoleLabel(l.role_type)}{l.visit_purpose_or_note ? ` · ${l.visit_purpose_or_note}` : ''}</p></div>
            <Button size="sm" variant="ghost" className="min-h-[44px] gap-1" onClick={() => flip(l)}><Repeat className="h-4 w-4" />Flip IN/OUT</Button>
          </div>
        ))}
        {!summary.todayLogs.length && <p className="text-sm text-muted-foreground">No movements recorded today.</p>}
      </Card>
    </div>
  );
}

function QuickReceiptCard({ facility, agentId, profile, onDone }: { facility: MedicalFacilityRow; agentId: string; profile: MedicalProfileRow; onDone: () => void }) {
  const [tx, setTx] = useState<TxDraft>(() => ({ ...newTxDraft(), payer_or_payee_name: profile.full_name, payer_or_payee_phone: profile.phone ?? '' }));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!(Number(tx.amount) > 0)) { toast.error('Enter the amount'); return; }
    setSaving(true);
    const res = await saveMedicalTransaction(txRowFrom(tx, facility, agentId, { profile_id: profile.id }));
    setSaving(false);
    toast.success(res.saved ? `🧾 Receipt ${res.row.receipt_number} saved` : 'Saved on this phone, will send automatically');
    onDone();
  };
  return (
    <Card className="p-4 space-y-3 border-primary/40">
      <div className="flex items-center justify-between"><h2 className="font-semibold">Receipt for {profile.full_name}</h2><Button variant="ghost" size="sm" onClick={onDone}>Close</Button></div>
      <ReceiptFields tx={tx} setTx={setTx} showParty />
      <Button className="w-full min-h-12" disabled={saving} onClick={save}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save Receipt</Button>
    </Card>
  );
}

/* ---------------- Tab 2: Receipts & Transactions ---------------- */

function TransactionsView({ facility, agentId, onQueued }: { facility: MedicalFacilityRow; agentId: string; onQueued: () => void }) {
  const { txs, refresh } = useFacilityRecords(facility.id, 0);
  const profiles = useFacilityProfiles(facility.id);
  const [tx, setTx] = useState<TxDraft>(() => newTxDraft());
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const summary = useMemo(() => computeMedicalTxSummary(txs), [txs]);
  const save = async () => {
    if (!(Number(tx.amount) > 0)) { toast.error('Enter the amount'); return; }
    if (!tx.payer_or_payee_name.trim()) { toast.error(tx.tx_direction === 'in' ? 'Enter the payer name' : 'Enter the payee name'); return; }
    setSaving(true);
    const res = await saveMedicalTransaction(txRowFrom(tx, facility, agentId, {}));
    setSaving(false);
    refresh(); onQueued();
    toast.success(res.saved ? `🧾 ${res.row.receipt_number} saved — ${formatUGX(res.row.amount_ugx)} ${res.row.tx_direction.toUpperCase()}` : 'No connection — saved on this phone, will send automatically');
    setTx(newTxDraft(tx.tx_direction));
  };
  const list = summary.todayTransactions.filter((t) => filter === 'all' || t.tx_direction === filter);
  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">Record a receipt or transaction</h2>
        <ReceiptFields tx={tx} setTx={setTx} showParty profiles={profiles} />
        <Button className="w-full min-h-[52px] text-base" disabled={saving} onClick={save}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save {tx.tx_direction === 'in' ? 'Receipt (IN)' : 'Payout (OUT)'}</Button>
      </Card>
      <Card className="p-4 space-y-2">
        <h2 className="font-semibold">Today's Receipts & Cashbook Ledger</h2>
        <div className="flex flex-wrap gap-2">
          {([['all', 'All'], ['in', '🟢 IN (Receipts)'], ['out', '🔴 OUT (Payouts)']] as const).map(([k, l]) => <Button key={k} size="sm" variant={filter === k ? 'default' : 'outline'} className="min-h-[40px]" onClick={() => setFilter(k)}>{l}</Button>)}
        </div>
        {list.map((t) => (
          <div key={t.id} className="flex items-center gap-2 py-2 border-b border-border/50 last:border-0">
            <Badge variant={t.tx_direction === 'in' ? 'default' : 'destructive'}>{t.tx_direction === 'in' ? '🟢 IN' : '🔴 OUT'}</Badge>
            <div className="min-w-0 flex-1"><p className="text-sm truncate">{t.payer_or_payee_name} · {txCategoryLabel(t.category)}</p><p className="text-xs text-muted-foreground truncate">{formatEatTime(t.recorded_at)} · {t.receipt_number} · {paymentMethodLabel(t.payment_method)}{t.items_or_description ? ` · ${t.items_or_description}` : ''}</p></div>
            <p className="text-sm font-semibold shrink-0">{formatUGX(Number(t.amount_ugx))}</p>
          </div>
        ))}
        {!list.length && <p className="text-sm text-muted-foreground">No transactions recorded today.</p>}
      </Card>
    </div>
  );
}

/* ---------------- Tab 3: Register profile & smartphone link ---------------- */

function ProfileRegistration({ facility, agentId, onQueued }: { facility: MedicalFacilityRow; agentId: string; onQueued: () => void }) {
  const [role, setRole] = useState<string>('patient');
  const [f, setF] = useState({ full_name: '', phone: '', department_or_ward: '', next_of_kin_name: '', next_of_kin_phone: '', asset_category: '', asset_quantity: '', notes: '' });
  const [hasPhone, setHasPhone] = useState<boolean | null>(null);
  const [logEntry, setLogEntry] = useState(true);
  const [saving, setSaving] = useState(false);
  const [last, setLast] = useState<{ row: MedicalProfileRow; saved: boolean } | null>(null);
  const isAsset = role === 'facility_asset';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((d) => ({ ...d, [k]: e.target.value }));

  const submit = async () => {
    if (isAsset && !f.asset_category) { toast.error('Choose the asset type'); return; }
    if (!isAsset && !f.full_name.trim()) { toast.error('Enter the full name'); return; }
    if (!isAsset && hasPhone === null) { toast.error('Answer: has a smartphone?'); return; }
    setSaving(true);
    const id = crypto.randomUUID();
    const row: MedicalProfileRow = {
      id, client_ref: id, facility_id: facility.id, role_type: role, registered_by_agent_id: agentId,
      full_name: isAsset ? f.asset_category : f.full_name.trim(),
      phone: f.phone.trim() || null, department_or_ward: f.department_or_ward || null,
      next_of_kin_name: f.next_of_kin_name.trim() || null, next_of_kin_phone: f.next_of_kin_phone.trim() || null,
      asset_category: isAsset ? f.asset_category : null, asset_quantity: isAsset ? Number(f.asset_quantity) || 1 : null,
      notes: f.notes.trim() || null, signup_link_sent: false, signup_channel: null,
      ...(isAsset ? { has_smartphone: null, smartphone_queue_status: 'not_needed' } : medicineSmartphoneFields(!!hasPhone)),
    };
    const res = await saveMedicalProfile(row);
    if (!isAsset && logEntry) {
      const gid = crypto.randomUUID();
      await saveMedicalGateLog({ id: gid, client_ref: gid, facility_id: facility.id, profile_id: row.id, direction: 'in', person_name: row.full_name, role_type: role, phone: row.phone, department_or_ward: row.department_or_ward, entry_point_name: facility.entry_point_name, visit_purpose_or_note: 'Registered at entrance', attendant_or_kin_name: row.next_of_kin_name, attendant_or_kin_phone: row.next_of_kin_phone, agent_id: agentId, recorded_at: new Date().toISOString() });
    }
    setSaving(false);
    setLast(res);
    onQueued();
    if (!res.saved) toast.message('No connection — saved on this phone, will send automatically');
    else toast.success(`${row.full_name} registered`);
    setF({ full_name: '', phone: '', department_or_ward: '', next_of_kin_name: '', next_of_kin_phone: '', asset_category: '', asset_quantity: '', notes: '' });
    setHasPhone(null);
  };

  return (
    <div className="space-y-4">
      {last && last.row.has_smartphone && <MedicineSignupCard row={last.row} saved={last.saved} facility={facility} agentId={agentId} />}
      {last && last.row.smartphone_queue_status === 'queued' && <Card className="p-3 border-primary/40 bg-primary/5 flex gap-2"><Gift className="h-5 w-5 text-primary shrink-0" /><p className="text-sm">{last.row.full_name} is in the Free Smartphone queue.</p></Card>}
      <Card className="p-4 space-y-3">
        <h2 className="font-semibold">Register a person or asset</h2>
        <Chips options={MEDICAL_PROFILE_ROLES} value={role} onChange={setRole} />
        {isAsset ? <>
          <Field label="Asset type"><Chips options={MEDICAL_ASSET_TYPES} value={f.asset_category} onChange={(v) => setF((d) => ({ ...d, asset_category: v }))} /></Field>
          <Field label="Quantity"><Input inputMode="numeric" value={f.asset_quantity} onChange={(e) => setF((d) => ({ ...d, asset_quantity: e.target.value.replace(/\D/g, '') }))} /></Field>
          <Field label="Notes"><Input value={f.notes} onChange={set('notes')} /></Field>
        </> : <>
          <Field label="Full name"><Input value={f.full_name} onChange={set('full_name')} /></Field>
          <Field label="Phone"><Input inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Department / ward"><Chips options={MEDICAL_DEPARTMENTS} value={f.department_or_ward} onChange={(v) => setF((d) => ({ ...d, department_or_ward: d.department_or_ward === v ? '' : v }))} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Next of kin"><Input value={f.next_of_kin_name} onChange={set('next_of_kin_name')} /></Field>
            <Field label="Next of kin phone"><Input inputMode="tel" value={f.next_of_kin_phone} onChange={set('next_of_kin_phone')} /></Field>
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Has a smartphone?</Label>
            <button type="button" onClick={() => setHasPhone(true)} className={cn('w-full min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', hasPhone === true ? 'bg-primary text-primary-foreground border-primary' : 'border-border')}><Smartphone className="h-4 w-4" />Yes — send Welile App sign-up link</button>
            <button type="button" onClick={() => setHasPhone(false)} className={cn('w-full min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', hasPhone === false ? 'bg-primary text-primary-foreground border-primary' : 'border-border')}><Gift className="h-4 w-4" />No — add to Free Smartphone Queue</button>
          </div>
          <button type="button" aria-pressed={logEntry} onClick={() => setLogEntry((v) => !v)} className={cn('w-full min-h-[52px] rounded-xl border px-3 text-sm font-medium flex items-center gap-2', logEntry ? 'bg-primary/10 border-primary text-primary' : 'border-border')}><LogIn className="h-4 w-4 shrink-0" />🟢 Also log as ENTERED (IN) today</button>
        </>}
        <Button className="w-full min-h-[52px] text-base" onClick={submit} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save & next person</Button>
      </Card>
    </div>
  );
}

function MedicineSignupCard({ row, saved, facility, agentId }: { row: MedicalProfileRow; saved: boolean; facility: MedicalFacilityRow; agentId: string }) {
  const link = useMemo(() => buildMedicineSignupLink(agentId, facility.id, row.id), [agentId, facility.id, row.id]);
  const msg = buildMedicineSignupMessage(row.full_name, link, facility.facility_name);
  const phone = toIntlDigits(row.phone || row.next_of_kin_phone);
  const [sent, setSent] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const mark = (c: 'whatsapp' | 'sms' | 'qr') => { if (saved) markMedicalSignupSent(row.id, c).then(() => setSent(true)); };
  return (
    <Card className="p-3 space-y-2">
      <div className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-primary" /><p className="text-sm font-semibold flex-1">Send sign-up link to {row.full_name}</p>{sent && <CheckCircle2 className="h-4 w-4 text-primary" />}</div>
      <div className="grid grid-cols-4 gap-2">
        <Button asChild variant="outline" className="min-h-[44px] px-1" onClick={() => mark('whatsapp')}><a href={`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" /><span className="sr-only sm:not-sr-only sm:ml-1">WhatsApp</span></a></Button>
        <Button asChild variant="outline" className="min-h-[44px] px-1" onClick={() => mark('sms')}><a href={`sms:${phone ? '+' + phone : ''}?body=${encodeURIComponent(msg)}`}><MessageSquare className="h-4 w-4" /><span className="sr-only sm:not-sr-only sm:ml-1">SMS</span></a></Button>
        <Button variant="outline" className="min-h-[44px] px-1" aria-label="Show QR code" onClick={() => { setShowQr((v) => !v); mark('qr'); }}><QrCode className="h-4 w-4" /></Button>
        <Button variant="outline" className="min-h-[44px] px-1" aria-label="Copy link" onClick={() => { navigator.clipboard?.writeText(link); toast.success('Link copied'); }}><Copy className="h-4 w-4" /></Button>
      </div>
      {showQr && <div className="flex justify-center p-3 bg-card rounded-xl"><QRCodeSVG value={link} size={180} /></div>}
      {!saved && <p className="text-xs text-muted-foreground">Saved on this phone; the sent mark is recorded once it uploads.</p>}
    </Card>
  );
}

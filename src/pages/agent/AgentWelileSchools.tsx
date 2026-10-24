import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GraduationCap, Lock, LockOpen, MapPin, Loader2, Smartphone, Gift, MessageCircle, MessageSquare, Copy, CheckCircle2, CloudOff } from 'lucide-react';
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
import type { UgLocationSelection } from '@/hooks/useUgLocations';
import {
  SCHOOL_LEVELS, SCHOOL_OWNERSHIP, FACILITY_TYPES, PROFILE_ROLES, roleGroup, roleLabel,
  buildSchoolSignupLink, buildSignupMessage, toIntlDigits, smartphoneFields,
  readLockedSchool, writeLockedSchool, saveProfile, flushPendingProfiles, readPendingProfiles, markSignupSent,
  type SchoolRow, type SchoolProfileRow,
} from '@/lib/welileSchools';

const db = supabase as any;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1"><Label className="text-sm">{label}</Label>{children}</div>;
}

function Chips({ options, value, onChange }: { options: readonly string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o} type="button" onClick={() => onChange(o)}
          className={cn('min-h-[44px] px-3 rounded-xl border text-sm', value === o ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border')}>
          {o}
        </button>
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

  const lockSchool = (s: SchoolRow | null) => { setLocked(s); writeLockedSchool(s); };

  const captureGps = () => {
    if (!navigator.geolocation) { toast.error('GPS not available — type coordinates instead'); return; }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDraft((d) => ({ ...d, latitude: pos.coords.latitude, longitude: pos.coords.longitude, gps_accuracy_m: Math.round(pos.coords.accuracy), gps_source: 'device' }));
        setGpsBusy(false);
      },
      () => { setGpsBusy(false); toast.error('Could not get GPS — type coordinates instead'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
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

  const set = (k: keyof SchoolRow) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

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
            <Button className="w-full min-h-[48px]" onClick={() => setCreating(true)}>+ Register a new school</Button>
            {schools.length > 0 && <p className="text-sm text-muted-foreground">Or pick a registered school:</p>}
            <div className="space-y-2 max-h-[50vh] overflow-y-auto">
              {schools.map((s) => (
                <button key={s.id} onClick={() => lockSchool(s)} className="w-full text-left p-3 rounded-xl border border-border min-h-[52px]">
                  <p className="text-sm font-medium">{s.name}</p>
                  <p className="text-xs text-muted-foreground">{[s.school_level, s.district, s.village].filter(Boolean).join(' · ')}</p>
                </button>
              ))}
            </div>
          </Card>
        )}

        {!locked && creating && (
          <Card className="p-4 space-y-3">
            <h2 className="font-semibold">New school</h2>
            <Field label="School name"><Input value={draft.name ?? ''} onChange={set('name')} /></Field>
            <Field label="Level"><Chips options={SCHOOL_LEVELS} value={draft.school_level ?? ''} onChange={(v) => setDraft((d) => ({ ...d, school_level: v }))} /></Field>
            <Field label="Ownership"><Chips options={SCHOOL_OWNERSHIP} value={draft.ownership ?? ''} onChange={(v) => setDraft((d) => ({ ...d, ownership: v }))} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Head teacher name"><Input value={draft.head_name ?? ''} onChange={set('head_name')} /></Field>
              <Field label="Head teacher phone"><Input inputMode="tel" value={draft.head_phone ?? ''} onChange={set('head_phone')} /></Field>
            </div>
            <Field label="Estimated enrolment"><Input inputMode="numeric" value={draft.estimated_enrollment ?? ''} onChange={(e) => setDraft((d) => ({ ...d, estimated_enrollment: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null }))} /></Field>
            <div className="grid grid-cols-2 gap-2">
              {([['country', 'Country'], ['region', 'Region / State'], ['district', 'District / County'], ['sub_county', 'Sub-county / Division'], ['town', 'Town / City'], ['parish', 'Parish / Ward'], ['village', 'Cell / Village'], ['gate_name', 'Gate name']] as const).map(([k, l]) => (
                <Field key={k} label={l}><Input value={(draft[k] as string) ?? ''} onChange={set(k)} /></Field>
              ))}
            </div>
            <Button type="button" variant="outline" className="w-full min-h-[48px]" onClick={captureGps} disabled={gpsBusy}>
              {gpsBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MapPin className="h-4 w-4 mr-2" />}Capture live GPS
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Latitude"><Input inputMode="decimal" value={draft.latitude ?? ''} onChange={(e) => setDraft((d) => ({ ...d, latitude: e.target.value === '' ? null : Number(e.target.value), gps_source: 'manual' }))} /></Field>
              <Field label="Longitude"><Input inputMode="decimal" value={draft.longitude ?? ''} onChange={(e) => setDraft((d) => ({ ...d, longitude: e.target.value === '' ? null : Number(e.target.value), gps_source: 'manual' }))} /></Field>
              <Field label="Accuracy (m)"><Input value={draft.gps_accuracy_m ?? ''} readOnly /></Field>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" className="min-h-[48px]" onClick={() => setCreating(false)}>Cancel</Button>
              <Button className="flex-1 min-h-[48px]" onClick={createSchool} disabled={savingSchool}>{savingSchool && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Save & lock school</Button>
            </div>
          </Card>
        )}

        {locked && user && <GateRegistration school={locked} agentId={user.id} onQueued={() => setPendingCount(readPendingProfiles().length)} />}
      </main>
    </div>
  );
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

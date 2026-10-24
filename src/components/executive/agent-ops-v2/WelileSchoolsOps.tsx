import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GraduationCap, ChevronRight, MapPin, Loader2, MessageCircle, MessageSquare } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  roleGroup, roleLabel, mapLink, osmLink, locationPath, buildSchoolSignupLink, buildSignupMessage, toIntlDigits, markSignupSent,
  type SchoolRow, type SchoolProfileRow,
} from '@/lib/welileSchools';

const db = supabase as any;

async function fetchAll<T>(table: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from(table).select('*').order('created_at', { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function useSchoolsData() {
  return useQuery({
    queryKey: ['welile-schools-ops'],
    queryFn: async () => {
      const [schools, profiles] = await Promise.all([fetchAll<SchoolRow>('welile_schools'), fetchAll<SchoolProfileRow>('welile_school_profiles')]);
      const agentIds = Array.from(new Set(profiles.map((p) => p.registered_by).filter(Boolean))) as string[];
      const agents: Record<string, string> = {};
      for (let i = 0; i < agentIds.length; i += 200) {
        const { data } = await db.from('profiles').select('id, full_name').in('id', agentIds.slice(i, i + 200));
        (data ?? []).forEach((a: any) => { agents[a.id] = a.full_name ?? '—'; });
      }
      return { schools, profiles, agents };
    },
    staleTime: 60_000,
  });
}

export function computeSchoolKpis(schools: SchoolRow[], profiles: SchoolProfileRow[]) {
  const by = { pupil: 0, teacher: 0, staff: 0, parent: 0, asset: 0 } as Record<string, number>;
  profiles.forEach((p) => { by[roleGroup(p.role)]++; });
  return {
    schools: schools.length,
    profiles: profiles.length,
    by,
    countries: new Set(schools.map((s) => s.country).filter(Boolean)).size,
    districts: new Set(schools.map((s) => `${s.country}|${s.district}`).filter((k) => !k.endsWith('|null') && !k.endsWith('|'))).size,
    gps: schools.filter((s) => s.latitude != null && s.longitude != null).length,
    linksSent: profiles.filter((p) => p.signup_link_sent).length,
    phonesRequested: profiles.filter((p) => p.needs_free_smartphone).length,
    phonesPending: profiles.filter((p) => p.needs_free_smartphone && (p.smartphone_status === 'Requested' || p.smartphone_status === 'Approved')).length,
  };
}

export function WelileSchoolsCard() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useSchoolsData();
  const k = data ? computeSchoolKpis(data.schools, data.profiles) : null;
  const tile = (label: string, v: number | undefined) => (
    <div className="rounded-xl border border-border/60 p-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-lg font-bold">{v ?? '—'}</p></div>
  );
  return (
    <>
      <Card className="rounded-2xl border-border/50 p-3 sm:p-4 cursor-pointer" onClick={() => setOpen(true)}>
        <div className="flex items-center gap-2 mb-3">
          <GraduationCap className="h-5 w-5 text-primary" />
          <h3 className="text-sm font-semibold flex-1">Welile Schools</h3>
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {tile('Schools registered', k?.schools)}
          {tile('Profiles captured', k?.profiles)}
          {tile('Districts covered', k?.districts)}
          {tile('GPS-verified schools', k?.gps)}
          {tile('Sign-up links sent', k?.linksSent)}
          {tile('Free smartphones requested', k?.phonesRequested)}
          {tile('Pending delivery', k?.phonesPending)}
          {tile('Pupils / students', k?.by.pupil)}
        </div>
        {k && <p className="text-xs text-muted-foreground mt-2">{k.countries} countries · {k.districts} districts · Teachers {k.by.teacher} · Staff {k.by.staff} · Parents {k.by.parent} · Assets {k.by.asset}</p>}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-6xl h-[92vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5 text-primary" />Welile Schools</DialogTitle></DialogHeader>
          {data ? <Explorer {...data} /> : <Loader2 className="h-6 w-6 animate-spin mx-auto" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function WelileSchoolsOps({ onBack }: { onBack: () => void }) {
  const { data, isLoading } = useSchoolsData();
  const k = data ? computeSchoolKpis(data.schools, data.profiles) : null;
  const tile = (label: string, v: number | undefined) => (
    <div className="rounded-xl border border-border/60 p-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-lg font-bold">{v ?? '—'}</p></div>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
        <GraduationCap className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold flex-1">Welile Schools</h2>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {tile('Schools registered', k?.schools)}
        {tile('Profiles captured', k?.profiles)}
        {tile('Districts covered', k?.districts)}
        {tile('GPS-verified schools', k?.gps)}
        {tile('Sign-up links sent', k?.linksSent)}
        {tile('Free smartphones requested', k?.phonesRequested)}
        {tile('Pending delivery', k?.phonesPending)}
        {tile('Pupils / students', k?.by.pupil)}
      </div>
      {k && <p className="text-xs text-muted-foreground">{k.countries} countries · {k.districts} districts · Teachers {k.by.teacher} · Staff {k.by.staff} · Parents {k.by.parent} · Assets {k.by.asset}</p>}
      {data ? <Explorer {...data} /> : <Loader2 className="h-6 w-6 animate-spin mx-auto" />}
    </div>
  );
}

const LEVELS = ['country', 'region', 'district', 'town', 'village'] as const;
type Level = (typeof LEVELS)[number];

function Explorer({ schools, profiles, agents }: { schools: SchoolRow[]; profiles: SchoolProfileRow[]; agents: Record<string, string> }) {
  const [path, setPath] = useState<Partial<Record<Level, string>>>({});
  const [schoolId, setSchoolId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const schoolMap = useMemo(() => Object.fromEntries(schools.map((s) => [s.id, s])), [schools]);
  const inPath = (s: SchoolRow) => LEVELS.every((l) => !path[l] || (s[l] ?? '—') === path[l]);
  const scoped = schools.filter(inPath);
  const nextLevel = LEVELS.find((l) => !path[l]);
  const counts = (id: string) => {
    const ps = profiles.filter((p) => p.school_id === id);
    const c = { pupil: 0, teacher: 0, staff: 0, parent: 0, asset: 0 } as Record<string, number>;
    ps.forEach((p) => c[roleGroup(p.role)]++);
    return c;
  };

  return (
    <Tabs defaultValue="geo">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="geo">Schools & locations</TabsTrigger>
        <TabsTrigger value="profiles">Every profile</TabsTrigger>
        <TabsTrigger value="links">Sign-up links</TabsTrigger>
        <TabsTrigger value="phones">Free smartphone queue</TabsTrigger>
      </TabsList>

      <TabsContent value="geo" className="space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button className="underline" onClick={() => { setPath({}); setSchoolId(null); setPersonId(null); }}>World</button>
          {LEVELS.filter((l) => path[l]).map((l, i, arr) => (
            <span key={l} className="flex items-center gap-1"><ChevronRight className="h-3 w-3" />
              <button className="underline" onClick={() => { const np: any = {}; arr.slice(0, i + 1).forEach((x) => (np[x] = path[x])); setPath(np); setSchoolId(null); setPersonId(null); }}>{path[l]}</button>
            </span>
          ))}
          {schoolId && <span className="flex items-center gap-1"><ChevronRight className="h-3 w-3" />{schoolMap[schoolId]?.name}</span>}
        </div>

        {personId ? <ProfileDetail p={profiles.find((p) => p.id === personId)!} school={schoolMap[schoolId!]} agent={agents} onBack={() => setPersonId(null)} />
          : schoolId ? (
            <div className="space-y-2">
              {['pupil', 'teacher', 'staff', 'parent', 'asset'].map((g) => {
                const list = profiles.filter((p) => p.school_id === schoolId && roleGroup(p.role) === g);
                if (!list.length) return null;
                return (
                  <Card key={g} className="p-3">
                    <p className="text-sm font-semibold mb-2 capitalize">{g === 'pupil' ? 'Pupils & students' : g === 'asset' ? 'Facilities' : g + 's'} ({list.length})</p>
                    <div className="divide-y divide-border">
                      {list.map((p) => (
                        <button key={p.id} className="w-full text-left py-2 text-sm flex justify-between" onClick={() => setPersonId(p.id)}>
                          <span>{p.full_name || p.facility_type} <span className="text-muted-foreground">· {roleLabel(p.role)}</span></span><ChevronRight className="h-4 w-4" />
                        </button>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : nextLevel ? (
            <div className="grid sm:grid-cols-2 gap-2">
              {Object.entries(scoped.reduce<Record<string, number>>((acc, s) => { const v = s[nextLevel] ?? '—'; acc[v] = (acc[v] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).map(([v, n]) => (
                <button key={v} onClick={() => setPath((p) => ({ ...p, [nextLevel]: v }))} className="p-3 rounded-xl border border-border text-left flex justify-between">
                  <span><span className="text-xs text-muted-foreground capitalize">{nextLevel}</span><br />{v}</span><Badge variant="secondary">{n} schools</Badge>
                </button>
              ))}
              {!scoped.length && <p className="text-sm text-muted-foreground">No schools registered yet.</p>}
            </div>
          ) : null}

        {!schoolId && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">School</th><th className="p-2">Location</th><th className="p-2">GPS</th><th className="p-2">Pupils</th><th className="p-2">Teachers</th><th className="p-2">Staff</th><th className="p-2">Parents</th></tr></thead>
              <tbody>
                {scoped.map((s) => { const c = counts(s.id); const g = mapLink(s.latitude, s.longitude); return (
                  <tr key={s.id} className="border-t border-border">
                    <td className="p-2"><button className="underline text-left" onClick={() => setSchoolId(s.id)}>{s.name}</button><div className="text-xs text-muted-foreground">{s.school_level}</div></td>
                    <td className="p-2 text-xs">{locationPath(s)}</td>
                    <td className="p-2 text-xs">{g ? <span className="flex flex-col"><a className="underline flex items-center gap-1" href={g} target="_blank" rel="noreferrer"><MapPin className="h-3 w-3" />{s.latitude?.toFixed(5)}, {s.longitude?.toFixed(5)}</a><a className="underline" href={osmLink(s.latitude, s.longitude)!} target="_blank" rel="noreferrer">OpenStreetMap</a>{s.gps_accuracy_m != null && <span>±{s.gps_accuracy_m} m</span>}</span> : '—'}</td>
                    <td className="p-2">{c.pupil}</td><td className="p-2">{c.teacher}</td><td className="p-2">{c.staff}</td><td className="p-2">{c.parent}</td>
                  </tr>); })}
              </tbody>
            </table>
          </div>
        )}
      </TabsContent>

      <TabsContent value="profiles"><ProfileTable profiles={profiles} schoolMap={schoolMap} agents={agents} mode="all" /></TabsContent>
      <TabsContent value="links"><ProfileTable profiles={profiles.filter((p) => p.has_smartphone != null)} schoolMap={schoolMap} agents={agents} mode="links" /></TabsContent>
      <TabsContent value="phones"><ProfileTable profiles={profiles.filter((p) => p.needs_free_smartphone)} schoolMap={schoolMap} agents={agents} mode="phones" /></TabsContent>
    </Tabs>
  );
}

function ProfileDetail({ p, school, agent, onBack }: { p: SchoolProfileRow; school?: SchoolRow; agent: Record<string, string>; onBack: () => void }) {
  const rows = Object.entries(p).filter(([k, v]) => v !== null && v !== '' && !['id', 'school_id', 'client_ref', 'registered_by'].includes(k));
  return (
    <Card className="p-3 space-y-2">
      <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
      <p className="font-semibold">{p.full_name || p.facility_type} · {roleLabel(p.role)}</p>
      <p className="text-xs text-muted-foreground">{school?.name} · {school && locationPath(school)} · Registered by {agent[p.registered_by ?? ''] ?? '—'}</p>
      <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (<div key={k} className="flex justify-between gap-2 border-b border-border/50 py-1"><dt className="text-muted-foreground">{k.replace(/_/g, ' ')}</dt><dd className="text-right">{String(v)}</dd></div>))}
      </dl>
    </Card>
  );
}

function ProfileTable({ profiles, schoolMap, agents, mode }: { profiles: SchoolProfileRow[]; schoolMap: Record<string, SchoolRow>; agents: Record<string, string>; mode: 'all' | 'links' | 'phones' }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [school, setSchool] = useState('');
  const [district, setDistrict] = useState('');
  const needle = q.trim().toLowerCase();
  const list = profiles.filter((p) => {
    const s = schoolMap[p.school_id];
    if (school && p.school_id !== school) return false;
    if (district && s?.district !== district) return false;
    if (!needle) return true;
    return [p.full_name, s?.name, roleLabel(p.role), s?.country, s?.district, s?.town, s?.village, agents[p.registered_by ?? '']].some((v) => v?.toLowerCase().includes(needle));
  });
  const districts = Array.from(new Set(Object.values(schoolMap).map((s) => s.district).filter(Boolean))) as string[];
  const setStatus = async (id: string, status: string) => {
    const { error } = await db.from('welile_school_profiles').update({ smartphone_status: status }).eq('id', id);
    if (error) toast.error(error.message); else { toast.success(`Marked ${status}`); qc.invalidateQueries({ queryKey: ['welile-schools-ops'] }); }
  };
  const resend = async (p: SchoolProfileRow, ch: 'whatsapp' | 'sms') => {
    const s = schoolMap[p.school_id];
    const link = buildSchoolSignupLink(p.registered_by ?? '', p.school_id, p.id);
    const msg = buildSignupMessage(p.full_name, s?.name ?? 'your school', link);
    const phone = toIntlDigits(p.whatsapp || p.phone || p.guardian_whatsapp || p.guardian_phone);
    window.open(ch === 'whatsapp' ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}` : `sms:${phone ? '+' + phone : ''}?body=${encodeURIComponent(msg)}`, '_blank');
    await markSignupSent(p.id, ch);
    qc.invalidateQueries({ queryKey: ['welile-schools-ops'] });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search name, school, role, place, agent" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <select className="h-10 rounded-md border border-input bg-background px-2 text-sm" value={school} onChange={(e) => setSchool(e.target.value)}>
          <option value="">All schools</option>{Object.values(schoolMap).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="h-10 rounded-md border border-input bg-background px-2 text-sm" value={district} onChange={(e) => setDistrict(e.target.value)}>
          <option value="">All districts</option>{districts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <Badge variant="secondary" className="self-center">{list.length}</Badge>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Name</th><th className="p-2">Role</th><th className="p-2">School</th><th className="p-2">Place</th><th className="p-2">Agent</th>
            {mode === 'links' && <><th className="p-2">Smartphone</th><th className="p-2">Link sent</th><th className="p-2">Resend</th></>}
            {mode === 'phones' && <><th className="p-2">Contact</th><th className="p-2">Handover</th><th className="p-2">Verified</th><th className="p-2">Status</th></>}
          </tr></thead>
          <tbody>
            {list.slice(0, 500).map((p) => { const s = schoolMap[p.school_id]; return (
              <tr key={p.id} className="border-t border-border">
                <td className="p-2">{p.full_name || p.facility_type}</td><td className="p-2">{roleLabel(p.role)}</td><td className="p-2">{s?.name}</td>
                <td className="p-2 text-xs">{[s?.country, s?.district, s?.town, s?.village].filter(Boolean).join(' · ')}</td>
                <td className="p-2 text-xs">{agents[p.registered_by ?? ''] ?? '—'}</td>
                {mode === 'links' && <>
                  <td className="p-2">{p.has_smartphone ? 'Yes' : 'No'}</td>
                  <td className="p-2 text-xs">{p.signup_link_sent ? `${p.signup_link_channel ?? ''} ${p.signup_link_sent_at ? new Date(p.signup_link_sent_at).toLocaleDateString() : ''}` : 'Not sent'}</td>
                  <td className="p-2">{p.has_smartphone && <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => resend(p, 'whatsapp')}><MessageCircle className="h-3 w-3" /></Button><Button size="sm" variant="outline" onClick={() => resend(p, 'sms')}><MessageSquare className="h-3 w-3" /></Button></div>}</td>
                </>}
                {mode === 'phones' && <>
                  <td className="p-2 text-xs">{p.smartphone_contact_phone || p.guardian_phone || '—'}</td>
                  <td className="p-2 text-xs">{p.smartphone_handover_point || s?.gate_name || '—'}</td>
                  <td className="p-2 text-xs">{p.smartphone_verification_status || '—'}</td>
                  <td className="p-2"><select className="h-9 rounded-md border border-input bg-background px-1 text-xs" value={p.smartphone_status ?? 'Requested'} onChange={(e) => setStatus(p.id, e.target.value)}>
                    {['Requested', 'Approved', 'Delivered', 'Cancelled'].map((o) => <option key={o}>{o}</option>)}</select></td>
                </>}
              </tr>); })}
          </tbody>
        </table>
        {list.length > 500 && <p className="text-xs text-muted-foreground p-2">Showing first 500 — narrow the search.</p>}
      </div>
    </div>
  );
}

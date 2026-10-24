import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stethoscope, MapPin, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  medicalRoleGroup, medicalRoleLabel, facilityTypeLabel, facilityLocationPath, mapLink, osmLink, formatEatTime, txCategoryLabel, paymentMethodLabel,
  computeMedicalGateSummary, computeMedicalTxSummary,
  type MedicalFacilityRow, type MedicalProfileRow, type MedicalGateLogRow, type MedicalTransactionRow,
} from '@/lib/welileMedicine';

const db = supabase as any;
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

async function fetchAll<T>(table: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 50000; from += 1000) {
    const { data, error } = await db.from(table).select('*').order(order, { ascending: false }).range(from, from + 999);
    if (error) throw error;
    out.push(...(data as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function useMedicineData() {
  return useQuery({
    queryKey: ['welile-medicine-ops'],
    queryFn: async () => {
      const [facilities, profiles, gateLogs, transactions] = await Promise.all([
        fetchAll<MedicalFacilityRow>('welile_medical_facilities', 'created_at'),
        fetchAll<MedicalProfileRow>('welile_medical_profiles', 'created_at'),
        fetchAll<MedicalGateLogRow>('welile_medical_gate_logs', 'recorded_at'),
        fetchAll<MedicalTransactionRow>('welile_medical_transactions', 'recorded_at'),
      ]);
      return { facilities, profiles, gateLogs, transactions };
    },
    staleTime: 60_000,
  });
}

export function computeMedicineKpis(facilities: MedicalFacilityRow[], profiles: MedicalProfileRow[], gateLogs: MedicalGateLogRow[] = [], transactions: MedicalTransactionRow[] = [], now: Date = new Date()) {
  const gate = computeMedicalGateSummary(gateLogs, now);
  const tx = computeMedicalTxSummary(transactions, now);
  const by = { patient: 0, staff: 0, visitor: 0, asset: 0 } as Record<string, number>;
  profiles.forEach((p) => { by[medicalRoleGroup(p.role_type)]++; });
  return {
    facilities: facilities.length,
    profiles: profiles.length,
    by,
    districts: new Set(facilities.map((f) => f.district).filter(Boolean)).size,
    gps: facilities.filter((f) => f.gps_lat != null && f.gps_lng != null).length,
    enteredToday: gate.enteredToday,
    exitedToday: gate.exitedToday,
    currentlyInside: gate.currentlyInside,
    gateLogsTotal: gateLogs.length,
    txInToday: tx.receiptsInCount,
    txOutToday: tx.payoutsOutCount,
    moneyInTodayUgx: tx.moneyInTodayUgx,
    moneyOutTodayUgx: tx.moneyOutTodayUgx,
    netCashflowTodayUgx: tx.netCashflowTodayUgx,
    totalReceipts: transactions.length,
    allTimeInUgx: tx.allTimeInUgx,
    allTimeOutUgx: tx.allTimeOutUgx,
    linksSent: profiles.filter((p) => p.signup_link_sent).length,
    phonesQueued: profiles.filter((p) => p.smartphone_queue_status !== 'not_needed').length,
    phonesPending: profiles.filter((p) => ['queued', 'approved', 'dispatched'].includes(p.smartphone_queue_status)).length,
  };
}

function KpiGrid({ k }: { k: ReturnType<typeof computeMedicineKpis> | null }) {
  const tile = (label: string, v: string | number | undefined) => (
    <div className="rounded-xl border border-border/60 p-2"><p className="text-[11px] text-muted-foreground">{label}</p><p className="text-lg font-bold break-words">{v ?? '—'}</p></div>
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {tile('Facilities registered', k?.facilities)}
      {tile('Profiles captured', k?.profiles)}
      {tile('Districts covered', k?.districts)}
      {tile('GPS-verified facilities', k?.gps)}
      {tile('Entered today (IN)', k?.enteredToday)}
      {tile('Exited today (OUT)', k?.exitedToday)}
      {tile('Currently inside', k?.currentlyInside)}
      {tile('Free smartphone queue', k?.phonesQueued)}
      {tile('Money IN Today', k ? ugx(k.moneyInTodayUgx) : undefined)}
      {tile('Money OUT Today', k ? ugx(k.moneyOutTodayUgx) : undefined)}
      {tile('Net Cashflow Today', k ? ugx(k.netCashflowTodayUgx) : undefined)}
      {tile('Total Receipts', k?.totalReceipts)}
    </div>
  );
}

export function WelileMedicineCard() {
  const { data, isLoading } = useMedicineData();
  const k = data ? computeMedicineKpis(data.facilities, data.profiles, data.gateLogs, data.transactions) : null;
  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3"><Stethoscope className="h-5 w-5 text-primary" /><h3 className="text-sm font-semibold flex-1">Welile Medicine</h3>{isLoading && <Loader2 className="h-4 w-4 animate-spin" />}</div>
      <KpiGrid k={k} />
    </Card>
  );
}

export function WelileMedicineOps({ onBack }: { onBack: () => void }) {
  const { data, isLoading, error } = useMedicineData();
  const k = data ? computeMedicineKpis(data.facilities, data.profiles, data.gateLogs, data.transactions) : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
        <Stethoscope className="h-5 w-5 text-primary" />
        <h2 className="text-base font-semibold flex-1">Welile Medicine</h2>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
      {error && <p className="text-sm text-destructive">Could not load Welile Medicine records.</p>}
      <KpiGrid k={k} />
      {k && <p className="text-xs text-muted-foreground">Patients {k.by.patient} · Staff {k.by.staff} · Caregivers & suppliers {k.by.visitor} · Assets {k.by.asset} · All-time IN {ugx(k.allTimeInUgx)} · OUT {ugx(k.allTimeOutUgx)}</p>}
      {data ? <Explorer {...data} /> : <Loader2 className="h-6 w-6 animate-spin mx-auto" />}
    </div>
  );
}

const sel = 'h-10 rounded-md border border-input bg-background px-2 text-sm';

function Explorer({ facilities, profiles, gateLogs, transactions }: { facilities: MedicalFacilityRow[]; profiles: MedicalProfileRow[]; gateLogs: MedicalGateLogRow[]; transactions: MedicalTransactionRow[] }) {
  const fmap = useMemo(() => Object.fromEntries(facilities.map((f) => [f.id, f])), [facilities]);
  return (
    <Tabs defaultValue="gate">
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="gate">Gate IN / OUT live log</TabsTrigger>
        <TabsTrigger value="tx">Receipts & Transactions (IN / OUT)</TabsTrigger>
        <TabsTrigger value="facilities">Facilities & locations</TabsTrigger>
        <TabsTrigger value="phones">Free Smartphone Queue</TabsTrigger>
        <TabsTrigger value="profiles">Profiles & Assets Registry</TabsTrigger>
      </TabsList>
      <TabsContent value="gate"><GateTable logs={gateLogs} fmap={fmap} /></TabsContent>
      <TabsContent value="tx"><TxTable txs={transactions} fmap={fmap} /></TabsContent>
      <TabsContent value="facilities"><FacilityTable facilities={facilities} profiles={profiles} gateLogs={gateLogs} transactions={transactions} /></TabsContent>
      <TabsContent value="phones"><ProfileTable profiles={profiles.filter((p) => p.smartphone_queue_status !== 'not_needed')} fmap={fmap} queue /></TabsContent>
      <TabsContent value="profiles"><ProfileTable profiles={profiles} fmap={fmap} /></TabsContent>
    </Tabs>
  );
}

function FacilitySelect({ value, onChange, fmap }: { value: string; onChange: (v: string) => void; fmap: Record<string, MedicalFacilityRow> }) {
  return <select className={sel} value={value} onChange={(e) => onChange(e.target.value)}><option value="">All facilities</option>{Object.values(fmap).map((f) => <option key={f.id} value={f.id}>{f.facility_name}</option>)}</select>;
}

function GateTable({ logs, fmap }: { logs: MedicalGateLogRow[]; fmap: Record<string, MedicalFacilityRow> }) {
  const [q, setQ] = useState(''); const [fac, setFac] = useState(''); const [dir, setDir] = useState('');
  const n = q.trim().toLowerCase();
  const list = logs.filter((l) => (!fac || l.facility_id === fac) && (!dir || l.direction === dir) && (!n || [l.person_name, medicalRoleLabel(l.role_type), fmap[l.facility_id]?.facility_name, l.visit_purpose_or_note, l.agent_name].some((v) => v?.toLowerCase().includes(n))));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2"><Input placeholder="Search name, role, note" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" /><FacilitySelect value={fac} onChange={setFac} fmap={fmap} /><select className={sel} value={dir} onChange={(e) => setDir(e.target.value)}><option value="">All</option><option value="in">Entered (IN)</option><option value="out">Exited (OUT)</option></select><Badge variant="secondary" className="self-center">{list.length}</Badge></div>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Direction</th><th className="p-2">Time (EAT)</th><th className="p-2">Person</th><th className="p-2">Role</th><th className="p-2">Facility</th><th className="p-2">Purpose</th><th className="p-2">Attendant</th></tr></thead>
        <tbody>{list.slice(0, 500).map((l) => (
          <tr key={l.id} className="border-t border-border">
            <td className="p-2"><Badge variant={l.direction === 'in' ? 'default' : 'destructive'}>{l.direction === 'in' ? '🟢 IN' : '🔴 OUT'}</Badge></td>
            <td className="p-2 text-xs">{new Date(l.recorded_at).toLocaleDateString()} {formatEatTime(l.recorded_at)}</td>
            <td className="p-2">{l.person_name}</td><td className="p-2">{medicalRoleLabel(l.role_type)}</td>
            <td className="p-2 text-xs">{fmap[l.facility_id]?.facility_name ?? '—'}</td>
            <td className="p-2 text-xs">{[l.department_or_ward, l.visit_purpose_or_note].filter(Boolean).join(' · ') || '—'}</td>
            <td className="p-2 text-xs">{l.attendant_or_kin_name || '—'}</td>
          </tr>))}</tbody>
      </table>{!list.length && <p className="text-sm text-muted-foreground p-2">No movements recorded yet.</p>}</div>
    </div>
  );
}

function TxTable({ txs, fmap }: { txs: MedicalTransactionRow[]; fmap: Record<string, MedicalFacilityRow> }) {
  const [q, setQ] = useState(''); const [fac, setFac] = useState(''); const [dir, setDir] = useState('');
  const n = q.trim().toLowerCase();
  const list = txs.filter((t) => (!fac || t.facility_id === fac) && (!dir || t.tx_direction === dir) && (!n || [t.receipt_number, t.payer_or_payee_name, txCategoryLabel(t.category), t.items_or_description].some((v) => v?.toLowerCase().includes(n))));
  const tin = list.filter((t) => t.tx_direction === 'in').reduce((s, t) => s + Number(t.amount_ugx), 0);
  const tout = list.filter((t) => t.tx_direction === 'out').reduce((s, t) => s + Number(t.amount_ugx), 0);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2"><Input placeholder="Search receipt, payer, item" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" /><FacilitySelect value={fac} onChange={setFac} fmap={fmap} /><select className={sel} value={dir} onChange={(e) => setDir(e.target.value)}><option value="">All</option><option value="in">IN (Receipts)</option><option value="out">OUT (Payouts)</option></select><Badge variant="secondary" className="self-center">{list.length}</Badge></div>
      <p className="text-xs text-muted-foreground">Shown: IN {ugx(tin)} · OUT {ugx(tout)} · Net {ugx(tin - tout)}</p>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Direction</th><th className="p-2">Time (EAT)</th><th className="p-2">Receipt #</th><th className="p-2">Category</th><th className="p-2">Amount</th><th className="p-2">Method</th><th className="p-2">Payer / Payee</th><th className="p-2">Facility</th></tr></thead>
        <tbody>{list.slice(0, 500).map((t) => (
          <tr key={t.id} className="border-t border-border">
            <td className="p-2"><Badge variant={t.tx_direction === 'in' ? 'default' : 'destructive'}>{t.tx_direction === 'in' ? '🟢 IN' : '🔴 OUT'}</Badge></td>
            <td className="p-2 text-xs">{new Date(t.recorded_at).toLocaleDateString()} {formatEatTime(t.recorded_at)}</td>
            <td className="p-2 text-xs">{t.receipt_number}</td><td className="p-2 text-xs">{txCategoryLabel(t.category)}</td>
            <td className="p-2 font-medium">{ugx(Number(t.amount_ugx))}</td><td className="p-2 text-xs">{paymentMethodLabel(t.payment_method)}</td>
            <td className="p-2 text-xs">{t.payer_or_payee_name}</td><td className="p-2 text-xs">{fmap[t.facility_id]?.facility_name ?? '—'}</td>
          </tr>))}</tbody>
      </table>{!list.length && <p className="text-sm text-muted-foreground p-2">No transactions recorded yet.</p>}</div>
    </div>
  );
}

function FacilityTable({ facilities, profiles, gateLogs, transactions }: { facilities: MedicalFacilityRow[]; profiles: MedicalProfileRow[]; gateLogs: MedicalGateLogRow[]; transactions: MedicalTransactionRow[] }) {
  const [district, setDistrict] = useState('');
  const districts = Array.from(new Set(facilities.map((f) => f.district).filter(Boolean))) as string[];
  const list = facilities.filter((f) => !district || f.district === district);
  return (
    <div className="space-y-2">
      <select className={sel} value={district} onChange={(e) => setDistrict(e.target.value)}><option value="">All districts</option>{districts.map((d) => <option key={d}>{d}</option>)}</select>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Facility</th><th className="p-2">Location</th><th className="p-2">GPS</th><th className="p-2">Profiles</th><th className="p-2">Today IN / OUT / Inside</th><th className="p-2">Today money IN / OUT</th></tr></thead>
        <tbody>{list.map((f) => {
          const g = computeMedicalGateSummary(gateLogs.filter((l) => l.facility_id === f.id));
          const t = computeMedicalTxSummary(transactions.filter((x) => x.facility_id === f.id));
          const gm = mapLink(f.gps_lat, f.gps_lng);
          return (
            <tr key={f.id} className="border-t border-border">
              <td className="p-2">{f.facility_name}<div className="text-xs text-muted-foreground">{facilityTypeLabel(f.facility_type)}</div></td>
              <td className="p-2 text-xs">{facilityLocationPath(f)}</td>
              <td className="p-2 text-xs">{gm ? <span className="flex flex-col"><a className="underline flex items-center gap-1" href={gm} target="_blank" rel="noreferrer"><MapPin className="h-3 w-3" />{f.gps_lat?.toFixed(5)}, {f.gps_lng?.toFixed(5)}</a><a className="underline" href={osmLink(f.gps_lat, f.gps_lng)!} target="_blank" rel="noreferrer">OpenStreetMap</a></span> : '—'}</td>
              <td className="p-2">{profiles.filter((p) => p.facility_id === f.id).length}</td>
              <td className="p-2 text-xs">{g.enteredToday} / {g.exitedToday} / {g.currentlyInside}</td>
              <td className="p-2 text-xs">{ugx(t.moneyInTodayUgx)} / {ugx(t.moneyOutTodayUgx)}</td>
            </tr>);
        })}</tbody>
      </table>{!list.length && <p className="text-sm text-muted-foreground p-2">No facilities registered yet.</p>}</div>
    </div>
  );
}

function ProfileTable({ profiles, fmap, queue }: { profiles: MedicalProfileRow[]; fmap: Record<string, MedicalFacilityRow>; queue?: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(''); const [fac, setFac] = useState('');
  const n = q.trim().toLowerCase();
  const list = profiles.filter((p) => (!fac || p.facility_id === fac) && (!n || [p.full_name, medicalRoleLabel(p.role_type), fmap[p.facility_id]?.facility_name, p.phone].some((v) => v?.toLowerCase().includes(n))));
  const setStatus = async (id: string, status: string) => {
    const { error } = await db.from('welile_medical_profiles').update({ smartphone_queue_status: status }).eq('id', id);
    if (error) toast.error(error.message); else { toast.success(`Marked ${status}`); qc.invalidateQueries({ queryKey: ['welile-medicine-ops'] }); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2"><Input placeholder="Search name, role, phone" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" /><FacilitySelect value={fac} onChange={setFac} fmap={fmap} /><Badge variant="secondary" className="self-center">{list.length}</Badge></div>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-muted-foreground"><th className="p-2">Name</th><th className="p-2">Role</th><th className="p-2">Facility</th><th className="p-2">Phone</th><th className="p-2">{queue ? 'Queue status' : 'Smartphone / link'}</th></tr></thead>
        <tbody>{list.slice(0, 500).map((p) => (
          <tr key={p.id} className="border-t border-border">
            <td className="p-2">{p.full_name}{p.asset_quantity ? ` × ${p.asset_quantity}` : ''}</td><td className="p-2">{medicalRoleLabel(p.role_type)}</td>
            <td className="p-2 text-xs">{fmap[p.facility_id]?.facility_name ?? '—'}</td><td className="p-2 text-xs">{p.phone || p.next_of_kin_phone || '—'}</td>
            <td className="p-2 text-xs">{queue
              ? <select className="h-9 rounded-md border border-input bg-background px-1 text-xs" value={p.smartphone_queue_status} onChange={(e) => setStatus(p.id, e.target.value)}>{['queued', 'approved', 'dispatched', 'delivered'].map((o) => <option key={o}>{o}</option>)}</select>
              : p.has_smartphone == null ? '—' : p.has_smartphone ? (p.signup_link_sent ? `Link sent (${p.signup_channel ?? ''})` : 'Has smartphone') : 'Free smartphone queue'}</td>
          </tr>))}</tbody>
      </table>{!list.length && <p className="text-sm text-muted-foreground p-2">Nothing here yet.</p>}</div>
    </div>
  );
}


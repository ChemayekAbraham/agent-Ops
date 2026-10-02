import { useState } from 'react';
import { format } from 'date-fns';
import { Search, Loader2, MapPin, ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useDebouncedValue as useDebounce } from '@/hooks/useDebouncedValue';
import { useDossierSearch, useDossierProfile, useDossierMoney, useDossierPartner, useDossierActivity, MoneyFilters } from '@/hooks/useCtoUserDossier';

const ugx = (n: any) => (n == null ? '—' : `UGX ${Math.round(Number(n)).toLocaleString('en-US')}`);
const dt = (d: any) => (d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—');
const label = (s: string) => (s || '').replace(/_/g, ' ').replace(/\broi\b/gi, 'Returns').replace(/\bloan\b/gi, 'Rent Plan');

function Loading() { return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>; }
function Err({ e }: { e: any }) { return <p className="text-sm text-destructive py-4">{String(e?.message ?? e)}</p>; }
function Field({ k, v }: { k: string; v: any }) {
  return <div><p className="text-xs text-muted-foreground">{k}</p><p className="text-sm font-medium break-words">{v ?? '—'}</p></div>;
}

export function CTOUserDossier() {
  const [q, setQ] = useState('');
  const dq = useDebounce(q, 300);
  const [userId, setUserId] = useState<string>();
  const [tab, setTab] = useState('profile');
  const search = useDossierSearch(dq);
  const prof = useDossierProfile(userId);
  const p = prof.data?.profile;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">User Dossier</h2>
        <p className="text-xs text-muted-foreground">Read-only audit view of everything about one user.</p>
      </div>
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search name, phone, email or WEL- ID" value={q} onChange={(e) => setQ(e.target.value)} />
        {dq.length >= 2 && !userId && (
          <Card className="absolute z-20 mt-1 w-full max-h-80 overflow-auto">
            {search.isLoading ? <Loading /> : search.error ? <Err e={search.error} /> : (search.data ?? []).length === 0 ? <p className="p-3 text-sm text-muted-foreground">No users found</p> :
              (search.data as any[]).map((u) => (
                <button key={u.id} className="flex w-full items-center gap-3 p-2 text-left hover:bg-muted" onClick={() => { setUserId(u.id); setTab('profile'); }}>
                  <Avatar className="h-8 w-8"><AvatarImage src={u.avatar_url} /><AvatarFallback>{(u.full_name || '?')[0]}</AvatarFallback></Avatar>
                  <div className="min-w-0"><p className="text-sm font-medium truncate">{u.full_name || 'Unnamed'}</p><p className="text-xs text-muted-foreground">{u.phone} · {u.ai_id}</p></div>
                </button>
              ))}
          </Card>
        )}
      </div>

      {userId && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-4 p-4">
              <Avatar className="h-14 w-14"><AvatarImage src={p?.avatar_url} /><AvatarFallback>{(p?.full_name || '?')[0]}</AvatarFallback></Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-lg font-bold">{p?.full_name ?? '…'}</p>
                <p className="text-xs text-muted-foreground">{prof.data?.ai_id} · {p?.phone} · {p?.email}</p>
                <div className="mt-1 flex flex-wrap gap-1">{(prof.data?.roles ?? []).map((r: any) => <Badge key={r.role} variant={r.enabled ? 'secondary' : 'outline'}>{label(r.role)}{!r.enabled && ' (off)'}</Badge>)}</div>
              </div>
              <Button variant="outline" size="sm" onClick={() => { setUserId(undefined); setQ(''); }}>Change user</Button>
            </CardContent>
          </Card>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList><TabsTrigger value="profile">Profile</TabsTrigger><TabsTrigger value="money">Money</TabsTrigger><TabsTrigger value="partner">Partner</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
            <TabsContent value="profile">{prof.isLoading ? <Loading /> : prof.error ? <Err e={prof.error} /> : <ProfileSection d={prof.data} />}</TabsContent>
            <TabsContent value="money"><MoneySection id={userId} active={tab === 'money'} balances={prof.data} /></TabsContent>
            <TabsContent value="partner"><PartnerSection id={userId} active={tab === 'partner'} /></TabsContent>
            <TabsContent value="activity"><ActivitySection id={userId} active={tab === 'activity'} /></TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function ProfileSection({ d }: { d: any }) {
  const p = d?.profile ?? {};
  const lat = p.residence_lat, lng = p.residence_lng;
  const addr = [p.village, p.parish, p.sub_county, p.district, p.region, p.country].filter(Boolean).join(', ');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Field k="Full name" v={p.full_name} /><Field k="Welile AI ID" v={d?.ai_id} />
          <Field k="Email" v={p.email} /><Field k="Phone" v={p.phone} />
          <Field k="Joined" v={dt(p.created_at)} /><Field k="Last active" v={dt(p.last_active_at)} />
          <Field k="Last sign-in" v={dt(d?.last_sign_in_at)} /><Field k="Referrals made" v={d?.referral_count} />
          <Field k="Signup channel" v={p.signup_channel || p.signup_source} /><Field k="Status" v={p.deleted_at ? 'Deleted' : p.is_frozen ? `Frozen — ${p.frozen_reason ?? ''}` : 'Active'} />
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Location</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Field k="Full address" v={addr || '—'} /></div>
          <Field k="Landmark" v={p.landmark} /><Field k="City / town" v={p.city || p.town} />
          <Field k="GPS" v={lat && lng ? <a className="text-primary inline-flex items-center gap-1 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${lat},${lng}`}><MapPin className="h-3 w-3" />{Number(lat).toFixed(5)}, {Number(lng).toFixed(5)}</a> : '—'} />
          <Field k="GPS updated" v={dt(p.residence_updated_at)} />
        </CardContent></Card>
      <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-sm">Profile change history</CardTitle></CardHeader>
        <CardContent>
          {(d?.contact_changes ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No recorded changes</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="text-left p-2">When</th><th className="text-left p-2">Field</th><th className="text-left p-2">Old</th><th className="text-left p-2">New</th><th className="text-left p-2">By</th></tr></thead>
              <tbody>{d.contact_changes.map((c: any, i: number) => (
                <tr key={i} className={`border-t ${['email', 'phone'].includes(c.field) ? 'bg-accent/40' : ''}`}><td className="p-2 whitespace-nowrap">{dt(c.at)}</td><td className="p-2">{label(c.field)}</td><td className="p-2 text-muted-foreground">{c.old ?? '—'}</td><td className="p-2">{c.new ?? '—'}</td><td className="p-2">{c.by ?? 'System'}</td></tr>
              ))}</tbody></table></div>)}
        </CardContent></Card>
    </div>
  );
}

function MoneySection({ id, active, balances }: { id: string; active: boolean; balances: any }) {
  const [f, setF] = useState<MoneyFilters>({ offset: 0 });
  const [rows, setRows] = useState<any[]>([]);
  const m = useDossierMoney(id, f, active);
  const shown = f.offset === 0 ? (m.data?.rows ?? []) : [...rows, ...(m.data?.rows ?? [])];
  const set = (patch: Partial<MoneyFilters>) => { setRows([]); setF((o) => ({ ...o, ...patch, offset: 0 })); };
  const b = balances?.balances ?? {};
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Card><CardContent className="p-3"><Field k="Available to withdraw" v={ugx(balances?.available)} /></CardContent></Card>
        <Card><CardContent className="p-3"><Field k="Withdrawable (wallet)" v={ugx(b.withdrawable)} /></CardContent></Card>
        <Card><CardContent className="p-3"><Field k="Float" v={ugx(b.float_balance)} /></CardContent></Card>
        <Card><CardContent className="p-3"><Field k="Advance" v={ugx(b.advance_balance)} /></CardContent></Card>
      </div>
      {m.error && <Err e={m.error} />}
      <Card><CardHeader><CardTitle className="text-sm">Totals by category (click to filter)</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {(m.data?.categories ?? []).map((c: any) => (
            <button key={c.category} onClick={() => set({ category: f.category === c.category ? undefined : c.category })}
              className={`rounded-md border px-3 py-2 text-left text-xs ${f.category === c.category ? 'border-primary bg-primary/10' : ''}`}>
              <p className="font-semibold">{label(c.category)} <span className="text-muted-foreground">({c.count})</span></p>
              <p className="text-success">In {ugx(c.in ?? 0)}</p><p className="text-destructive">Out {ugx(c.out ?? 0)}</p>
            </button>))}
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Wallet statement · {m.data?.total ?? 0} entries</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select className="h-9 rounded-md border bg-background px-2 text-sm" value={f.direction ?? ''} onChange={(e) => set({ direction: e.target.value || undefined })}>
              <option value="">In & out</option><option value="cash_in">Money in</option><option value="cash_out">Money out</option></select>
            <Input type="date" className="w-40" value={f.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />
            <Input type="date" className="w-40" value={f.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />
            <Input className="w-56" placeholder="Reference / description" defaultValue={f.search} onKeyDown={(e) => e.key === 'Enter' && set({ search: (e.target as HTMLInputElement).value || undefined })} />
            {(f.category || f.direction || f.from || f.to || f.search) && <Button variant="ghost" size="sm" onClick={() => { setRows([]); setF({ offset: 0 }); }}>Clear</Button>}
          </div>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="text-left p-2">Date</th><th className="text-left p-2">Category</th><th className="text-left p-2">Description</th><th className="text-left p-2">Reference</th><th className="text-left p-2">Bucket</th><th className="text-right p-2">Amount</th></tr></thead>
            <tbody>{shown.map((r: any) => (
              <tr key={r.id} className="border-t"><td className="p-2 whitespace-nowrap">{dt(r.at)}</td><td className="p-2">{label(r.category)}</td><td className="p-2 max-w-xs truncate">{r.description}</td><td className="p-2 text-xs">{r.reference_id}</td><td className="p-2 text-xs">{r.wallet_bucket}</td>
                <td className={`p-2 text-right font-mono ${r.direction === 'cash_in' ? 'text-success' : 'text-destructive'}`}>{r.direction === 'cash_in' ? '+' : '−'}{ugx(r.amount)}</td></tr>))}</tbody></table></div>
          {m.isFetching && <Loading />}
          {!m.isFetching && shown.length < (m.data?.total ?? 0) && <Button variant="outline" size="sm" onClick={() => { setRows(shown); setF((o) => ({ ...o, offset: shown.length })); }}>Load more</Button>}
        </CardContent></Card>
    </div>
  );
}

function PartnerSection({ id, active }: { id: string; active: boolean }) {
  const q = useDossierPartner(id, active);
  const [open, setOpen] = useState<string>();
  if (q.isLoading) return <Loading />;
  if (q.error) return <Err e={q.error} />;
  const d = q.data ?? {};
  if (!d.counts?.total && !d.deleted?.length) return <p className="py-6 text-sm text-muted-foreground">Not a partner — no portfolios.</p>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">{['total', 'active', 'suspended', 'deleted'].map((k) => <Card key={k}><CardContent className="p-3"><Field k={`${k[0].toUpperCase()}${k.slice(1)} portfolios`} v={d.counts?.[k] ?? 0} /></CardContent></Card>)}</div>
      {(d.portfolios ?? []).map((pf: any) => {
        const h = pf.history ?? [];
        const n = (a: string) => h.filter((x: any) => x.action === a).length;
        return (
          <Card key={pf.id}>
            <button className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(open === pf.id ? undefined : pf.id)}>
              {open === pf.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              <div className="flex-1"><p className="font-semibold">{pf.code} <Badge variant="outline">{pf.status}</Badge></p>
                <p className="text-xs text-muted-foreground">Created {dt(pf.created_at)} · {ugx(pf.amount)} · {pf.rate}% Returns · {pf.duration} months · Returns earned {ugx(pf.returns_earned)}</p></div>
              <p className="text-xs text-muted-foreground">Top-ups {n('topped_up')} · Compounds {n('compounded')} · Edits {h.length - n('topped_up') - n('compounded') - n('created')}</p>
            </button>
            {open === pf.id && <CardContent>{h.length === 0 ? <p className="text-sm text-muted-foreground">No recorded changes</p> : (
              <table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="text-left p-2">When</th><th className="text-left p-2">Action</th><th className="text-left p-2">Change</th><th className="text-left p-2">By</th></tr></thead>
                <tbody>{h.map((x: any, i: number) => (
                  <tr key={i} className="border-t align-top"><td className="p-2 whitespace-nowrap">{dt(x.at)}</td><td className="p-2">{label(x.action)}</td>
                    <td className="p-2 text-xs">{(x.fields ?? []).map((fld: string) => <div key={fld}>{label(fld)}: <span className="text-muted-foreground">{String(x.before?.[fld] ?? '—')}</span> → {String(x.after?.[fld] ?? '—')}</div>)}</td>
                    <td className="p-2">{x.by ?? 'System'}</td></tr>))}</tbody></table>)}</CardContent>}
          </Card>);
      })}
      {(d.returns_withdrawals ?? []).length > 0 && <Card><CardHeader><CardTitle className="text-sm">Withdrawals</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
        {d.returns_withdrawals.map((w: any, i: number) => <div key={i} className="flex justify-between border-t py-1"><span>{dt(w.at)} · {w.reference}</span><span className="font-mono text-destructive">−{ugx(w.amount)}</span></div>)}</CardContent></Card>}
      {(d.deleted ?? []).length > 0 && <Card><CardHeader><CardTitle className="text-sm">Deleted portfolios</CardTitle></CardHeader><CardContent className="space-y-1 text-sm">
        {d.deleted.map((x: any, i: number) => <div key={i} className="border-t py-1">{x.code} · deleted {dt(x.at)} · was {ugx(x.before?.investment_amount)}</div>)}</CardContent></Card>}
    </div>
  );
}

const GROUPS: Record<string, string> = { account: 'Account', agent: 'Agent', tenant: 'Tenant', landlord: 'Landlord', supporter: 'Supporter' };

function ActivitySection({ id, active }: { id: string; active: boolean }) {
  const q = useDossierActivity(id, active);
  const [grp, setGrp] = useState<string>();
  if (q.isLoading) return <Loading />;
  if (q.error) return <Err e={q.error} />;
  const d = q.data ?? {};
  const events = (d.events ?? []).filter((e: any) => !grp || e.grp === grp);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={!grp ? 'default' : 'outline'} onClick={() => setGrp(undefined)}>All</Button>
        {Object.entries(d.counts ?? {}).map(([g, n]: any) => <Button key={g} size="sm" variant={grp === g ? 'default' : 'outline'} onClick={() => setGrp(g)}>{GROUPS[g] ?? g} · {n}</Button>)}
      </div>
      <Card><CardHeader><CardTitle className="text-sm">Devices used</CardTitle></CardHeader><CardContent>
        {(d.devices ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No device records</p> : d.devices.map((v: any, i: number) => (
          <div key={i} className="border-t py-2 text-sm"><p className="font-medium">{deviceName(v.ua)}</p><p className="text-xs text-muted-foreground">First {dt(v.first_seen)} · Last {dt(v.last_seen)} · {v.n} actions</p></div>))}
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-sm">Timeline · {events.length}</CardTitle></CardHeader><CardContent className="space-y-0">
        {events.map((e: any, i: number) => (
          <div key={i} className="flex items-center gap-3 border-t py-2 text-sm">
            <Badge variant="outline" className="w-20 justify-center">{GROUPS[e.grp]}</Badge>
            <span className="w-40 shrink-0 text-xs text-muted-foreground">{dt(e.at)}</span>
            <span className="flex-1">{label(e.kind)}{e.detail ? <span className="text-muted-foreground"> · {label(String(e.detail))}</span> : null}</span>
            {e.amount != null && <span className="font-mono">{ugx(e.amount)}</span>}
          </div>))}
      </CardContent></Card>
    </div>
  );
}

function deviceName(ua: string) {
  if (!ua) return 'Unknown';
  const os = /Android[^;)]*/.exec(ua)?.[0] || (/iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '');
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br}${os ? ' on ' + os : ''}`;
}

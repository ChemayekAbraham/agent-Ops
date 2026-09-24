import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db, fmtDate, labelize, useCurrentUserId, useMissions, usePeopleMap, useRdMe, useRdMutation } from './useRd';
import { SevBadge } from './Signals';

const NONE = '__none__';
const KINDS = ['rail', 'vuln', 'access', 'kyc', 'incident', 'audit'];
const STATUSES = ['open', 'mitigating', 'closed'];

export function Risk() {
  const navigate = useNavigate();
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const { data: missions = [] } = useMissions();
  const name = usePeopleMap();
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);

  const { data: risks = [], isLoading } = useQuery({
    queryKey: ['rd', 'risks'],
    queryFn: async () => {
      const { data, error } = await db.from('rd_risk_items').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const [kind, setKind] = useState('rail');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('p2');
  const [due, setDue] = useState('');
  const [blocks, setBlocks] = useState(NONE);

  const create = useRdMutation(async () => db.from('rd_risk_items').insert({
    kind, title, severity, due_on: due || null, blocks_mission_id: blocks === NONE ? null : blocks, owner_id: uid,
  }), 'Risk item added');
  const setStatus = useRdMutation(async (a: { id: string; status: string }) =>
    db.from('rd_risk_items').update({ status: a.status }).eq('id', a.id), 'Status updated');

  const sevOrder = (r: any) => ({ p0: 0, p1: 1, p2: 2 } as any)[r.severity] ?? 3;
  const sorted = [...risks].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || sevOrder(a) - sevOrder(b));

  return (
    <section className="space-y-4">
      {me?.is_contributor && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Add a risk item</h2>
          <div><Label>Title</Label><Input maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} /><p className="text-right text-[11px] text-muted-foreground">{title.length}/160</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><Label>Kind</Label><Select value={kind} onValueChange={setKind}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{labelize(k)}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Severity</Label><Select value={severity} onValueChange={setSeverity}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['p0', 'p1', 'p2'].map((v) => <SelectItem key={v} value={v}>{v.toUpperCase()}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Due on</Label><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
            <div><Label>Blocks mission</Label><Select value={blocks} onValueChange={setBlocks}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>None</SelectItem>{missions.filter((m) => m.stage !== 'kill').map((m) => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: () => { setTitle(''); setDue(''); setBlocks(NONE); } })}>Add risk item</Button>
        </Card>
      )}

      {isLoading ? <p className="text-sm text-muted-foreground">Loading risk items…</p> : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">No risk items. Contributors add one above for any rail, vulnerability, access, KYC, incident or audit issue.</p>
      ) : sorted.map((r) => (
        <Card key={r.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <SevBadge sev={r.severity} />
            <Badge variant="secondary">{labelize(r.kind)}</Badge>
            {r.severity === 'p0' && r.status !== 'closed' && r.blocks_mission_id && <Badge variant="destructive">Blocks ship</Badge>}
          </div>
          <p className="text-sm font-semibold text-foreground">{r.title}</p>
          <p className="text-xs text-muted-foreground">
            {name(r.owner_id)} · Opened {fmtDate(r.opened_on)} · Due {fmtDate(r.due_on)}
            {r.blocks_mission_id && <> · Mission: <button className="underline" onClick={() => navigate(`/rd/missions/${r.blocks_mission_id}`)}>{titles.get(r.blocks_mission_id) ?? 'Open'}</button></>}
          </p>
          <div className="w-40">
            <Select value={r.status} onValueChange={(v) => setStatus.mutate({ id: r.id, status: v })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{labelize(s)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </Card>
      ))}
    </section>
  );
}

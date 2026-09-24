import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { DOMAINS, db, fmtDateTime, labelize, toastErr, useCurrentUserId, useMissions, usePeopleMap, useRdMe, useRdMutation } from './useRd';

const NONE = '__none__';
const SEV_CLS: Record<string, string> = {
  p0: 'border-destructive/60 bg-destructive/10 text-destructive',
  p1: 'border-amber-500/50 bg-amber-500/10 text-amber-700',
  p2: 'text-muted-foreground',
};

export function SevBadge({ sev }: { sev: string }) {
  return <Badge variant="outline" className={`uppercase ${SEV_CLS[sev] ?? ''}`}>{sev}</Badge>;
}

export function Signals() {
  const navigate = useNavigate();
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const { data: missions = [] } = useMissions();
  const name = usePeopleMap();
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);
  const openMissions = missions.filter((m) => m.stage !== 'kill');

  const { data: signals = [], isLoading } = useQuery({
    queryKey: ['rd', 'signals'],
    queryFn: async () => {
      const { data, error } = await db.from('rd_signals').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const [body, setBody] = useState('');
  const [why, setWhy] = useState('');
  const [strength, setStrength] = useState('whisper');
  const [domain, setDomain] = useState<string>('product');
  const [severity, setSeverity] = useState('p2');
  const [mission, setMission] = useState(NONE);
  const [showClosed, setShowClosed] = useState(false);

  const create = useRdMutation(async () => db.from('rd_signals').insert({
    body, why_it_matters: why, strength, domain, severity,
    mission_id: mission === NONE ? null : mission, author_id: uid,
  }), 'Signal raised');
  const setStatus = useRdMutation(async (a: { id: string; status: string }) =>
    db.from('rd_signals').update({ status: a.status }).eq('id', a.id));

  const convert = async (id: string) => {
    const { data, error } = await db.rpc('rd_convert_signal', { p_signal: id });
    if (error) { toastErr(error); return; }
    toast.success('Converted to mission');
    navigate(`/rd/missions/${data}`);
  };

  const rank = (s: any) => (s.severity === 'p0' ? 0 : s.status === 'new' ? 1 : 2);
  const open = signals.filter((s) => s.status === 'new' || s.status === 'seen')
    .sort((a, b) => rank(a) - rank(b) || +new Date(b.created_at) - +new Date(a.created_at));
  const closed = signals.filter((s) => s.status === 'converted' || s.status === 'dismissed');

  const row = (s: any, isOpen: boolean) => (
    <Card key={s.id} className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <SevBadge sev={s.severity} />
        <Badge variant="secondary">{labelize(s.strength)}</Badge>
        <Badge variant="outline">{labelize(s.domain)}</Badge>
        <Badge variant="outline" className="text-muted-foreground">{labelize(s.status)}</Badge>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground">{s.body}</p>
      <p className="text-sm"><span className="text-muted-foreground">Why it matters: </span>{s.why_it_matters}</p>
      <p className="text-xs text-muted-foreground">
        {name(s.author_id)} · {fmtDateTime(s.created_at)}
        {s.mission_id && <> · Mission: <button className="underline" onClick={() => navigate(`/rd/missions/${s.mission_id}`)}>{titles.get(s.mission_id) ?? 'Open'}</button></>}
      </p>
      {isOpen && me?.is_lead && (
        <div className="flex flex-wrap gap-2">
          {s.status === 'new' && <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: s.id, status: 'seen' })}>Seen</Button>}
          <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: s.id, status: 'dismissed' })}>Dismiss</Button>
          <Button size="sm" onClick={() => void convert(s.id)}>Convert to mission</Button>
        </div>
      )}
    </Card>
  );

  return (
    <section className="space-y-4">
      {me?.is_contributor && (
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-semibold">Raise a signal</h2>
          <div><Label>Signal</Label><Textarea rows={3} maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} /><p className="text-right text-[11px] text-muted-foreground">{body.length}/500</p></div>
          <div><Label>Why it matters</Label><Textarea rows={2} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} /><p className="text-right text-[11px] text-muted-foreground">{why.length}/300</p></div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><Label>Strength</Label><Select value={strength} onValueChange={setStrength}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['whisper', 'pattern', 'confirmed'].map((v) => <SelectItem key={v} value={v}>{labelize(v)}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Domain</Label><Select value={domain} onValueChange={setDomain}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{DOMAINS.map((v) => <SelectItem key={v} value={v}>{labelize(v)}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Severity</Label><Select value={severity} onValueChange={setSeverity}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{['p0', 'p1', 'p2'].map((v) => <SelectItem key={v} value={v}>{v.toUpperCase()}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Mission</Label><Select value={mission} onValueChange={setMission}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>None</SelectItem>{openMissions.map((m) => <SelectItem key={m.id} value={m.id}>{m.title}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <Button size="sm" disabled={create.isPending} onClick={() => create.mutate(undefined, { onSuccess: () => { setBody(''); setWhy(''); setMission(NONE); setSeverity('p2'); } })}>Raise signal</Button>
        </Card>
      )}

      {isLoading ? <p className="text-sm text-muted-foreground">Loading signals…</p> : open.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open signals. Contributors raise one above when they notice something worth watching.</p>
      ) : <div className="space-y-2">{open.map((s) => row(s, true))}</div>}

      <div>
        <button className="flex items-center gap-1 text-sm font-semibold text-muted-foreground" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Closed ({closed.length})
        </button>
        {showClosed && <div className="mt-2 space-y-2">{closed.length ? closed.map((s) => row(s, false)) : <p className="text-sm text-muted-foreground">No closed signals yet.</p>}</div>}
      </div>
    </section>
  );
}

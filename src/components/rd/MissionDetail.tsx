import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft } from 'lucide-react';
import {
  ALL_STAGES, DELAY_BUCKETS, DOMAINS, HORIZONS, STAGES, STAGE_LABEL, db, fmtDate, fmtDateTime, labelize,
  toastErr, useComments, useCurrentUserId, useLinked, useMission, usePeopleMap, useRdMe, useRdMutation, useRdPeople,
} from './useRd';
import { KillDialog, ReasonDialog } from './KillDialog';
import { toast } from 'sonner';
import { useProducts, VALUES, VALUE_LABEL } from './values';
import { useSettings } from './useRd';

const EDITABLE = [
  'title', 'problem', 'constraint_note', 'bet', 'horizon', 'owner_id', 'deputy_id',
  'exit_metric_name', 'exit_metric_baseline', 'exit_metric_target', 'exit_metric_unit', 'exit_metric_result',
  'sol_days', 'delay_bucket', 'delay_note', 'kill_criteria', 'evidence', 'dependency_notes', 'next_gate_on', 'domains',
  'product_id', 'company_value', 'value_note',
] as const;
const NUMERIC = new Set(['exit_metric_baseline', 'exit_metric_target', 'exit_metric_result', 'sol_days']);
const NONE = '__none__';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </Card>
  );
}

export function MissionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: m, isLoading, error } = useMission(id);
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const { data: people = [] } = useRdPeople();
  const name = usePeopleMap();
  const { data: linked } = useLinked(id);
  const { data: comments = [] } = useComments(id);
  const [form, setForm] = useState<Record<string, any>>({});
  const [comment, setComment] = useState('');
  const [dlg, setDlg] = useState<null | 'advance' | 'back' | 'force' | 'pause' | 'kill'>(null);
  const [saving, setSaving] = useState(false);
  const { data: products = [] } = useProducts();
  const { data: settings } = useSettings();

  useEffect(() => { if (m) setForm(Object.fromEntries(EDITABLE.map((k) => [k, m[k] ?? null]))); }, [m]);

  const readOnly = m?.stage === 'kill';
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const reload = () => qc.invalidateQueries({ queryKey: ['rd'] });

  const save = async () => {
    if (!m) return;
    const changed: Record<string, any> = {};
    for (const k of EDITABLE) {
      let v = form[k];
      if (NUMERIC.has(k)) v = v === '' || v == null ? null : Number(v);
      else if (v === '') v = null;
      const orig = m[k] ?? null;
      if (JSON.stringify(v) !== JSON.stringify(orig)) changed[k] = v;
    }
    if (!Object.keys(changed).length) { toast('No changes'); return; }
    setSaving(true);
    const { error: e } = await db.from('rd_missions').update(changed).eq('id', m.id);
    setSaving(false);
    if (e) toastErr(e); else toast.success('Saved');
    reload();
  };

  const setStage = useRdMutation(async (a: { to: string; reason?: string; force?: boolean }) =>
    db.rpc('rd_set_stage', { p_mission: id, p_to: a.to, p_reason: a.reason ?? null, p_force: a.force ?? false }), 'Stage updated');
  const pause = useRdMutation(async (why: string) => db.rpc('rd_decide', { p_mission: id, p_decision: 'pause', p_why: why }), 'Mission paused');
  const approve = useRdMutation(async () => db.rpc('rd_approve_ship', { p_mission: id }), 'Approved to ship');
  const release = useRdMutation(async () => db.rpc('rd_release', { p_mission: id }), 'Released');
  const addComment = useRdMutation(async (body: string) => db.from('rd_comments').insert({ mission_id: id, author_id: uid, body }), 'Comment added');

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading mission…</p>;
  if (error || !m) return <p className="text-sm text-destructive">{error ? (error as any).message : 'Mission not found.'}</p>;

  const idx = STAGES.indexOf(m.stage as any);
  const next = idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1] : null;
  const prev = idx > 0 ? STAGES[idx - 1] : null;
  const isPayments = (m.domains ?? []).includes('payments');

  const txt = (k: string, label: string, rows = 3) => (
    <div><Label>{label}</Label><Textarea rows={rows} disabled={readOnly} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
  );
  const inp = (k: string, label: string, type = 'text') => (
    <div><Label>{label}</Label><Input type={type} disabled={readOnly} value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} /></div>
  );
  const pick = (k: string, label: string, opts: { v: string; l: string }[], allowNone = true) => (
    <div>
      <Label>{label}</Label>
      <Select disabled={readOnly} value={form[k] ?? NONE} onValueChange={(v) => set(k, v === NONE ? null : v)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {allowNone && <SelectItem value={NONE}>None</SelectItem>}
          {opts.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-4 pb-24">
      <Button variant="ghost" size="sm" className="gap-1.5 px-0" onClick={() => navigate('/rd')}><ArrowLeft className="h-4 w-4" />Pipeline</Button>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{STAGE_LABEL[m.stage] ?? m.stage}</Badge>
        {readOnly && <Badge variant="destructive">Killed — read-only</Badge>}
      </div>
      <Input className="text-lg font-bold" maxLength={80} disabled={readOnly} value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} />

      <Section title="Problem, constraint, bet">
        {txt('problem', 'Problem')}{txt('constraint_note', 'Constraint')}{txt('bet', 'Bet')}
      </Section>

      <Section title="Product and value">
        <div className="grid gap-3 sm:grid-cols-2">
          {pick('product_id', 'Product', products.filter((p) => p.active || p.id === m.product_id || p.id === form.product_id).map((p) => ({ v: p.id, l: p.active ? p.name : `${p.name} (inactive)` })))}
          <div>
            {pick('company_value', 'Company value', VALUES.map((v) => ({ v, l: VALUE_LABEL[v] })))}
            {form.company_value && (
              <p className="mt-1 text-xs text-muted-foreground">
                {(settings?.[`value_${form.company_value}`] ?? '').trim() || 'Not yet defined by the R&D lead'}
              </p>
            )}
          </div>
        </div>
        <div>
          <Label>How this mission serves the value</Label>
          <Textarea rows={2} maxLength={300} disabled={readOnly} value={form.value_note ?? ''} onChange={(e) => set('value_note', e.target.value)} />
        </div>
      </Section>

      <Section title="Stage, horizon, owner">
        <p className="text-sm">Stage: <span className="font-semibold">{STAGE_LABEL[m.stage]}</span></p>
        <div className="grid gap-3 sm:grid-cols-3">
          {pick('horizon', 'Horizon', HORIZONS.map((h) => ({ v: h, l: labelize(h) })), false)}
          {pick('owner_id', 'Owner', people.filter((p) => p.is_rd).map((p) => ({ v: p.user_id, l: p.full_name || 'Unknown staff' })))}
          {pick('deputy_id', 'Deputy', people.map((p) => ({ v: p.user_id, l: p.full_name || 'Unknown staff' })))}
        </div>
        <div>
          <Label>Domains</Label>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {DOMAINS.map((d) => {
              const on = (form.domains ?? []).includes(d);
              return (
                <Badge key={d} variant={on ? 'default' : 'outline'} className={readOnly ? '' : 'cursor-pointer select-none py-1'}
                  onClick={() => !readOnly && set('domains', on ? form.domains.filter((x: string) => x !== d) : [...(form.domains ?? []), d])}>
                  {labelize(d)}
                </Badge>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="Exit metric">
        <div className="grid gap-3 sm:grid-cols-2">
          {inp('exit_metric_name', 'Name')}{inp('exit_metric_unit', 'Unit')}
          {inp('exit_metric_baseline', 'Baseline', 'number')}{inp('exit_metric_target', 'Target', 'number')}
          {inp('exit_metric_result', 'Result', 'number')}
        </div>
      </Section>

      <Section title="Speed of light & delay">
        <div className="grid gap-3 sm:grid-cols-2">
          {inp('sol_days', 'SoL days', 'number')}
          <div><Label>Started on</Label><Input disabled value={fmtDate(m.started_on)} /></div>
          {pick('delay_bucket', 'Delay bucket', DELAY_BUCKETS.map((b) => ({ v: b, l: labelize(b) })))}
        </div>
        {txt('delay_note', 'Delay note', 2)}
      </Section>

      <Section title="Kill criteria">{txt('kill_criteria', 'Kill criteria')}</Section>

      <Section title="Evidence & dependencies">
        {txt('evidence', 'Evidence')}{txt('dependency_notes', 'Dependency notes', 2)}
        <div className="sm:w-1/2">{inp('next_gate_on', 'Next gate date', 'date')}</div>
      </Section>

      {!readOnly && (
        <div className="sticky bottom-2 z-10 flex justify-end">
          <Button disabled={saving} onClick={save} className="shadow-lg">Save changes</Button>
        </div>
      )}

      {isPayments && (
        <Section title="Payments status">
          <p className="text-sm">CEO approval: {m.ship_approved_by ? `${name(m.ship_approved_by)}, ${fmtDateTime(m.ship_approved_at)}` : 'pending'}</p>
          <p className="text-sm">CFO release: {m.released_by ? `${name(m.released_by)}, ${fmtDateTime(m.released_at)}` : 'pending'}</p>
          <div className="flex flex-wrap gap-2">
            {me?.is_ceo && m.stage === 'prove' && !m.ship_approved_at && (
              <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate(undefined)}>Approve to ship (CEO)</Button>
            )}
            {me?.is_cfo && m.stage === 'ship' && m.ship_approved_at && !m.released_at && (
              <Button size="sm" disabled={release.isPending} onClick={() => release.mutate(undefined)}>Release (CFO)</Button>
            )}
          </div>
        </Section>
      )}

      <Section title="Linked items">
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Signals ({linked?.signals.length ?? 0})</p>
          {linked?.signals.map((s: any) => (
            <p key={s.id} className="border-b border-border py-1.5 text-sm last:border-0">
              <Badge variant="outline" className="mr-1 uppercase">{s.severity}</Badge>{s.body} <span className="text-xs text-muted-foreground">· {labelize(s.status)}</span>
            </p>
          ))}
        </div>
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Experiments ({linked?.experiments.length ?? 0})</p>
          {linked?.experiments.map((x: any) => (
            <p key={x.id} className="border-b border-border py-1.5 text-sm last:border-0">
              {x.hypothesis} <span className="text-xs text-muted-foreground">· {fmtDate(x.start_on)} – {fmtDate(x.end_on)}{x.result ? ` · ${x.result}` : ''}</span>
            </p>
          ))}
        </div>
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Risk items ({linked?.risks.length ?? 0})</p>
          {linked?.risks.map((r: any) => (
            <p key={r.id} className="border-b border-border py-1.5 text-sm last:border-0">
              <Badge variant="outline" className="mr-1 uppercase">{r.severity}</Badge>{r.title} <span className="text-xs text-muted-foreground">· {labelize(r.status)}</span>
            </p>
          ))}
        </div>
      </Section>

      <Section title="Comments">
        {comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
        {comments.map((c: any) => (
          <div key={c.id} className="border-b border-border pb-2 last:border-0">
            <p className="text-xs text-muted-foreground">{name(c.author_id)} · {fmtDateTime(c.created_at)}</p>
            <p className="whitespace-pre-wrap text-sm">{c.body}</p>
          </div>
        ))}
        {me?.can_read && (
          <div className="space-y-2">
            <Textarea rows={2} placeholder="Add a comment" value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button size="sm" disabled={!comment.trim() || addComment.isPending}
              onClick={() => addComment.mutate(comment.trim(), { onSuccess: () => setComment('') })}>Post comment</Button>
          </div>
        )}
      </Section>

      {!readOnly && (
        <Section title="Actions">
          <div className="flex flex-wrap gap-2">
            {next && (
              <Button size="sm" disabled={setStage.isPending}
                onClick={() => (next === 'ship' || next === 'adopt') ? setDlg('advance') : setStage.mutate({ to: next })}>
                Advance to {STAGE_LABEL[next]}
              </Button>
            )}
            {me?.is_lead && (
              <>
                {prev && <Button size="sm" variant="outline" onClick={() => setDlg('back')}>Move back</Button>}
                <Button size="sm" variant="outline" onClick={() => setDlg('force')}>Force stage</Button>
                <Button size="sm" variant="outline" onClick={() => setDlg('pause')}>Pause</Button>
                <Button size="sm" variant="destructive" onClick={() => setDlg('kill')}>Kill</Button>
              </>
            )}
          </div>
        </Section>
      )}

      <ReasonDialog open={dlg === 'advance'} onOpenChange={(o) => !o && setDlg(null)} title={`Advance to ${next ? STAGE_LABEL[next] : ''}`}
        confirmLabel="Advance" pending={setStage.isPending}
        onConfirm={(r) => next && setStage.mutate({ to: next, reason: r }, { onSuccess: () => setDlg(null) })} />
      <ReasonDialog open={dlg === 'back'} onOpenChange={(o) => !o && setDlg(null)} title={`Move back to ${prev ? STAGE_LABEL[prev] : ''}`}
        confirmLabel="Move back" pending={setStage.isPending}
        onConfirm={(r) => prev && setStage.mutate({ to: prev, reason: r }, { onSuccess: () => setDlg(null) })} />
      <ReasonDialog open={dlg === 'force'} onOpenChange={(o) => !o && setDlg(null)} title="Force stage" confirmLabel="Force"
        stages={ALL_STAGES} pending={setStage.isPending}
        onConfirm={(r, s) => {
          if (!s) { toast.error('Choose a stage'); return; }
          setStage.mutate({ to: s, reason: r, force: true }, { onSuccess: () => setDlg(null) });
        }} />
      <ReasonDialog open={dlg === 'pause'} onOpenChange={(o) => !o && setDlg(null)} title="Pause mission — why?" confirmLabel="Pause"
        pending={pause.isPending} onConfirm={(r) => pause.mutate(r, { onSuccess: () => setDlg(null) })} />
      <KillDialog missionId={m.id} open={dlg === 'kill'} onOpenChange={(o) => !o && setDlg(null)} />
    </div>
  );
}

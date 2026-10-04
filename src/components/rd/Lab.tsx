import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db, fmtDate, labelize, useCurrentUserId, useMissions, usePeopleMap, useRdMe, useRdMutation, useRdPeople } from './useRd';

const EXP_DECISIONS = ['running', 'ship', 'iterate', 'revert', 'kill'];
const DECIDES = ['limit', 'tenor', 'fraud_flag', 'collection_path', 'other'];
const MV_STATUS = ['shadow', 'production', 'retired'];

type Field = { key: string; label: string; type?: 'text' | 'textarea' | 'date' | 'number' | 'select'; options?: { value: string; label: string }[] };

function RowForm({ open, title, fields, initial, onClose, onSave, saving }: {
  open: boolean; title: string; fields: Field[]; initial: Record<string, any>; saving: boolean;
  onClose: () => void; onSave: (v: Record<string, any>) => void;
}) {
  const [v, setV] = useState<Record<string, any>>(initial);
  const set = (k: string, val: any) => setV((p) => ({ ...p, [k]: val }));
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {fields.map((f) => (
            <div key={f.key}>
              <Label>{f.label}</Label>
              {f.type === 'textarea' ? <Textarea rows={2} value={v[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
                : f.type === 'select' ? (
                  <Select value={v[f.key] ?? ''} onValueChange={(x) => set(f.key, x)}>
                    <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
                    <SelectContent>{f.options!.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
                  </Select>
                ) : <Input type={f.type ?? 'text'} value={v[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />}
            </div>
          ))}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={saving} onClick={() => onSave(v)}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Send only changed fields on edit; blank strings become null.
function payload(v: Record<string, any>, initial: Record<string, any>, fields: Field[], isEdit: boolean) {
  const out: Record<string, any> = {};
  for (const f of fields) {
    let val = v[f.key];
    if (val === '' || val === undefined) val = null;
    if (f.type === 'number' && val !== null) val = Number(val);
    if (!isEdit || val !== (initial[f.key] ?? null)) out[f.key] = val;
  }
  return out;
}

const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: labelize(x) }));

export function Lab() {
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const { data: missions = [] } = useMissions();
  const { data: people = [] } = useRdPeople();
  const name = usePeopleMap();
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);

  const exps = useQuery({ queryKey: ['rd', 'experiments'], queryFn: async () => {
    const { data, error } = await db.from('rd_experiments').select('*').order('created_at', { ascending: false });
    if (error) throw error; return (data ?? []) as any[];
  } });
  const models = useQuery({ queryKey: ['rd', 'models'], queryFn: async () => {
    const { data, error } = await db.from('rd_model_versions').select('*').order('created_at', { ascending: false });
    if (error) throw error; return (data ?? []) as any[];
  } });

  const expFields: Field[] = [
    { key: 'mission_id', label: 'Mission (required)', type: 'select', options: missions.filter((m) => m.stage !== 'kill').map((m) => ({ value: m.id, label: m.title })) },
    { key: 'hypothesis', label: 'Hypothesis', type: 'textarea' },
    { key: 'cohort', label: 'Cohort' },
    { key: 'start_on', label: 'Start', type: 'date' },
    { key: 'end_on', label: 'End', type: 'date' },
    { key: 'guardrail', label: 'Guardrail', type: 'textarea' },
    { key: 'metric_name', label: 'Metric name' },
    { key: 'baseline', label: 'Baseline', type: 'number' },
    { key: 'observed', label: 'Observed', type: 'number' },
    { key: 'result', label: 'Result', type: 'textarea' },
    { key: 'decision', label: 'Decision', type: 'select', options: opts(EXP_DECISIONS) },
  ];
  const mvFields: Field[] = [
    { key: 'name', label: 'Name' },
    { key: 'version', label: 'Version' },
    { key: 'decides', label: 'Decides', type: 'select', options: opts(DECIDES) },
    { key: 'owner_id', label: 'Owner', type: 'select', options: people.map((p) => ({ value: p.user_id, label: p.full_name ?? 'Unnamed' })) },
    { key: 'training_window', label: 'Training window' },
    { key: 'features_note', label: 'Features', type: 'textarea' },
    { key: 'banned_features_note', label: 'Banned features', type: 'textarea' },
    { key: 'source_job', label: 'Source job' },
    { key: 'last_drift_check_on', label: 'Last drift check', type: 'date' },
    { key: 'rollback_path', label: 'Rollback path', type: 'textarea' },
    { key: 'status', label: 'Status', type: 'select', options: opts(MV_STATUS) },
  ];

  const [form, setForm] = useState<null | { kind: 'exp' | 'mv'; row?: any }>(null);
  const save = useRdMutation(async (a: { kind: 'exp' | 'mv'; row?: any; v: Record<string, any> }) => {
    const table = a.kind === 'exp' ? 'rd_experiments' : 'rd_model_versions';
    const fields = a.kind === 'exp' ? expFields : mvFields;
    const p = payload(a.v, a.row ?? {}, fields, !!a.row);
    if (a.row) return Object.keys(p).length ? db.from(table).update(p).eq('id', a.row.id) : null;
    if (a.kind === 'exp') p.owner_id = uid;
    return db.from(table).insert(p);
  }, 'Saved');

  const driftOverdue = (d?: string | null) => !d || Date.now() - new Date(d).getTime() > 30 * 86400000;
  const canEditExp = (r: any) => me?.is_lead || r.owner_id === uid;

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Experiments</h2>
          {me?.is_contributor && <Button size="sm" onClick={() => setForm({ kind: 'exp' })}>New experiment</Button>}</div>
        {exps.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : !exps.data?.length ? (
          <p className="text-sm text-muted-foreground">No experiments yet. Create one against a mission to test its hypothesis.</p>
        ) : exps.data.map((r) => (
          <Card key={r.id} className="space-y-1.5 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={r.decision === 'running' ? 'secondary' : 'outline'}>{labelize(r.decision) || 'No decision'}</Badge>
              <span className="text-xs text-muted-foreground">{titles.get(r.mission_id) ?? 'Mission'}</span>
            </div>
            <p className="text-sm font-medium text-foreground">{r.hypothesis}</p>
            <p className="text-xs text-muted-foreground">
              Cohort: {r.cohort || '—'} · {fmtDate(r.start_on)} – {fmtDate(r.end_on)} · {r.metric_name || 'Metric'}: {r.baseline ?? '—'} → {r.observed ?? '—'} · {name(r.owner_id)}
            </p>
            {canEditExp(r) && <Button size="sm" variant="outline" onClick={() => setForm({ kind: 'exp', row: r })}>Edit</Button>}
          </Card>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="text-base font-semibold">Model versions</h2>
          {me?.is_contributor && <Button size="sm" onClick={() => setForm({ kind: 'mv' })}>New model version</Button>}</div>
        {models.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : !models.data?.length ? (
          <p className="text-sm text-muted-foreground">No model versions yet. Register each model that makes a decision, starting in shadow.</p>
        ) : models.data.map((r) => (
          <Card key={r.id} className={`space-y-1.5 p-3 ${r.status === 'production' ? 'border-primary/60 bg-primary/5' : ''}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-foreground">{r.name} <span className="text-muted-foreground">v{r.version}</span></span>
              <Badge variant={r.status === 'production' ? 'default' : 'outline'}>{labelize(r.status)}</Badge>
              <Badge variant="secondary">{labelize(r.decides)}</Badge>
              {r.status !== 'retired' && driftOverdue(r.last_drift_check_on) && <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-700">Drift check overdue</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {name(r.owner_id)} · Source: {r.source_job || '—'} · Last drift check: {fmtDate(r.last_drift_check_on) || 'never'}
            </p>
            <p className="text-xs text-muted-foreground">Rollback: {r.rollback_path || '—'}</p>
            {me?.is_contributor && <Button size="sm" variant="outline" onClick={() => setForm({ kind: 'mv', row: r })}>Edit</Button>}
          </Card>
        ))}
      </div>

      {form && (
        <RowForm
          key={form.row?.id ?? form.kind}
          open
          title={`${form.row ? 'Edit' : 'New'} ${form.kind === 'exp' ? 'experiment' : 'model version'}`}
          fields={form.kind === 'exp' ? expFields : mvFields}
          initial={form.row ?? (form.kind === 'exp' ? { decision: 'running' } : { status: 'shadow', owner_id: uid })}
          saving={save.isPending}
          onClose={() => setForm(null)}
          onSave={(v) => save.mutate({ kind: form.kind, row: form.row, v }, { onSuccess: () => setForm(null) })}
        />
      )}
    </section>
  );
}

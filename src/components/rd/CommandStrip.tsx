import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { db, STAGES, STAGE_LABEL, useCurrentUserId, useDecisions, useMissions, useOpenP0, useRdMe, useRdMutation, useSettings } from './useRd';

type Tone = 'neutral' | 'watch' | 'break';
const toneCls: Record<Tone, string> = {
  neutral: 'border-border bg-muted/40',
  watch: 'border-amber-500/50 bg-amber-500/10',
  break: 'border-destructive/60 bg-destructive/10',
};

function Tile({ title, tone, children }: { title: string; tone: Tone; children: React.ReactNode }) {
  return (
    <Card className={cn('min-w-[160px] flex-1 p-3', toneCls[tone])}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </Card>
  );
}

const PLACEHOLDER = 'What must be true by Friday for R&D to have moved a real constraint?';

export function CommandStrip() {
  const { data: missions = [] } = useMissions();
  const { data: settings } = useSettings();
  const { data: decisions = [] } = useDecisions();
  const { data: p0 } = useOpenP0();
  const { data: me } = useRdMe();
  const { data: uid } = useCurrentUserId();
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');

  const saveQ = useRdMutation(async (text: string) =>
    db.from('rd_settings').update({ weekly_question: text, updated_by: uid }).eq('id', settings?.id ?? true), 'Question saved');

  const live = missions.filter((m) => m.stage !== 'kill');
  const h = { now: 0, next: 0, later: 0 } as Record<string, number>;
  live.forEach((m) => (h[m.horizon] = (h[m.horizon] ?? 0) + 1));
  const cap = settings?.now_cap;
  const stageCount: Record<string, number> = {};
  STAGES.forEach((s) => (stageCount[s] = missions.filter((m) => m.stage === s).length));

  const since = Date.now() - 30 * 86400_000;
  const recent = decisions.filter((d: any) => new Date(d.decided_at).getTime() >= since);
  const killed = recent.filter((d: any) => d.decision === 'kill').length;
  const shipped = recent.filter((d: any) => d.decision === 'ship').length;

  const signals = p0?.signals ?? [];
  const staleP0 = signals.some((s: any) => Date.now() - new Date(s.created_at).getTime() > 48 * 3600_000);
  const single = live.filter((m) => m.horizon === 'now' && !m.deputy_id).length;
  const risks = p0?.risks.length ?? 0;
  const wq = (settings?.weekly_question ?? '').trim();

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      <Tile title="Active missions" tone={cap != null && h.now > cap ? 'break' : 'neutral'}>
        <span className="font-semibold">{h.now}</span> now · {h.next} next · {h.later} later
        {cap != null && <span className="block text-xs text-muted-foreground">Cap {cap}</span>}
      </Tile>
      <Tile title="Pipeline shape" tone={stageCount.prove === 0 && stageCount.build >= 3 ? 'break' : 'neutral'}>
        <span className="text-xs">{STAGES.map((s) => `${STAGE_LABEL[s]} ${stageCount[s]}`).join(' · ')}</span>
      </Tile>
      <Tile title="Killed vs shipped (30d)" tone={killed === 0 && shipped === 0 ? 'break' : 'neutral'}>
        <span className="font-semibold">{killed}</span> killed · <span className="font-semibold">{shipped}</span> shipped
      </Tile>
      <Tile title="Open P0 signals" tone={staleP0 ? 'break' : signals.length > 0 ? 'watch' : 'neutral'}>
        <span className="font-semibold">{signals.length}</span>
      </Tile>
      <Tile title="Single-thread risk" tone={single > 0 ? 'break' : 'neutral'}>
        <span className="font-semibold">{single}</span> now missions without deputy
      </Tile>
      <Tile title="Open P0 risk" tone={risks > 0 ? 'break' : 'neutral'}>
        <span className="font-semibold">{risks}</span>
      </Tile>
      <Tile title="This week's question" tone={wq ? 'neutral' : 'break'}>
        {editing ? (
          <div className="space-y-2">
            <Textarea value={q} onChange={(e) => setQ(e.target.value)} placeholder={PLACEHOLDER} rows={3} />
            <div className="flex gap-2">
              <Button size="sm" disabled={saveQ.isPending} onClick={() => saveQ.mutate(q, { onSuccess: () => setEditing(false) })}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <div className="min-w-[220px]">
            <p className={cn('text-xs', !wq && 'italic text-muted-foreground')}>{wq || PLACEHOLDER}</p>
            {me?.is_lead && (
              <Button size="sm" variant="link" className="h-auto px-0" onClick={() => { setQ(wq); setEditing(true); }}>Edit</Button>
            )}
          </div>
        )}
      </Tile>
    </div>
  );
}

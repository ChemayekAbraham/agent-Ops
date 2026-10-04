import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Download } from 'lucide-react';
import { ValueChip } from './values';
import { DECISIONS, fmtDateTime, labelize, useDecisions, useMissions, usePeopleMap } from './useRd';

const csvCell = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function DecisionLog() {
  const { data: decisions = [], isLoading } = useDecisions();
  const { data: missions = [] } = useMissions();
  const name = usePeopleMap();
  const [type, setType] = useState('all');
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);
  const vals = useMemo(() => new Map(missions.map((m) => [m.id, m.company_value])), [missions]);
  const rows = decisions.filter((d: any) => type === 'all' || d.decision === type);

  const exportCsv = () => {
    const head = ['Mission', 'Decision', 'Why', 'Belief that was wrong', 'Never again', 'Decided by', 'Date (EAT)'];
    const lines = rows.map((d: any) => [titles.get(d.mission_id) ?? '', d.decision, d.why, d.belief_that_was_wrong, d.never_again, name(d.decided_by), fmtDateTime(d.decided_at)].map(csvCell).join(','));
    const blob = new Blob([[head.map(csvCell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rd-decision-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All decisions</SelectItem>
            {DECISIONS.map((d) => <SelectItem key={d} value={d}>{labelize(d)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={exportCsv} disabled={!rows.length}>
          <Download className="h-4 w-4" />Export CSV
        </Button>
      </div>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
      ) : rows.map((d: any) => (
        <Card key={d.id} className="space-y-1.5 p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">{titles.get(d.mission_id) ?? 'Mission'}</p>
            <div className="flex shrink-0 items-center gap-1">
              <ValueChip value={vals.get(d.mission_id)} />
              <Badge variant="outline" className="uppercase">{d.decision}</Badge>
            </div>
          </div>
          <p className="text-sm"><span className="text-muted-foreground">Why: </span>{d.why}</p>
          {d.belief_that_was_wrong && <p className="text-sm"><span className="text-muted-foreground">Belief that was wrong: </span>{d.belief_that_was_wrong}</p>}
          {d.never_again && <p className="text-sm"><span className="text-muted-foreground">Never again: </span>{d.never_again}</p>}
          <p className="text-xs text-muted-foreground">{name(d.decided_by)} · {fmtDateTime(d.decided_at)}</p>
        </Card>
      ))}
    </section>
  );
}

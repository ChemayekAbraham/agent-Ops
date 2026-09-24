import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db, fmtDateTime, labelize, useMissions, usePeopleMap } from './useRd';

const ENTITIES = ['rd_missions', 'rd_signals', 'rd_experiments', 'rd_model_versions', 'rd_risk_items', 'rd_decisions', 'rd_comments', 'rd_settings'] as const;
const PAGE = 100;

type AuditRow = {
  id: number; actor: string | null; at: string; entity: string; entity_id: string | null;
  op: string; field: string | null; old_value: string | null; new_value: string | null;
};

export function AuditTrail() {
  const [entity, setEntity] = useState('all');
  const [op, setOp] = useState('all');
  const [limit, setLimit] = useState(PAGE);
  const { data: missions = [] } = useMissions();
  const name = usePeopleMap();
  const titles = useMemo(() => new Map(missions.map((m) => [m.id, m.title])), [missions]);

  const { data, isLoading } = useQuery({
    queryKey: ['rd', 'audit', entity, op, limit],
    queryFn: async () => {
      let q = db.from('rd_audit').select('*').order('at', { ascending: false }).limit(limit + 1);
      if (entity !== 'all') q = q.eq('entity', entity);
      if (op !== 'all') q = q.eq('op', op);
      const { data: rows, error } = await q;
      if (error) throw error;
      const list = (rows ?? []) as AuditRow[];
      return { rows: list.slice(0, limit), hasMore: list.length > limit };
    },
  });
  const rows = data?.rows ?? [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={entity} onValueChange={(v) => { setEntity(v); setLimit(PAGE); }}>
          <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All entities</SelectItem>
            {ENTITIES.map((e) => <SelectItem key={e} value={e}>{labelize(e.replace('rd_', ''))}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={op} onValueChange={(v) => { setOp(v); setLimit(PAGE); }}>
          <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All ops</SelectItem>
            {['insert', 'update', 'delete'].map((o) => <SelectItem key={o} value={o}>{labelize(o)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No audit entries visible to you.</p>
      ) : (
        <>
          {rows.map((r) => (
            <Card key={r.id} className="space-y-1.5 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="uppercase">{r.op}</Badge>
                <span className="text-sm font-semibold text-foreground">{labelize(r.entity.replace('rd_', ''))}</span>
                {r.entity === 'rd_missions' && r.entity_id && titles.has(r.entity_id) && (
                  <Link to={`/rd/missions/${r.entity_id}`} className="text-sm text-primary underline underline-offset-2">
                    {titles.get(r.entity_id)}
                  </Link>
                )}
                <span className="ml-auto text-xs text-muted-foreground">{name(r.actor)} · {fmtDateTime(r.at)}</span>
              </div>
              {r.field && (
                <p className="break-words text-sm">
                  <span className="text-muted-foreground">{labelize(r.field)}: </span>
                  <span className="break-words">{r.old_value ?? '—'}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="break-words">{r.new_value ?? '—'}</span>
                </p>
              )}
            </Card>
          ))}
          {data?.hasMore && (
            <Button variant="outline" className="w-full" onClick={() => setLimit((l) => l + PAGE)}>
              Load more
            </Button>
          )}
        </>
      )}
    </section>
  );
}

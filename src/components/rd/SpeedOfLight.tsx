import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { db, DELAY_BUCKETS, labelize, useMissions, useRdMe, useRdMutation } from './useRd';
import { fmtGap, gapTone, median, solRows } from './sol';

const rowTone = { neutral: '', watch: 'bg-amber-500/10', break: 'bg-destructive/10' };

export function SpeedOfLight() {
  const { data: missions = [] } = useMissions();
  const { data: me } = useRdMe();
  const rows = solRows(missions);
  const med = median(rows.map((r) => r.gap));
  const save = useRdMutation(async ({ id, patch }: { id: string; patch: Record<string, any> }) =>
    db.from('rd_missions').update(patch).eq('id', id), 'Saved');

  if (!rows.length) {
    return <Card className="p-6 text-sm text-muted-foreground">No Now missions have started. The lead promotes from Next and sets SoL days.</Card>;
  }

  return (
    <Card className="p-0">
      <div className="border-b border-border px-3 py-2 text-sm">
        Median gap: <span className="font-semibold">{fmtGap(med)}</span> across {rows.length} mission{rows.length === 1 ? '' : 's'}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">SoL days</th>
              <th className="px-3 py-2">Actual days</th>
              <th className="px-3 py-2">Gap</th>
              <th className="px-3 py-2">Delay bucket</th>
              <th className="px-3 py-2">Delay note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, sol, actual, gap }) => (
              <tr key={m.id} className={cn('border-t border-border align-top', rowTone[gapTone(gap)])}>
                <td className="px-3 py-2"><Link to={`/rd/missions/${m.id}`} className="font-medium text-primary underline-offset-2 hover:underline">{m.title}</Link></td>
                <td className="px-3 py-2">
                  {me?.is_lead ? (
                    <Input
                      key={`${m.id}-${m.sol_days}`}
                      type="number"
                      min={1}
                      defaultValue={sol}
                      className="h-8 w-20"
                      onBlur={(e) => {
                        const v = e.target.value === '' ? null : Number(e.target.value);
                        if (v !== sol) save.mutate({ id: m.id, patch: { sol_days: v } });
                      }}
                    />
                  ) : sol}
                </td>
                <td className="px-3 py-2">{actual}</td>
                <td className="px-3 py-2 font-semibold">{fmtGap(gap)}</td>
                <td className="px-3 py-2">
                  {me?.is_lead ? (
                    <Select value={m.delay_bucket ?? undefined} onValueChange={(v) => save.mutate({ id: m.id, patch: { delay_bucket: v } })}>
                      <SelectTrigger className="h-8 w-40"><SelectValue placeholder="Choose" /></SelectTrigger>
                      <SelectContent>{DELAY_BUCKETS.map((b) => <SelectItem key={b} value={b}>{labelize(b)}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : labelize(m.delay_bucket) || '—'}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{m.delay_note || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

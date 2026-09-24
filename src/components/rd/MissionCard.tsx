import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { fmtDate, labelize, Mission } from './useRd';
import { fmtGap, gapTone, solGap } from './sol';

export function MissionCard({ m, ownerName }: { m: Mission; ownerName: string }) {
  const navigate = useNavigate();
  const sol = solGap(m);
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/rd/missions/${m.id}`)}
      onKeyDown={(e) => e.key === 'Enter' && navigate(`/rd/missions/${m.id}`)}
      className="cursor-pointer space-y-2 p-3 active:bg-muted"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-snug text-foreground">{m.title}</p>
        <Badge variant="outline" className="shrink-0 text-[10px] uppercase">{m.horizon}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{ownerName}</p>
      {!!m.domains?.length && (
        <div className="flex flex-wrap gap-1">
          {m.domains.map((d) => (
            <Badge key={d} variant="secondary" className="text-[10px]">{labelize(d)}</Badge>
          ))}
        </div>
      )}
      {sol && sol.gap > 1.5 && (
        <Badge variant={gapTone(sol.gap) === 'break' ? 'destructive' : 'outline'} className={gapTone(sol.gap) === 'watch' ? 'border-amber-500/50 bg-amber-500/10 text-[10px]' : 'text-[10px]'}>SoL gap {fmtGap(sol.gap)}</Badge>
      )}
      <p className="text-[11px] text-muted-foreground">Next gate: {fmtDate(m.next_gate_on)}</p>
    </Card>
  );
}

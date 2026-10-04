import { Card } from '@/components/ui/card';
import { Rocket } from 'lucide-react';
import type { PlannedMarket } from './plannedMarkets';

const STATUS_COLOR: Record<PlannedMarket['status'], string> = {
  'Scouting':            'bg-muted text-muted-foreground',
  'Onboarding partners': 'bg-amber-500/15 text-amber-700',
  'Pilot':               'bg-sky-500/15 text-sky-700',
  'Launching soon':      'bg-success/15 text-success',
};

export function PlannedMarketTile({ market }: { market: PlannedMarket }) {
  return (
    <Card className="p-3 h-full border-dashed bg-muted/20 opacity-90 hover:opacity-100 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-lg leading-none">{market.flag}</span>
          <p className="font-semibold text-sm truncate">{market.country}</p>
        </div>
        <Rocket className="h-4 w-4 text-muted-foreground shrink-0" />
      </div>
      <span className={`mt-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_COLOR[market.status]}`}>
        {market.status}
      </span>
      <p className="mt-1 text-[10px] text-muted-foreground">ETA · {market.eta}</p>
      {market.notes && <p className="mt-1 text-[10px] text-muted-foreground italic truncate">{market.notes}</p>}
    </Card>
  );
}
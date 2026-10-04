import { Card } from '@/components/ui/card';
import { Loader2, MapPin, User, Building2, ChevronRight } from 'lucide-react';
import type { BreakdownRow } from '@/hooks/useLocationBreakdown';
import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  rows: BreakdownRow[];
  level: string;
  loading: boolean;
  onPick: (row: BreakdownRow) => void;
}

const ICON: Record<string, any> = {
  country: MapPin, region: MapPin, district: MapPin, ward: MapPin,
  agent: User, landlord: Building2,
};

export function LocationTileGrid({ rows, level, loading, onPick }: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-[110px] animate-pulse bg-muted/30" />
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <Card className="py-10 text-center text-sm text-muted-foreground">
        No {level === 'country' ? 'countries' : `${level}s`} yet at this level.
      </Card>
    );
  }
  const Icon = ICON[level] ?? MapPin;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
      {rows.map(r => {
        const occPct = r.total ? Math.round((r.occupied / r.total) * 100) : 0;
        return (
          <button
            key={r.key}
            onClick={() => onPick(r)}
            className="group text-left"
          >
            <Card className="p-3 h-full hover:border-primary hover:shadow-md transition active:scale-[0.98]">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className="h-4 w-4 text-primary shrink-0" />
                  <p className="font-semibold text-sm truncate">{r.label}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary shrink-0" />
              </div>
              <p className="mt-1 text-xl font-bold">{r.total.toLocaleString()}</p>
              <p className="text-[10px] text-muted-foreground">houses</p>
              <div className="mt-1.5 flex items-center gap-1 text-[10px]">
                <span className="px-1.5 py-0.5 rounded bg-success/15 text-success font-medium">{r.occupied} occ</span>
                <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 font-medium">{r.vacant} vac</span>
                {r.hidden > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{r.hidden} hidden</span>
                )}
              </div>
              <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{occPct}% occupancy</span>
                {r.revenue_ugx > 0 && <span className="font-medium">{formatUGX(r.revenue_ugx)}</span>}
              </div>
            </Card>
          </button>
        );
      })}
    </div>
  );
}
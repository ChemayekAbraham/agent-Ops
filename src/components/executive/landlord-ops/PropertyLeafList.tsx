import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Home, EyeOff, Info } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { usePropertiesAtLeaf, type BreadcrumbPath } from '@/hooks/useLocationBreakdown';
import { HouseDetailsDialog } from './HouseDetailsDialog';

export function PropertyLeafList({ path }: { path: BreadcrumbPath }) {
  const { data, isLoading } = usePropertiesAtLeaf(path);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!data || data.length === 0) {
    return <Card className="py-10 text-center text-sm text-muted-foreground">No properties here yet.</Card>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{data.length} propert{data.length === 1 ? 'y' : 'ies'}</p>
      {data.map(h => (
        <Card
          key={h.id}
          className="p-3 cursor-pointer hover:border-primary hover:shadow-md transition"
          onClick={() => setDetailsId(h.id)}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-sm flex items-center gap-1.5">
                <Home className="h-4 w-4 text-primary shrink-0" />
                <span className="truncate">{h.title}</span>
                {h.is_hidden && <EyeOff className="h-3 w-3 text-muted-foreground shrink-0" />}
              </p>
              <p className="text-[11px] text-muted-foreground truncate">{h.address}</p>
              <div className="mt-1 flex items-center gap-2 text-[11px]">
                <span className="font-medium">{formatUGX(h.monthly_rent)}/mo</span>
                <span className="text-muted-foreground">· {formatUGX(h.daily_rate)}/day</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <Badge variant={h.tenant_id ? 'default' : 'secondary'} className="text-[10px]">
                {h.tenant_id ? 'Occupied' : 'Vacant'}
              </Badge>
              <span className="text-[10px] text-primary flex items-center gap-0.5">
                <Info className="h-3 w-3" /> Tap for details
              </span>
            </div>
          </div>
        </Card>
      ))}
      <HouseDetailsDialog
        houseId={detailsId}
        onOpenChange={(o) => !o && setDetailsId(null)}
      />
    </div>
  );
}
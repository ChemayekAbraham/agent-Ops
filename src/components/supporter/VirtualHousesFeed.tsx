import { useState, useMemo } from 'react';
import { VirtualHouseCard, VirtualHouse } from './VirtualHouseCard';
import { Badge } from '@/components/ui/badge';
import { Home } from 'lucide-react';


interface VirtualHousesFeedProps {
  houses: VirtualHouse[];
  loading?: boolean;
  onHouseTap?: (id: string) => void;
}

type HealthFilter = 'all' | 'green' | 'amber' | 'red';

export function VirtualHousesFeed({ houses, loading, onHouseTap }: VirtualHousesFeedProps) {
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('all');

  const filtered = useMemo(() => {
    if (healthFilter === 'all') return houses;
    return houses.filter(h => h.paymentHealth === healthFilter);
  }, [houses, healthFilter]);

  const filters: { value: HealthFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'green', label: '🟢 Good' },
    { value: 'amber', label: '🟡 Pending' },
    { value: 'red', label: '🔴 Risk' },
  ];

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-28 rounded-2xl bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">🏘️</span>
          <h3 className="font-bold text-foreground text-sm">My Houses</h3>
        </div>
        <Badge variant="secondary" className="text-[10px] px-2 py-0.5">
          {filtered.length} {filtered.length === 1 ? 'house' : 'houses'}
        </Badge>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 scrollbar-hide">
        {filters.map(f => (
          <button
            key={f.value}
            onClick={() => setHealthFilter(f.value)}
            className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors touch-manipulation active:scale-95 ${
              healthFilter === f.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Houses list */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 space-y-3 animate-fade-in">
          <div className="p-4 rounded-full bg-muted/50 w-fit mx-auto">
            <Home className="h-8 w-8 text-muted-foreground/50" />
          </div>
          <div>
            <p className="font-bold text-foreground text-sm">No Houses Yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {healthFilter !== 'all' 
                ? 'No houses match this filter.' 
                : 'Fund a rent opportunity to add your first virtual house.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((house, i) => (
            <VirtualHouseCard
              key={house.id}
              house={house}
              onTap={onHouseTap}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

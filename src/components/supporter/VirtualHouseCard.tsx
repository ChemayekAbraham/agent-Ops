import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow } from 'date-fns';

export interface VirtualHouse {
  id: string;
  shortId: string;
  area: string;
  city: string;
  rentAmount: number;
  paymentHealth: 'green' | 'amber' | 'red';
  agentManaged: boolean;
  updatedAt: string;
  status: string;
  durationDays: number;
}

interface VirtualHouseCardProps {
  house: VirtualHouse;
  onTap?: (id: string) => void;
  index?: number;
}

const healthConfig = {
  green: { label: '✅ Good', dotClass: 'house-health-dot-green', badgeClass: 'house-health-badge-green' },
  amber: { label: '⏳ Pending', dotClass: 'house-health-dot-amber', badgeClass: 'house-health-badge-amber' },
  red: { label: '⚠️ At Risk', dotClass: 'house-health-dot-red', badgeClass: 'house-health-badge-red' },
};

export function VirtualHouseCard({ house, onTap }: VirtualHouseCardProps) {
  const health = healthConfig[house.paymentHealth];

  return (
    <div
      className="house-card rounded-2xl border-2 border-border/60 bg-card p-4 xs:p-5 cursor-pointer active:scale-[0.97] transition-transform touch-manipulation"
      onClick={() => onTap?.(house.id)}
    >
      {/* Top row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xl">🏠</span>
          <span className="font-black text-sm text-foreground">House #{house.shortId}</span>
        </div>
        <span className={`text-[11px] px-2.5 py-1 rounded-full font-bold border ${health.badgeClass}`}>
          {health.label}
        </span>
      </div>

      {/* Location */}
      <p className="text-xs text-muted-foreground font-medium mb-2">
        📍 {house.area}, {house.city}
      </p>

      {/* Rent + Meta */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Rent</p>
          <p className="text-lg font-black text-foreground">{formatUGX(house.rentAmount)}</p>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-muted-foreground">
          {house.agentManaged && (
            <span className="font-medium">🛡️ Agent Managed</span>
          )}
          <span>🕐 {formatDistanceToNow(new Date(house.updatedAt), { addSuffix: true })}</span>
        </div>
      </div>
    </div>
  );
}

import { Users, Wifi, UserCheck, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';

export type StatFilter = 'all' | 'online' | 'verified' | 'inactive';

interface CompactUserStatsProps {
  totalUsers: number;
  onlineCount: number;
  verifiedCount: number;
  inactiveCount: number;
  activeFilter?: StatFilter;
  onFilterChange?: (filter: StatFilter) => void;
}

export function CompactUserStats({ 
  totalUsers, 
  onlineCount, 
  verifiedCount,
  inactiveCount,
  activeFilter = 'all',
  onFilterChange
}: CompactUserStatsProps) {
  const stats: { 
    id: StatFilter;
    icon: typeof Users;
    value: number;
    label: string;
    color: string;
    bg: string;
    activeBg: string;
  }[] = [
    { 
      id: 'all',
      icon: Users, 
      value: totalUsers, 
      label: 'Total',
      color: 'text-[#8696a0]',
      bg: 'bg-[#2a3942]',
      activeBg: 'bg-[#00a884] text-white'
    },
    { 
      id: 'online',
      icon: Wifi, 
      value: onlineCount, 
      label: 'Online',
      color: 'text-[#00a884]',
      bg: 'bg-[#00a884]/15',
      activeBg: 'bg-[#00a884] text-white'
    },
    { 
      id: 'verified',
      icon: UserCheck, 
      value: verifiedCount, 
      label: 'Verified',
      color: 'text-[#53bdeb]',
      bg: 'bg-[#53bdeb]/15',
      activeBg: 'bg-[#53bdeb] text-white'
    },
    { 
      id: 'inactive',
      icon: Clock, 
      value: inactiveCount, 
      label: 'Inactive',
      color: 'text-[#e67e22]',
      bg: 'bg-[#e67e22]/15',
      activeBg: 'bg-[#e67e22] text-white'
    },
  ];

  const handleStatClick = (statId: StatFilter) => {
    hapticTap();
    onFilterChange?.(statId);
  };

  return (
    <div className="flex gap-1.5 px-2 py-1.5 overflow-x-auto scrollbar-hide">
      {stats.map((stat) => {
        const isActive = activeFilter === stat.id;
        return (
          <button
            key={stat.id}
            onClick={() => handleStatClick(stat.id)}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-lg shrink-0 transition-all active:scale-95 touch-manipulation",
              isActive ? stat.activeBg : stat.bg
            )}
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <stat.icon className={cn("h-3 w-3", isActive ? 'text-current' : stat.color)} />
            <span className={cn("text-[11px] font-bold tabular-nums", isActive ? 'text-current' : stat.color)}>
              {stat.value}
            </span>
            <span className={cn("text-[9px] font-medium", isActive ? 'text-current/80' : 'text-[#8696a0]')}>
              {stat.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

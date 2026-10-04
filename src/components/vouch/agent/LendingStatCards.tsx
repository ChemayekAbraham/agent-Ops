import { Wallet, AlertTriangle, Clock, TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { LendingStats } from './lendingHelpers';

interface Props {
  stats: LendingStats;
  onJump: (filter: 'overdue' | 'due_today') => void;
}

export default function LendingStatCards({ stats, onJump }: Props) {
  return (
    <div className="grid grid-cols-2 gap-2.5 mb-4">
      {/* Outstanding — hero */}
      <div className="col-span-2 rounded-2xl bg-gradient-to-br from-emerald-500/15 to-primary/10 border border-emerald-500/25 p-4">
        <div className="flex items-center gap-1.5 mb-1">
          <Wallet className="h-3.5 w-3.5 text-emerald-600" />
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">Total Outstanding</p>
        </div>
        <p className="text-3xl font-bold text-emerald-600 leading-none">{formatUGX(stats.totalOutstanding)}</p>
        <p className="text-[11px] text-muted-foreground mt-1.5">
          {stats.activeCount} active · {formatUGX(stats.totalDisbursed)} disbursed all-time
        </p>
      </div>

      <button
        onClick={() => onJump('overdue')}
        className="rounded-2xl bg-card border border-border/60 p-3 text-left active:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-1.5 mb-1">
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Overdue</p>
        </div>
        <p className="text-2xl font-bold text-destructive leading-none">{stats.overdueCount}</p>
      </button>

      <button
        onClick={() => onJump('due_today')}
        className="rounded-2xl bg-card border border-border/60 p-3 text-left active:bg-muted/40 transition-colors"
      >
        <div className="flex items-center gap-1.5 mb-1">
          <Clock className="h-3.5 w-3.5 text-amber-600" />
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Due today</p>
        </div>
        <p className="text-2xl font-bold text-amber-600 leading-none">{stats.dueTodayCount}</p>
      </button>

      <div className="rounded-2xl bg-card border border-border/60 p-3">
        <div className="flex items-center gap-1.5 mb-1">
          <TrendingUp className="h-3.5 w-3.5 text-emerald-600" />
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Repaid</p>
        </div>
        <p className="text-2xl font-bold text-foreground leading-none">{stats.repaidCount}</p>
      </div>

      <div className="rounded-2xl bg-card border border-border/60 p-3">
        <div className="flex items-center gap-1.5 mb-1">
          <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-bold">Default rate</p>
        </div>
        <p className="text-2xl font-bold text-foreground leading-none">{stats.defaultRatePct}%</p>
      </div>
    </div>
  );
}

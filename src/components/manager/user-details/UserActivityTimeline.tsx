import { useState, useEffect, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  LogIn, LogOut, UserCog, Shield, CheckCircle, XCircle,
  Wallet, ArrowUpRight, ArrowDownLeft, ShoppingCart, Home,
  CreditCard, PiggyBank, Pencil, Clock, Filter, ChevronDown,
  Activity, Calendar, TrendingUp
} from 'lucide-react';
import { formatDistanceToNow, format, isToday, isYesterday, isThisWeek, isThisMonth } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  amount?: number;
  created_at: string;
  metadata?: Record<string, unknown>;
  performed_by?: string;
}

interface UserActivityTimelineProps {
  userId: string;
  userName: string;
}

const ACTIVITY_FILTERS = [
  { value: 'all', label: 'All Activity' },
  { value: 'logins', label: 'Logins' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'actions', label: 'Key Actions' },
];

export default function UserActivityTimeline({ userId, userName }: UserActivityTimelineProps) {
  // Activity timeline DB calls stubbed out to reduce database load
  // All activity data sources (user_activity_log, wallet_transactions, wallet_deposits, 
  // rent_requests, product_orders) are no longer queried
  const activities: ActivityItem[] = [];
  const loading = false;
  const [filter, setFilter] = useState('all');
  const [limit, setLimit] = useState(30);

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'login': return <LogIn className="h-4 w-4" />;
      case 'logout': return <LogOut className="h-4 w-4" />;
      case 'transaction_sent': return <ArrowUpRight className="h-4 w-4" />;
      case 'transaction_received': return <ArrowDownLeft className="h-4 w-4" />;
      case 'deposit': return <Wallet className="h-4 w-4" />;
      case 'rent_request': return <Home className="h-4 w-4" />;
      case 'order': return <ShoppingCart className="h-4 w-4" />;
      default: return <Activity className="h-4 w-4" />;
    }
  };

  const getActivityColor = (type: string) => {
    switch (type) {
      case 'login': return 'bg-blue-500/20 text-blue-600 border-blue-500/30';
      case 'transaction_sent': return 'bg-red-500/20 text-red-600 border-red-500/30';
      case 'transaction_received': return 'bg-green-500/20 text-green-600 border-green-500/30';
      case 'deposit': return 'bg-emerald-500/20 text-emerald-600 border-emerald-500/30';
      case 'rent_request': return 'bg-indigo-500/20 text-indigo-600 border-indigo-500/30';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  };

  return (
    <div className="space-y-4">
      {/* Stats Cards - Stubbed */}
      <div className="grid grid-cols-3 gap-2">
        <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20">
          <div className="flex items-center gap-2 mb-1">
            <LogIn className="h-4 w-4 text-blue-500" />
            <span className="text-xs text-muted-foreground">Logins</span>
          </div>
          <p className="font-bold text-lg">—</p>
        </div>
        <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <div className="flex items-center gap-2 mb-1">
            <Wallet className="h-4 w-4 text-emerald-500" />
            <span className="text-xs text-muted-foreground">Transactions</span>
          </div>
          <p className="font-bold text-lg">—</p>
        </div>
        <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-xs text-muted-foreground">Last Seen</span>
          </div>
          <p className="font-bold text-sm truncate">—</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center justify-between">
        <h4 className="font-semibold text-sm flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Activity Timeline
        </h4>
      </div>

      {/* Empty State */}
      <ScrollArea className="h-[400px]">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Activity className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-medium">Activity tracking paused</p>
          <p className="text-sm text-muted-foreground">
            Activity data is currently optimized for performance
          </p>
        </div>
      </ScrollArea>
    </div>
  );
}

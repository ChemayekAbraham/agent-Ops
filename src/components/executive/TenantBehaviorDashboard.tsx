import { useState, useCallback } from 'react';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { KPICard } from './KPICard';
import {
  Search, AlertTriangle, ShieldAlert, Heart, TrendingUp,
  Clock, Users, ChevronRight, ChevronLeft, RefreshCw,
  AlertCircle, CheckCircle2, XCircle
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

type Segment = 'all' | 'critical' | 'warning' | 'healthy' | 'first_default' | 'recovering' | 'overdue';

interface TenantBehavior {
  tenant_id: string;
  full_name: string;
  phone: string;
  total_requests: number;
  total_rent_amount: number;
  total_repaid: number;
  repayment_pct: number;
  active_requests: number;
  fully_repaid_count: number;
  defaulted_count: number;
  missed_payments: number;
  on_time_payments: number;
  health_score: number;
  risk_level: string;
  current_overdue_amount: number;
  last_payment_date: string | null;
  first_request_date: string | null;
}

const SEGMENTS: { key: Segment; label: string; icon: React.ElementType; color: string }[] = [
  { key: 'all', label: 'All', icon: Users, color: 'bg-muted text-muted-foreground' },
  { key: 'critical', label: 'Critical', icon: ShieldAlert, color: 'bg-destructive/10 text-destructive' },
  { key: 'warning', label: 'Warning', icon: AlertTriangle, color: 'bg-amber-500/10 text-amber-600' },
  { key: 'overdue', label: 'Overdue', icon: Clock, color: 'bg-orange-500/10 text-orange-600' },
  { key: 'first_default', label: '1st Default', icon: AlertCircle, color: 'bg-red-400/10 text-red-500' },
  { key: 'recovering', label: 'Recovering', icon: TrendingUp, color: 'bg-blue-500/10 text-blue-600' },
  { key: 'healthy', label: 'Healthy', icon: Heart, color: 'bg-emerald-500/10 text-emerald-600' },
];

const PAGE_SIZE = 20;

export function TenantBehaviorDashboard() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [segment, setSegment] = useState<Segment>('all');
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Debounce search
  const handleSearch = useCallback((val: string) => {
    setSearch(val);
    setPage(0);
    const t = setTimeout(() => setDebouncedSearch(val), 400);
    return () => clearTimeout(t);
  }, []);

  // Segment KPIs
  const { data: segments, isLoading: segLoading } = useQuery({
    queryKey: ['tenant-behavior-segments'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_tenant_behavior_segments');
      if (error) throw error;
      return data?.[0] || data;
    },
    staleTime: 300000,
  });

  // Tenant list
  const { data: tenants, isLoading, refetch } = useQuery({
    queryKey: ['tenant-behavior', debouncedSearch, segment, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('search_tenant_behavior', {
        p_search: debouncedSearch || null,
        p_segment: segment,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return (data || []) as TenantBehavior[];
    },
    staleTime: 60000,
  });

  const seg = segments as any;

  const getRiskBadge = (level: string) => {
    switch (level) {
      case 'critical': return <Badge className="bg-destructive/15 text-destructive border-destructive/30 text-[10px]">Critical</Badge>;
      case 'warning': return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[10px]">Warning</Badge>;
      default: return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px]">Healthy</Badge>;
    }
  };

  const getHealthColor = (score: number) => {
    if (score >= 70) return 'text-emerald-600';
    if (score >= 40) return 'text-amber-600';
    return 'text-destructive';
  };

  const getProgressColor = (score: number) => {
    if (score >= 70) return '[&>div]:bg-emerald-500';
    if (score >= 40) return '[&>div]:bg-amber-500';
    return '[&>div]:bg-destructive';
  };

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Search Bar */}
      <Card className="border shadow-sm">
        <CardContent className="p-3 sm:p-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search tenant by name or phone..."
                value={search}
                onChange={(e) => handleSearch(e.target.value)}
                className="pl-9 h-10"
              />
            </div>
            <Button variant="outline" size="icon" onClick={() => refetch()} className="shrink-0">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Segment KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <KPICard title="Total Tenants" value={seg?.total_with_requests || 0} icon={Users} loading={segLoading} color="bg-primary/10 text-primary" />
        <KPICard title="Critical" value={seg?.critical_count || 0} icon={ShieldAlert} loading={segLoading} color="bg-destructive/10 text-destructive" />
        <KPICard title="Warning" value={seg?.warning_count || 0} icon={AlertTriangle} loading={segLoading} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Total Overdue" value={formatUGX(seg?.total_overdue_amount || 0)} icon={Clock} loading={segLoading} color="bg-orange-500/10 text-orange-600" />
      </div>

      {/* Segment Pills */}
      <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
        {SEGMENTS.map(s => (
          <button
            key={s.key}
            onClick={() => { setSegment(s.key); setPage(0); }}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
              segment === s.key ? s.color + ' ring-1 ring-current' : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            }`}
          >
            <s.icon className="h-3 w-3" />
            {s.label}
            {seg && s.key !== 'all' && (
              <span className="ml-0.5 opacity-70">
                ({s.key === 'critical' ? seg.critical_count :
                  s.key === 'warning' ? seg.warning_count :
                  s.key === 'healthy' ? seg.healthy_count :
                  s.key === 'first_default' ? seg.first_default_count :
                  s.key === 'recovering' ? seg.recovering_count :
                  seg.overdue_count})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Results */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 px-3 sm:px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            Tenant Repayment Behavior
            {isLoading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 sm:px-4 pb-2">
          <TenantOpsReportToolbar
            tool="tenant_behavior"
            status={segment}
            search={debouncedSearch}
            visibleCount={tenants?.length ?? 0}
            fileSlug="tenant-payment-behaviour"
          />
        </CardContent>
        <CardContent className="px-0 pb-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary/20 border-t-primary" />
            </div>
          ) : !tenants?.length ? (
            <div className="text-center py-12 text-muted-foreground">
              <Search className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No tenants found. Try a different search or segment.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {tenants.map((t) => {
                const isExpanded = expandedId === t.tenant_id;
                const totalPayments = t.on_time_payments + t.missed_payments;

                return (
                  <div key={t.tenant_id}>
                    {/* Row */}
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : t.tenant_id)}
                      className={`w-full px-3 sm:px-4 py-3 text-left hover:bg-muted/50 transition-colors flex items-center gap-3 ${isExpanded ? 'bg-muted/30' : ''}`}
                    >
                      {/* Health Score Circle */}
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                        t.risk_level === 'critical' ? 'bg-destructive/15 text-destructive' :
                        t.risk_level === 'warning' ? 'bg-amber-500/15 text-amber-600' :
                        'bg-emerald-500/15 text-emerald-600'
                      }`}>
                        {Math.round(t.health_score)}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium truncate">{t.full_name || 'Unknown'}</p>
                          {getRiskBadge(t.risk_level)}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                          <span>{t.total_requests} req{t.total_requests !== 1 ? 's' : ''}</span>
                          <span>•</span>
                          <span>{t.repayment_pct}% repaid</span>
                          {t.current_overdue_amount > 0 && (
                            <>
                              <span>•</span>
                              <span className="text-destructive font-medium">
                                {formatUGX(t.current_overdue_amount)} overdue
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${isExpanded ? 'rotate-90' : ''}`} />
                    </button>

                    {/* Expanded Card */}
                    {isExpanded && (
                      <div className="px-3 sm:px-4 py-3 bg-muted/20 space-y-3 border-t border-border/50">
                        {/* Health Bar */}
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Health Score</span>
                            <span className={`text-sm font-bold ${getHealthColor(t.health_score)}`}>{Math.round(t.health_score)}/100</span>
                          </div>
                          <Progress value={t.health_score} className={`h-2 ${getProgressColor(t.health_score)}`} />
                        </div>

                        {/* Stats Grid */}
                        <div className="grid grid-cols-3 gap-2">
                          <div className="bg-background rounded-lg p-2 text-center">
                            <p className="text-lg font-bold">{t.total_requests}</p>
                            <p className="text-[9px] text-muted-foreground">Requests</p>
                          </div>
                          <div className="bg-background rounded-lg p-2 text-center">
                            <p className="text-lg font-bold text-emerald-600">{t.fully_repaid_count}</p>
                            <p className="text-[9px] text-muted-foreground">Completed</p>
                          </div>
                          <div className="bg-background rounded-lg p-2 text-center">
                            <p className="text-lg font-bold text-destructive">{t.defaulted_count}</p>
                            <p className="text-[9px] text-muted-foreground">Defaulted</p>
                          </div>
                        </div>

                        {/* Payment Timeline Dots */}
                        {totalPayments > 0 && (
                          <div>
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Payment History</p>
                            <div className="flex items-center gap-1 flex-wrap">
                              {Array.from({ length: Math.min(totalPayments, 20) }, (_, i) => (
                                <div
                                  key={i}
                                  className={`w-3 h-3 rounded-full ${
                                    i < t.on_time_payments ? 'bg-emerald-500' : 'bg-destructive'
                                  }`}
                                  title={i < t.on_time_payments ? 'On-time' : 'Missed'}
                                />
                              ))}
                              {totalPayments > 20 && (
                                <span className="text-[10px] text-muted-foreground ml-1">+{totalPayments - 20} more</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                {t.on_time_payments} on-time
                              </span>
                              <span className="flex items-center gap-1">
                                <XCircle className="h-3 w-3 text-destructive" />
                                {t.missed_payments} missed
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Financial Summary */}
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <p className="text-muted-foreground text-[10px]">Total Rent</p>
                            <p className="font-mono font-medium">{formatUGX(t.total_rent_amount)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">Total Repaid</p>
                            <p className="font-mono font-medium text-emerald-600">{formatUGX(t.total_repaid)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">Phone</p>
                            <p className="font-mono">{t.phone || '—'}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-[10px]">Last Payment</p>
                            <p>{t.last_payment_date ? format(new Date(t.last_payment_date), 'dd MMM yy') : '—'}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {tenants && tenants.length > 0 && (
            <div className="flex items-center justify-between px-3 sm:px-4 py-2 border-t border-border">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="text-xs"
              >
                <ChevronLeft className="h-3 w-3 mr-1" /> Prev
              </Button>
              <span className="text-xs text-muted-foreground">Page {page + 1}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={tenants.length < PAGE_SIZE}
                className="text-xs"
              >
                Next <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

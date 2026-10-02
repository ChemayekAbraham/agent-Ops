import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity, Users, Clock, Navigation, Smartphone, Globe, RefreshCw,
  Search, ShieldAlert, MousePointerClick, Layers, CheckCircle2,
  ChevronRight, ArrowUpRight, BarChart3, Filter, Download, ExternalLink, MapPin
} from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Cell
} from 'recharts';
import { formatDistanceToNow, parseISO } from 'date-fns';

interface UserBehaviourAnalyticsData {
  kpis?: {
    total_events?: number;
    total_sessions?: number;
    unique_users?: number;
    avg_dwell_sec?: number;
    gps_sessions?: number;
  };
  roles?: Array<{ role: string; sessions: number; events: number }>;
  sections?: Array<{ section: string; views: number; unique_sessions: number; avg_dwell_sec: number }>;
  actions?: Array<{ target: string; section?: string; kind?: string; count: number }>;
  dialogs?: Array<{ dialog_name: string; interactions: number; unique_sessions: number }>;
  devices?: Array<{ device_class: string; sessions: number }>;
  trend?: Array<{ day: string; events: number; sessions: number }>;
  recent_feed?: Array<{
    id: string;
    created_at: string;
    role: string;
    event_type: string;
    section?: string;
    target?: string;
    dialog_name?: string;
    has_gps: boolean;
    latitude?: number;
    longitude?: number;
    ip_address?: string;
    user_name?: string;
    phone?: string;
  }>;
}

const ROLE_COLORS: Record<string, string> = {
  tenant: '#3b82f6',
  supporter: '#10b981',
  agent: '#f59e0b',
  landlord: '#8b5cf6',
  visitor: '#64748b',
};

export function UserBehaviourAnalyticsPanel() {
  const { roles, user } = useAuth();
  const [timeframeDays, setTimeframeDays] = useState<number>(7);
  const [selectedRole, setSelectedRole] = useState<string>('all');
  const [searchFilter, setSearchFilter] = useState('');

  // 1. Role Protection: Only crm, cto, or super_admin
  const isAuthorized = useMemo(() => {
    return (roles || []).some((r) => ['crm', 'cto', 'super_admin'].includes(r));
  }, [roles]);

  // 2. Data Fetching via single RPC (Prevents Round Trips & DRY)
  const {
    data,
    isLoading,
    isRefetching,
    refetch,
    error,
  } = useQuery<UserBehaviourAnalyticsData>({
    queryKey: ['crm-user-behaviour-analytics', timeframeDays, selectedRole],
    queryFn: async () => {
      const { data: res, error: rpcErr } = await supabase.rpc(
        'get_user_behaviour_analytics' as any,
        {
          p_days: timeframeDays,
          p_role: selectedRole === 'all' ? null : selectedRole,
        }
      );

      if (rpcErr) {
        // Fallback gracefully if database migration is pending execution
        console.warn('[UserBehaviourAnalytics] RPC query fallback:', rpcErr.message);
        return {} as UserBehaviourAnalyticsData;
      }

      return (res || {}) as UserBehaviourAnalyticsData;
    },
    enabled: isAuthorized,
    staleTime: 45_000, // Cache for 45s to prevent unnecessary refetches
    refetchOnWindowFocus: false,
  });

  if (!isAuthorized) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center space-y-4">
        <div className="h-14 w-14 rounded-2xl bg-destructive/10 text-destructive flex items-center justify-center mx-auto">
          <ShieldAlert className="h-8 w-8" />
        </div>
        <h2 className="text-xl font-bold tracking-tight">Access Restricted</h2>
        <p className="text-sm text-muted-foreground">
          User Behaviour Telemetry is reserved exclusively for CRM, CTO, and Super Admin team members.
        </p>
      </div>
    );
  }

  const kpis = data?.kpis || {};
  const totalEvents = kpis.total_events || 0;
  const totalSessions = kpis.total_sessions || 0;
  const uniqueUsers = kpis.unique_users || 0;
  const avgDwellSec = kpis.avg_dwell_sec || 0;
  const gpsSessions = kpis.gps_sessions || 0;

  // Filtered live feed
  const recentEvents = (data?.recent_feed || []).filter((item) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      item.target?.toLowerCase().includes(q) ||
      item.section?.toLowerCase().includes(q) ||
      item.role?.toLowerCase().includes(q) ||
      item.dialog_name?.toLowerCase().includes(q) ||
      item.user_name?.toLowerCase().includes(q) ||
      item.ip_address?.toLowerCase().includes(q) ||
      (item.phone && item.phone.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-6 pb-12 animate-fade-in">
      {/* Header with Title and Global Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
                User Behaviour & Journeys
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live Ingestion
                </span>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Real-time tracking of sections, buttons, dialogs, dwell time, and GPS/IP across all dashboards
              </p>
            </div>
          </div>
        </div>

        {/* Global Controls */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Role Filter */}
          <Select value={selectedRole} onValueChange={setSelectedRole}>
            <SelectTrigger className="w-[140px] h-9 text-xs font-medium">
              <SelectValue placeholder="All Dashboards" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Dashboards</SelectItem>
              <SelectItem value="tenant">Tenants</SelectItem>
              <SelectItem value="supporter">Supporters</SelectItem>
              <SelectItem value="agent">Agents</SelectItem>
              <SelectItem value="landlord">Landlords</SelectItem>
            </SelectContent>
          </Select>

          {/* Timeframe Filter */}
          <Select value={String(timeframeDays)} onValueChange={(v) => setTimeframeDays(Number(v))}>
            <SelectTrigger className="w-[125px] h-9 text-xs font-medium">
              <SelectValue placeholder="7 Days" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Today (24h)</SelectItem>
              <SelectItem value="7">Last 7 Days</SelectItem>
              <SelectItem value="30">Last 30 Days</SelectItem>
              <SelectItem value="90">Last 90 Days</SelectItem>
            </SelectContent>
          </Select>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isLoading || isRefetching}
            className="h-9 px-3 text-xs gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* KPI 1: Active Sessions */}
        <Card className="border-border/60 bg-card/60 backdrop-blur-sm shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Active Sessions</span>
              <Smartphone className="h-4 w-4 text-muted-foreground" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              {isLoading ? <Skeleton className="h-8 w-20" /> : totalSessions.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            {totalEvents.toLocaleString()} user interactions tracked
          </CardContent>
        </Card>

        {/* KPI 2: Unique Users */}
        <Card className="border-border/60 bg-card/60 backdrop-blur-sm shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Identified Users</span>
              <Users className="h-4 w-4 text-primary" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight text-primary">
              {isLoading ? <Skeleton className="h-8 w-20" /> : uniqueUsers.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            Distinct profiles verified via auth
          </CardContent>
        </Card>

        {/* KPI 3: Avg Dwell Time */}
        <Card className="border-border/60 bg-card/60 backdrop-blur-sm shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>Avg Section Time</span>
              <Clock className="h-4 w-4 text-amber-500" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight">
              {isLoading ? (
                <Skeleton className="h-8 w-20" />
              ) : avgDwellSec >= 60 ? (
                `${Math.floor(avgDwellSec / 60)}m ${Math.round(avgDwellSec % 60)}s`
              ) : (
                `${avgDwellSec}s`
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            Average dwell per visited section
          </CardContent>
        </Card>

        {/* KPI 4: GPS Captured Sessions */}
        <Card className="border-border/60 bg-card/60 backdrop-blur-sm shadow-sm">
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs font-medium flex items-center justify-between">
              <span>GPS Verified</span>
              <Navigation className="h-4 w-4 text-emerald-500" />
            </CardDescription>
            <CardTitle className="text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">
              {isLoading ? <Skeleton className="h-8 w-20" /> : gpsSessions.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 text-[11px] text-muted-foreground">
            {totalSessions > 0
              ? `${Math.round((gpsSessions / totalSessions) * 100)}% sessions with lat/long`
              : 'Coarse IP fallback active'}
          </CardContent>
        </Card>
      </div>

      {/* Main Grid: Trends & Section Heatmap */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Activity Trend & Sections */}
        <div className="lg:col-span-2 space-y-6">
          {/* Daily Activity Chart */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-2 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">User Activity Trend</CardTitle>
                <CardDescription className="text-xs">
                  Daily interaction frequency and session volume
                </CardDescription>
              </div>
              <Badge variant="outline" className="text-[10px] font-medium">
                {timeframeDays} Day Window
              </Badge>
            </CardHeader>
            <CardContent className="p-4 pt-2">
              <div className="h-60 w-full">
                {isLoading ? (
                  <Skeleton className="h-full w-full rounded-xl" />
                ) : (data?.trend || []).length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data?.trend}>
                      <defs>
                        <linearGradient id="eventColor" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="day" stroke="#888888" fontSize={11} tickLine={false} />
                      <YAxis stroke="#888888" fontSize={11} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'rgba(23, 23, 23, 0.95)',
                          borderColor: '#374151',
                          borderRadius: '8px',
                          fontSize: '12px',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="events"
                        name="Interactions"
                        stroke="#6366f1"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#eventColor)"
                      />
                      <Area
                        type="monotone"
                        dataKey="sessions"
                        name="Sessions"
                        stroke="#10b981"
                        strokeWidth={2}
                        fillOpacity={0}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs gap-2">
                    <BarChart3 className="h-8 w-8 stroke-1 text-muted-foreground/40" />
                    <span>No telemetry data in this timeframe yet. Taps will appear here.</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Most Visited Sections & Dwell Time */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-base font-semibold">Most Visited Sections</CardTitle>
                <CardDescription className="text-xs">
                  Where users spend the most time across dashboards
                </CardDescription>
              </div>
              <Layers className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="divide-y divide-border/40">
                {(data?.sections || []).length > 0 ? (
                  (data?.sections || []).map((sec, idx) => (
                    <div key={sec.section || idx} className="py-2.5 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-5 text-muted-foreground font-mono font-medium text-[11px]">
                          #{idx + 1}
                        </span>
                        <div className="truncate">
                          <p className="font-semibold text-foreground capitalize truncate">
                            {sec.section.replace(/[-_]/g, ' ')}
                          </p>
                          <p className="text-[10px] text-muted-foreground">
                            {sec.unique_sessions} unique sessions
                          </p>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-foreground font-mono">
                          {sec.views.toLocaleString()} views
                        </span>
                        <p className="text-[10px] text-muted-foreground flex items-center justify-end gap-1">
                          <Clock className="h-3 w-3" />
                          avg {sec.avg_dwell_sec}s
                        </p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    Section visit logs will populate here as users navigate dashboards.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
          {/* Live Recent Event Feed - Relocated directly below Most Visited Sections */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-3 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-border/40">
              <div>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  Live Activity Stream
                  <Badge variant="outline" className="text-[10px] font-mono">
                    {recentEvents.length} events
                  </Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Chronological log of verified user taps, navigations, and dialog events
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Filter events, user, IP..."
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    className="h-8 pl-8 text-xs rounded-lg"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto max-h-[440px] overflow-y-auto divide-y divide-border/30">
                {recentEvents.length > 0 ? (
                  recentEvents.map((evt) => (
                    <div
                      key={evt.id}
                      className="p-3 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 hover:bg-muted/20 transition-colors"
                    >
                      <div className="flex items-start sm:items-center gap-2.5 min-w-0 flex-1">
                        <span
                          className="px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 mt-0.5 sm:mt-0"
                          style={{
                            backgroundColor: `${ROLE_COLORS[evt.role] || '#64748b'}20`,
                            color: ROLE_COLORS[evt.role] || '#64748b',
                          }}
                        >
                          {evt.role}
                        </span>

                        <div className="truncate flex-1 min-w-0">
                          <p className="font-semibold text-foreground truncate">
                            {evt.dialog_name ? `[Dialog: ${evt.dialog_name}] ` : ''}
                            {evt.target || evt.section || evt.event_type}
                          </p>
                          <div className="text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
                            <span className="font-medium text-foreground/80">
                              {evt.user_name || 'Anonymous User'}
                            </span>
                            {evt.phone && <span>({evt.phone})</span>}
                            {evt.section && <span>• Section: {evt.section}</span>}
                          </div>
                        </div>
                      </div>

                      {/* Right Meta Badges: IP, Clickable GPS, Timestamp */}
                      <div className="flex items-center flex-wrap sm:flex-nowrap gap-2 shrink-0 self-end sm:self-center">
                        {/* IP Address display */}
                        {evt.ip_address ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-muted/60 text-muted-foreground border border-border/50 shrink-0"
                            title={`IP Address: ${evt.ip_address}`}
                          >
                            <Globe className="h-2.5 w-2.5 text-muted-foreground/70" />
                            {evt.ip_address}
                          </span>
                        ) : null}

                        {/* Clickable GPS Link to Google Maps */}
                        {evt.has_gps && evt.latitude != null && evt.longitude != null ? (
                          <a
                            href={`https://www.google.com/maps?q=${evt.latitude},${evt.longitude}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-colors group cursor-pointer shrink-0"
                            title={`Open GPS location in Google Maps (${evt.latitude}, ${evt.longitude})`}
                          >
                            <MapPin className="h-2.5 w-2.5 text-emerald-500 group-hover:scale-110 transition-transform shrink-0" />
                            <span>{Number(evt.latitude).toFixed(4)}, {Number(evt.longitude).toFixed(4)}</span>
                            <ExternalLink className="h-2.5 w-2.5 opacity-60 ml-0.5 shrink-0" />
                          </a>
                        ) : evt.has_gps ? (
                          <Badge
                            variant="outline"
                            className="text-[9px] bg-emerald-500/10 text-emerald-600 border-emerald-500/30 gap-1 shrink-0"
                          >
                            <Navigation className="h-2.5 w-2.5" />
                            GPS
                          </Badge>
                        ) : null}

                        {/* Timestamp */}
                        <span className="text-[11px] text-muted-foreground font-mono shrink-0 whitespace-nowrap pl-1">
                          {formatDistanceToNow(parseISO(evt.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="py-12 text-center text-xs text-muted-foreground">
                    No user events logged matching your criteria.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right 1 Col: Dashboard Breakdown, Top Actions & Modals */}
        <div className="space-y-6">
          {/* Active Dashboard Distribution */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base font-semibold">Active Dashboards</CardTitle>
              <CardDescription className="text-xs">Share of activity per user role</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-1 space-y-3">
              {(data?.roles || []).length > 0 ? (
                (data?.roles || []).map((r) => {
                  const pct = totalSessions > 0 ? Math.round((r.sessions / totalSessions) * 100) : 0;
                  const color = ROLE_COLORS[r.role] || '#64748b';
                  return (
                    <div key={r.role} className="space-y-1">
                      <div className="flex items-center justify-between text-xs font-medium">
                        <span className="capitalize flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          {r.role} Dashboard
                        </span>
                        <span className="text-muted-foreground font-mono">
                          {r.sessions} sessions ({pct}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${pct}%`, backgroundColor: color }}
                        />
                      </div>
                    </div>
                  );
                })
              ) : (
                <p className="text-xs text-muted-foreground py-4 text-center">
                  No role data available yet.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Top Tapped Buttons & CTAs */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base font-semibold">Top Taps & Actions</CardTitle>
              <CardDescription className="text-xs">Most clicked CTAs across all screens</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="space-y-2 mt-2">
                {(data?.actions || []).slice(0, 7).map((act, i) => (
                  <div
                    key={act.target + i}
                    className="p-2 rounded-lg bg-muted/30 border border-border/40 flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <MousePointerClick className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="font-medium text-foreground truncate">{act.target}</span>
                    </div>
                    <Badge variant="secondary" className="font-mono text-[10px] shrink-0">
                      {act.count} taps
                    </Badge>
                  </div>
                ))}
                {(data?.actions || []).length === 0 && (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    User taps will automatically be detected and listed here.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Dialog Interactions */}
          <Card className="border-border/60 shadow-sm">
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-base font-semibold">Dialog Interactivity</CardTitle>
              <CardDescription className="text-xs">Active modals and drawers</CardDescription>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <div className="space-y-2 mt-2">
                {(data?.dialogs || []).slice(0, 5).map((dlg, i) => (
                  <div
                    key={dlg.dialog_name + i}
                    className="p-2 rounded-lg bg-muted/30 border border-border/40 flex items-center justify-between text-xs"
                  >
                    <div className="truncate">
                      <span className="font-medium text-foreground truncate block">
                        {dlg.dialog_name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {dlg.unique_sessions} sessions
                      </span>
                    </div>
                    <span className="font-bold text-foreground font-mono text-xs">
                      {dlg.interactions} actions
                    </span>
                  </div>
                ))}
                {(data?.dialogs || []).length === 0 && (
                  <p className="text-xs text-muted-foreground py-4 text-center">
                    Dialog opens and confirmations will show here.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default UserBehaviourAnalyticsPanel;

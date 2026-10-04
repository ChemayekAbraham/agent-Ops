import { useMemo, useState } from 'react';
import { TenantOpsReportToolbar } from './TenantOpsReportToolbar';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter, DrawerClose,
} from '@/components/ui/drawer';
import {
  ArrowRightLeft, Link2, MapPin, MapPinOff, Search, Shield,
  CheckCircle2, AlertCircle, Clock, ExternalLink, Filter, X, ChevronDown, Navigation, Copy,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

type AuditEntryKind = 'transfer' | 'link';

interface AuditEntry {
  id: string;
  kind: AuditEntryKind;
  created_at: string;
  tenant_id: string | null;
  tenant_name: string;
  from_agent_id: string | null;
  from_agent_name: string;
  to_agent_id: string | null;
  to_agent_name: string;
  actor_id: string | null;
  actor_name: string;
  actor_latitude: number | null;
  actor_longitude: number | null;
  actor_accuracy: number | null;
  actor_location_status: string | null;
  reason: string | null;
  flag_type: string | null;
  rent_requests_updated: number | null;
  rent_request_id: string | null;
}

const STATUS_META: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  captured:    { label: 'Captured',    cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30', icon: CheckCircle2 },
  denied:      { label: 'Denied',      cls: 'bg-destructive/10 text-destructive border-destructive/30', icon: MapPinOff },
  unavailable: { label: 'Unavailable', cls: 'bg-muted text-muted-foreground border-border',             icon: MapPinOff },
  timeout:     { label: 'Timeout',     cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30',       icon: Clock },
  unsupported: { label: 'Unsupported', cls: 'bg-muted text-muted-foreground border-border',             icon: AlertCircle },
};

function statusPill(status: string | null) {
  const meta = (status && STATUS_META[status]) || {
    label: 'Unknown',
    cls: 'bg-muted text-muted-foreground border-border',
    icon: AlertCircle,
  };
  const Icon = meta.icon;
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] ${meta.cls}`}>
      <Icon className="h-3 w-3" />
      {meta.label}
    </Badge>
  );
}

export function TenantTransferAuditTrail() {
  const [search, setSearch] = useState('');
  // Currently-open entry for the embedded map drawer. null => closed.
  const [mapEntry, setMapEntry] = useState<AuditEntry | null>(null);

  const { data: entries, isLoading } = useQuery({
    queryKey: ['tenant-transfer-audit-trail'],
    queryFn: async (): Promise<AuditEntry[]> => {
      // Pull last 200 transfers and last 200 link audit_log rows in parallel.
      const [transfersRes, linksRes] = await Promise.all([
        supabase
          .from('tenant_transfers')
          .select(
            'id, tenant_id, from_agent_id, to_agent_id, transferred_by, reason, flag_type, rent_requests_updated, actor_latitude, actor_longitude, actor_accuracy, actor_location_status, created_at',
          )
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('audit_logs')
          .select('id, action_type, record_id, metadata, user_id, created_at')
          .eq('action_type', 'agent_linked')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const transfers = transfersRes.data || [];
      const links = (linksRes.data || []) as Array<{
        id: string;
        record_id: string | null;
        user_id: string | null;
        created_at: string;
        metadata: Record<string, unknown> | null;
      }>;

      // Resolve all profile ids needed in a single round-trip.
      const ids = new Set<string>();
      transfers.forEach((t) => {
        if (t.tenant_id) ids.add(t.tenant_id);
        if (t.from_agent_id) ids.add(t.from_agent_id);
        if (t.to_agent_id) ids.add(t.to_agent_id);
        if (t.transferred_by) ids.add(t.transferred_by);
      });
      links.forEach((l) => {
        const m = l.metadata || {};
        const tenant_id = m.tenant_id as string | undefined;
        const agent_id = m.agent_id as string | undefined;
        if (tenant_id) ids.add(tenant_id);
        if (agent_id) ids.add(agent_id);
        if (l.user_id) ids.add(l.user_id);
      });

      const idArr = Array.from(ids);
      const profilesRes = idArr.length
        ? await supabase.from('profiles').select('id, full_name').in('id', idArr)
        : { data: [] as Array<{ id: string; full_name: string | null }> };
      const nameOf = new Map(
        (profilesRes.data || []).map((p) => [p.id, p.full_name || '—']),
      );

      const transferEntries: AuditEntry[] = transfers.map((t) => ({
        id: `t:${t.id}`,
        kind: 'transfer',
        created_at: t.created_at,
        tenant_id: t.tenant_id,
        tenant_name: nameOf.get(t.tenant_id || '') || '—',
        from_agent_id: t.from_agent_id,
        from_agent_name: nameOf.get(t.from_agent_id || '') || '—',
        to_agent_id: t.to_agent_id,
        to_agent_name: nameOf.get(t.to_agent_id || '') || '—',
        actor_id: t.transferred_by,
        actor_name: nameOf.get(t.transferred_by || '') || '—',
        actor_latitude: t.actor_latitude,
        actor_longitude: t.actor_longitude,
        actor_accuracy: t.actor_accuracy,
        actor_location_status: t.actor_location_status,
        reason: t.reason,
        flag_type: t.flag_type,
        rent_requests_updated: t.rent_requests_updated,
        rent_request_id: null,
      }));

      const linkEntries: AuditEntry[] = links.map((l) => {
        const m = (l.metadata || {}) as Record<string, unknown>;
        const tenant_id = (m.tenant_id as string | undefined) || null;
        const agent_id = (m.agent_id as string | undefined) || null;
        return {
          id: `l:${l.id}`,
          kind: 'link',
          created_at: l.created_at,
          tenant_id,
          tenant_name: nameOf.get(tenant_id || '') || '—',
          from_agent_id: null,
          from_agent_name: '—',
          to_agent_id: agent_id,
          to_agent_name: nameOf.get(agent_id || '') || '—',
          actor_id: l.user_id,
          actor_name: nameOf.get(l.user_id || '') || '—',
          actor_latitude: (m.actor_latitude as number | undefined) ?? null,
          actor_longitude: (m.actor_longitude as number | undefined) ?? null,
          actor_accuracy: (m.actor_accuracy as number | undefined) ?? null,
          actor_location_status: (m.actor_location_status as string | undefined) ?? null,
          reason: (m.reason as string | undefined) ?? null,
          flag_type: null,
          rent_requests_updated: null,
          rent_request_id: l.record_id,
        };
      });

      return [...transferEntries, ...linkEntries].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    },
  });

  // Advanced filter state — each filter is independent and combines with AND.
  const [showFilters, setShowFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tenantFilter, setTenantFilter] = useState('all');
  const [executiveFilter, setExecutiveFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [fromAgentFilter, setFromAgentFilter] = useState('all');
  const [toAgentFilter, setToAgentFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'transfer' | 'link'>('all');

  // Build dropdown option lists from the loaded entries so operators only see
  // values that actually exist in the audit trail.
  const filterOptions = useMemo(() => {
    const tenants = new Map<string, string>();
    const fromAgents = new Map<string, string>();
    const toAgents = new Map<string, string>();
    const executives = new Map<string, string>();
    (entries || []).forEach((e) => {
      if (e.tenant_id) tenants.set(e.tenant_id, e.tenant_name);
      if (e.from_agent_id) fromAgents.set(e.from_agent_id, e.from_agent_name);
      if (e.to_agent_id) toAgents.set(e.to_agent_id, e.to_agent_name);
      if (e.actor_id) executives.set(e.actor_id, e.actor_name);
    });
    const toSorted = (m: Map<string, string>) =>
      Array.from(m.entries())
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
      tenants: toSorted(tenants),
      fromAgents: toSorted(fromAgents),
      toAgents: toSorted(toAgents),
      executives: toSorted(executives),
    };
  }, [entries]);

  const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
  const toTs = dateTo ? new Date(dateTo + 'T23:59:59.999').getTime() : null;

  const filtered = (entries || []).filter((e) => {
    // Quick text search across all key names + reason.
    if (search.trim()) {
      const q = search.toLowerCase();
      const hit =
        e.tenant_name.toLowerCase().includes(q) ||
        e.from_agent_name.toLowerCase().includes(q) ||
        e.to_agent_name.toLowerCase().includes(q) ||
        e.actor_name.toLowerCase().includes(q) ||
        (e.reason || '').toLowerCase().includes(q);
      if (!hit) return false;
    }
    if (kindFilter !== 'all' && e.kind !== kindFilter) return false;
    if (tenantFilter !== 'all' && e.tenant_id !== tenantFilter) return false;
    if (fromAgentFilter !== 'all' && e.from_agent_id !== fromAgentFilter) return false;
    if (toAgentFilter !== 'all' && e.to_agent_id !== toAgentFilter) return false;
    if (executiveFilter !== 'all' && e.actor_id !== executiveFilter) return false;
    if (statusFilter !== 'all') {
      const s = e.actor_location_status || 'unknown';
      if (statusFilter === 'missing') {
        if (s === 'captured') return false;
      } else if (s !== statusFilter) {
        return false;
      }
    }
    if (fromTs || toTs) {
      const ts = new Date(e.created_at).getTime();
      if (fromTs && ts < fromTs) return false;
      if (toTs && ts > toTs) return false;
    }
    return true;
  });

  const captured = (entries || []).filter((e) => e.actor_location_status === 'captured').length;
  const missing = (entries || []).filter(
    (e) => !e.actor_location_status || e.actor_location_status !== 'captured',
  ).length;

  // Count active filters for the toggle pill — search excluded since it has its
  // own visible field.
  const activeFilterCount =
    (dateFrom ? 1 : 0) +
    (dateTo ? 1 : 0) +
    (tenantFilter !== 'all' ? 1 : 0) +
    (fromAgentFilter !== 'all' ? 1 : 0) +
    (toAgentFilter !== 'all' ? 1 : 0) +
    (executiveFilter !== 'all' ? 1 : 0) +
    (statusFilter !== 'all' ? 1 : 0) +
    (kindFilter !== 'all' ? 1 : 0);

  const clearFilters = () => {
    setDateFrom('');
    setDateTo('');
    setTenantFilter('all');
    setFromAgentFilter('all');
    setToAgentFilter('all');
    setExecutiveFilter('all');
    setStatusFilter('all');
    setKindFilter('all');
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-primary" />
            Tenant Assignment Audit Trail
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Geo-stamped record of every executive link &amp; transfer action. Used to
            verify field operations and feed the Trust Coverage Engine.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border bg-card p-2.5">
              <div className="text-[10px] uppercase text-muted-foreground">Total actions</div>
              <div className="text-lg font-bold">{entries?.length ?? 0}</div>
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2.5">
              <div className="text-[10px] uppercase text-emerald-700">Geo captured</div>
              <div className="text-lg font-bold text-emerald-700">{captured}</div>
            </div>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
              <div className="text-[10px] uppercase text-amber-700">No geo</div>
              <div className="text-lg font-bold text-amber-700">{missing}</div>
            </div>
          </div>

          <TenantOpsReportToolbar
            tool="transfer_audit"
            status="all"
            search={search}
            visibleCount={filtered.length}
            fileSlug="tenant-transfer-audit"
          />

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search tenant, agent, executive, or reason..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-8 h-9 text-xs"
                />
              </div>
              <Button
                variant={showFilters ? 'default' : 'outline'}
                size="sm"
                className="h-9 gap-1.5 shrink-0"
                onClick={() => setShowFilters((v) => !v)}
              >
                <Filter className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Filters</span>
                {activeFilterCount > 0 && (
                  <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                    {activeFilterCount}
                  </Badge>
                )}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${showFilters ? 'rotate-180' : ''}`}
                />
              </Button>
            </div>

            <Collapsible open={showFilters}>
              <CollapsibleContent className="space-y-3 rounded-lg border bg-muted/30 p-3 mt-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                  {/* Date range */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">From date</Label>
                    <Input
                      type="date"
                      value={dateFrom}
                      max={dateTo || undefined}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">To date</Label>
                    <Input
                      type="date"
                      value={dateTo}
                      min={dateFrom || undefined}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>

                  {/* Action kind */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Action type</Label>
                    <Select value={kindFilter} onValueChange={(v) => setKindFilter(v as typeof kindFilter)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All actions</SelectItem>
                        <SelectItem value="transfer">Transfers only</SelectItem>
                        <SelectItem value="link">Links only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Tenant */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Tenant</Label>
                    <Select value={tenantFilter} onValueChange={setTenantFilter}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Any tenant" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        <SelectItem value="all">Any tenant</SelectItem>
                        {filterOptions.tenants.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Before agent (transfers only) */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Before agent</Label>
                    <Select value={fromAgentFilter} onValueChange={setFromAgentFilter}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Any" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        <SelectItem value="all">Any</SelectItem>
                        {filterOptions.fromAgents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* After agent */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">After agent</Label>
                    <Select value={toAgentFilter} onValueChange={setToAgentFilter}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Any" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        <SelectItem value="all">Any</SelectItem>
                        {filterOptions.toAgents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Executive */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Executive</Label>
                    <Select value={executiveFilter} onValueChange={setExecutiveFilter}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Any executive" />
                      </SelectTrigger>
                      <SelectContent className="max-h-64">
                        <SelectItem value="all">Any executive</SelectItem>
                        {filterOptions.executives.map((e) => (
                          <SelectItem key={e.id} value={e.id}>
                            {e.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Capture status */}
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase text-muted-foreground">Capture status</Label>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Any status</SelectItem>
                        <SelectItem value="captured">Captured</SelectItem>
                        <SelectItem value="missing">Any missing (no geo)</SelectItem>
                        <SelectItem value="denied">Denied</SelectItem>
                        <SelectItem value="unavailable">Unavailable</SelectItem>
                        <SelectItem value="timeout">Timeout</SelectItem>
                        <SelectItem value="unsupported">Unsupported</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-border/60">
                  <div className="text-[11px] text-muted-foreground">
                    Showing <span className="font-semibold">{filtered.length}</span> of{' '}
                    {entries?.length ?? 0} actions
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    disabled={activeFilterCount === 0}
                    className="h-7 gap-1 text-xs"
                  >
                    <X className="h-3 w-3" />
                    Clear filters
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No audit entries match this search.
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[calc(100vh-340px)]">
          <div className="space-y-2 pr-2">
            {filtered.map((e) => (
              <Card
                key={e.id}
                className="overflow-hidden cursor-pointer transition-colors hover:bg-muted/40 hover:border-primary/40"
                onClick={() => setMapEntry(e)}
                role="button"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setMapEntry(e);
                  }
                }}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant="outline"
                        className={
                          e.kind === 'transfer'
                            ? 'gap-1 text-[10px] bg-orange-500/10 text-orange-700 border-orange-500/30'
                            : 'gap-1 text-[10px] bg-primary/10 text-primary border-primary/30'
                        }
                      >
                        {e.kind === 'transfer' ? (
                          <ArrowRightLeft className="h-3 w-3" />
                        ) : (
                          <Link2 className="h-3 w-3" />
                        )}
                        {e.kind === 'transfer' ? 'Transfer' : 'Link'}
                      </Badge>
                      {statusPill(e.actor_location_status)}
                      {e.flag_type && (
                        <Badge variant="outline" className="text-[10px]">
                          {e.flag_type.replace(/_/g, ' ')}
                        </Badge>
                      )}
                    </div>
                    <div
                      className="text-[10px] text-muted-foreground shrink-0"
                      title={format(new Date(e.created_at), 'PPpp')}
                    >
                      {formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}
                    </div>
                  </div>

                  <div className="text-xs space-y-1">
                    <div>
                      <span className="text-muted-foreground">Tenant: </span>
                      <span className="font-medium">{e.tenant_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-muted-foreground">Agent:</span>
                      {e.kind === 'transfer' ? (
                        <>
                          <span className="font-medium">{e.from_agent_name}</span>
                          <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
                          <span className="font-medium">{e.to_agent_name}</span>
                          {e.rent_requests_updated != null && (
                            <Badge variant="outline" className="text-[10px]">
                              {e.rent_requests_updated} request
                              {e.rent_requests_updated === 1 ? '' : 's'}
                            </Badge>
                          )}
                        </>
                      ) : (
                        <span className="font-medium">{e.to_agent_name}</span>
                      )}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Executed by: </span>
                      <span className="font-medium">{e.actor_name}</span>
                      <span className="text-muted-foreground"> · {format(new Date(e.created_at), 'PP p')}</span>
                    </div>
                    {e.reason && (
                      <div className="text-muted-foreground italic">
                        "{e.reason}"
                      </div>
                    )}
                  </div>

                  <div className="rounded-md border bg-muted/30 p-2 text-[11px] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {e.actor_latitude != null && e.actor_longitude != null ? (
                        <>
                          <MapPin className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                          <span className="font-mono truncate">
                            {Number(e.actor_latitude).toFixed(5)},{' '}
                            {Number(e.actor_longitude).toFixed(5)}
                          </span>
                          {e.actor_accuracy != null && (
                            <span className="text-muted-foreground shrink-0">
                              ±{Math.round(Number(e.actor_accuracy))} m
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <MapPinOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="text-muted-foreground">
                            No coordinates recorded
                          </span>
                        </>
                      )}
                    </div>
                    {e.actor_latitude != null && e.actor_longitude != null && (
                      <a
                        href={`https://www.google.com/maps?q=${e.actor_latitude},${e.actor_longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(ev) => ev.stopPropagation()}
                        className="text-primary hover:underline flex items-center gap-1 shrink-0"
                      >
                        Map <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}

      <AuditMapDrawer entry={mapEntry} onClose={() => setMapEntry(null)} />
    </div>
  );
}

/**
 * Bottom drawer that embeds an OpenStreetMap iframe centred on the executive's
 * captured coordinates, plus copy/open-in-Maps shortcuts. OSM's public embed
 * needs no API key — perfect for an audit-only verification view.
 */
function AuditMapDrawer({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  const open = entry !== null;
  const lat = entry?.actor_latitude ?? null;
  const lon = entry?.actor_longitude ?? null;
  const hasGeo = lat != null && lon != null;

  // Tighten the bbox as accuracy gets better — minimum ~250m window so a
  // <10m fix doesn't render as an unreadable zoomed-pin.
  const accuracy = entry?.actor_accuracy ?? 100;
  const halfDeg = Math.max(0.0025, (Number(accuracy) || 100) / 50000);
  const bbox = hasGeo
    ? `${(lon as number) - halfDeg},${(lat as number) - halfDeg},${(lon as number) + halfDeg},${(lat as number) + halfDeg}`
    : '';
  const embedSrc = hasGeo
    ? `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`
    : '';

  const copyCoords = async () => {
    if (!hasGeo) return;
    try {
      await navigator.clipboard.writeText(`${lat}, ${lon}`);
      toast.success('Coordinates copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <Drawer open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DrawerContent className="max-h-[90vh]">
        <DrawerHeader className="text-left">
          <DrawerTitle className="flex items-center gap-2 text-base">
            {entry?.kind === 'transfer' ? (
              <ArrowRightLeft className="h-4 w-4 text-orange-600" />
            ) : (
              <Link2 className="h-4 w-4 text-primary" />
            )}
            {entry?.kind === 'transfer' ? 'Transfer location' : 'Link location'}
          </DrawerTitle>
          <DrawerDescription className="text-xs">
            {entry && (
              <>
                <span className="font-medium text-foreground">{entry.actor_name}</span>{' '}
                · {format(new Date(entry.created_at), 'PP p')}
              </>
            )}
          </DrawerDescription>
        </DrawerHeader>

        <div className="px-4 pb-2 space-y-3">
          {entry && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase text-muted-foreground">Tenant</div>
                <div className="font-medium truncate">{entry.tenant_name}</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-[10px] uppercase text-muted-foreground">
                  {entry.kind === 'transfer' ? 'Agent change' : 'Linked agent'}
                </div>
                <div className="font-medium truncate flex items-center gap-1">
                  {entry.kind === 'transfer' ? (
                    <>
                      <span className="truncate">{entry.from_agent_name}</span>
                      <ArrowRightLeft className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{entry.to_agent_name}</span>
                    </>
                  ) : (
                    entry.to_agent_name
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            {entry && statusPill(entry.actor_location_status)}
            {hasGeo && (
              <div className="text-[11px] font-mono text-muted-foreground">
                {Number(lat).toFixed(6)}, {Number(lon).toFixed(6)}
                {entry?.actor_accuracy != null && (
                  <span> · ±{Math.round(Number(entry.actor_accuracy))} m</span>
                )}
              </div>
            )}
          </div>

          <div className="rounded-md border overflow-hidden bg-muted/30 h-[42vh] min-h-[260px]">
            {hasGeo ? (
              <iframe
                key={`${lat},${lon}`}
                title="Captured location map"
                src={embedSrc}
                className="w-full h-full border-0"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 gap-2">
                <MapPinOff className="h-8 w-8 text-muted-foreground" />
                <div className="text-sm font-medium">No coordinates recorded</div>
                <div className="text-xs text-muted-foreground max-w-sm">
                  This action was completed without a successful geo-capture
                  {entry?.actor_location_status ? ` (${entry.actor_location_status})` : ''}.
                  Cross-check with the executive directly before relying on it for field
                  verification.
                </div>
              </div>
            )}
          </div>
        </div>

        <DrawerFooter className="pt-2">
          <div className="flex flex-wrap gap-2">
            {hasGeo && (
              <>
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                >
                  <a
                    href={`https://www.google.com/maps?q=${lat},${lon}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Google Maps
                  </a>
                </Button>
                <Button
                  asChild
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                >
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Navigation className="h-3.5 w-3.5" />
                    Directions
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={copyCoords}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy coords
                </Button>
              </>
            )}
            <DrawerClose asChild>
              <Button size="sm" variant="ghost" className="ml-auto">
                Close
              </Button>
            </DrawerClose>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

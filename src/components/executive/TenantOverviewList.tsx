import { useState, useMemo, useEffect, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Search, Phone, ChevronRight, User, ChevronLeft, ChevronDown, Download, Loader2, Users, MapPin, Globe2, Building2, Home as HomeIcon } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { generateAndDownloadActiveTenantsPdf } from '@/lib/activeTenantsReportPdf';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TenantRow {
  id: string;
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string;
  status: string;
  rent_amount: number;
  amount_repaid: number;
  landlord_name: string;
  landlord_phone: string;
  created_at: string;
}

type Category = 'all' | 'pending' | 'in_pipeline' | 'active' | 'repaying' | 'fully_repaid' | 'defaulted';

const CATEGORIES: { value: Category; label: string; color: string }[] = [
  { value: 'all', label: 'All', color: 'bg-muted text-foreground' },
  { value: 'pending', label: 'Pending', color: 'bg-amber-100 text-amber-700' },
  { value: 'in_pipeline', label: 'In Pipeline', color: 'bg-blue-100 text-blue-700' },
  { value: 'active', label: 'Active', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'repaying', label: 'Repaying', color: 'bg-purple-100 text-purple-700' },
  { value: 'fully_repaid', label: 'Fully Repaid', color: 'bg-green-100 text-green-700' },
  { value: 'defaulted', label: 'Defaulted', color: 'bg-destructive/10 text-destructive' },
];

const STATUS_MAP: Record<Category, string[]> = {
  all: [],
  pending: ['pending'],
  in_pipeline: ['tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved'],
  active: ['funded', 'disbursed'],
  repaying: ['repaying'],
  fully_repaid: ['fully_repaid'],
  defaulted: ['defaulted'],
};

const statusBadgeColor = (status: string) => {
  const map: Record<string, string> = {
    pending: 'bg-amber-100 text-amber-700',
    tenant_ops_approved: 'bg-blue-100 text-blue-700',
    agent_verified: 'bg-purple-100 text-purple-700',
    landlord_ops_approved: 'bg-indigo-100 text-indigo-700',
    coo_approved: 'bg-emerald-100 text-emerald-700',
    funded: 'bg-green-100 text-green-700',
    disbursed: 'bg-teal-100 text-teal-700',
    repaying: 'bg-purple-100 text-purple-700',
    fully_repaid: 'bg-emerald-100 text-emerald-700',
    defaulted: 'bg-destructive/10 text-destructive',
  };
  return map[status] || 'bg-muted text-muted-foreground';
};

interface TenantOverviewListProps {
  data: TenantRow[];
  loading?: boolean;
  initialCategory?: string;
  onSelectTenant: (tenantId: string, tenantName: string) => void;
}

type GroupBy = 'none' | 'drilldown' | 'agent' | 'region' | 'village' | 'district' | 'city' | 'country';

// Tenants without a recorded city default to Entebbe so they roll up into a
// real location instead of an unhelpful "Unknown city" bucket. The label is
// suffixed so agents are visibly prompted to confirm/edit the city.
const DEFAULT_UNVERIFIED_CITY = 'Entebbe';
const UNVERIFIED_CITY_LABEL = `${DEFAULT_UNVERIFIED_CITY} (please verify)`;
const isUnverifiedCity = (city: string) =>
  city === UNVERIFIED_CITY_LABEL || city === 'Unknown city';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'drilldown', label: 'Drill-down: Country → City → Agent' },
  { value: 'agent', label: 'Agent' },
  { value: 'region', label: 'Region' },
  { value: 'village', label: 'LC1 / Village' },
  { value: 'district', label: 'District' },
  { value: 'city', label: 'City' },
  { value: 'country', label: 'Country' },
];

interface TenantEnrichment {
  agent_id: string | null;
  agent_name: string | null;
  region: string | null;
  village: string | null;
  district: string | null;
  city: string | null;
  country: string | null;
}

export function TenantOverviewList({ data, loading, initialCategory, onSelectTenant }: TenantOverviewListProps) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<Category>((initialCategory as Category) || 'all');
  const [page, setPage] = useState(1);
  const [groupBy, setGroupBy] = useState<GroupBy>('drilldown');
  const [enrichment, setEnrichment] = useState<Map<string, TenantEnrichment>>(new Map());
  const [enriching, setEnriching] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // Drill-down navigation path: country → city → agent → tenants
  const [drillCountry, setDrillCountry] = useState<string | null>(null);
  const [drillCity, setDrillCity] = useState<string | null>(null);
  const [drillAgent, setDrillAgent] = useState<string | null>(null);
  const PAGE_SIZE = 25;

  // Sync when parent changes the filter
  useEffect(() => {
    if (initialCategory) {
      setCategory(initialCategory as Category);
    }
  }, [initialCategory]);

  // Reset to first page when filters/search change
  useEffect(() => { setPage(1); }, [search, category]);

  // Reset drill path when leaving drill-down mode
  useEffect(() => {
    if (groupBy !== 'drilldown') {
      setDrillCountry(null);
      setDrillCity(null);
      setDrillAgent(null);
    }
  }, [groupBy]);

  // Deduplicate tenants - group by tenant_id, pick most recent request
  const tenants = useMemo(() => {
    const map = new Map<string, TenantRow & { requestCount: number }>();
    for (const row of data) {
      if (!row.tenant_id) continue;
      const existing = map.get(row.tenant_id);
      if (!existing || new Date(row.created_at) > new Date(existing.created_at)) {
        map.set(row.tenant_id, { ...row, requestCount: (existing?.requestCount || 0) + 1 });
      } else if (existing) {
        existing.requestCount += 1;
      }
    }
    return Array.from(map.values());
  }, [data]);

  // Fetch agent + location enrichment for the current tenant set.
  // We resolve the agent via the most recent rent_request assignment,
  // falling back to profiles.referrer_id when that referrer holds the
  // agent role. Location comes straight from the tenant profile.
  useEffect(() => {
    let cancelled = false;
    const tenantIds = tenants.map((t) => t.tenant_id).filter(Boolean);
    if (tenantIds.length === 0) {
      setEnrichment(new Map());
      return;
    }
    setEnriching(true);
    (async () => {
      try {
        const [{ data: profiles }, { data: rentReqs }] = await Promise.all([
          supabase
            .from('profiles')
            .select('id, referrer_id, region, village, district, city, country')
            .in('id', tenantIds),
          supabase
            .from('rent_requests')
            .select('tenant_id, agent_id, created_at')
            .in('tenant_id', tenantIds)
            .not('agent_id', 'is', null)
            .order('created_at', { ascending: false }),
        ]);

        const assignedAgentByTenant = new Map<string, string>();
        for (const r of rentReqs || []) {
          if (r.agent_id && !assignedAgentByTenant.has(r.tenant_id)) {
            assignedAgentByTenant.set(r.tenant_id, r.agent_id);
          }
        }

        const referrerIds = Array.from(
          new Set((profiles || []).map((p: any) => p.referrer_id).filter(Boolean) as string[]),
        );
        const { data: agentRoleRows } = referrerIds.length
          ? await supabase
              .from('user_roles')
              .select('user_id')
              .in('user_id', referrerIds)
              .eq('role', 'agent')
          : { data: [] as any[] };
        const agentReferrerSet = new Set((agentRoleRows || []).map((r: any) => r.user_id));

        const allAgentIds = Array.from(
          new Set([
            ...Array.from(assignedAgentByTenant.values()),
            ...referrerIds.filter((id) => agentReferrerSet.has(id)),
          ]),
        );
        const { data: agentProfiles } = allAgentIds.length
          ? await supabase.from('profiles').select('id, full_name').in('id', allAgentIds)
          : { data: [] as any[] };
        const agentNameMap = new Map<string, string>(
          (agentProfiles || []).map((p: any) => [p.id, p.full_name || 'Unnamed agent']),
        );

        const next = new Map<string, TenantEnrichment>();
        for (const p of profiles || []) {
          const agentId =
            assignedAgentByTenant.get(p.id) ||
            (p.referrer_id && agentReferrerSet.has(p.referrer_id) ? p.referrer_id : null);
          next.set(p.id, {
            agent_id: agentId,
            agent_name: agentId ? agentNameMap.get(agentId) ?? null : null,
            region: p.region ?? null,
            village: p.village ?? null,
            district: p.district ?? null,
            city: p.city ?? null,
            country: p.country ?? null,
          });
        }
        if (!cancelled) setEnrichment(next);
      } catch (err) {
        console.warn('[TenantOverviewList] enrichment failed:', err);
      } finally {
        if (!cancelled) setEnriching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the set of tenant ids actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants.map((t) => t.tenant_id).join('|')]);

  const filtered = useMemo(() => {
    let result = tenants;

    // Category filter - check if tenant has ANY request in this category
    if (category !== 'all') {
      const statuses = STATUS_MAP[category];
      const tenantIdsInCategory = new Set(
        data.filter(r => statuses.includes(r.status)).map(r => r.tenant_id)
      );
      result = result.filter(t => tenantIdsInCategory.has(t.tenant_id));
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(t =>
        t.tenant_name.toLowerCase().includes(q) ||
        t.tenant_phone.toLowerCase().includes(q) ||
        t.landlord_name.toLowerCase().includes(q)
      );
    }

    return result;
  }, [tenants, category, search, data]);

  // Resolve the group key (and display label) for a tenant given groupBy.
  const groupKeyFor = (tenant: TenantRow & { requestCount: number }): string => {
    const e = enrichment.get(tenant.tenant_id);
    switch (groupBy) {
      case 'agent':
        return e?.agent_name?.trim() || 'Unassigned';
      case 'region':
        return e?.region?.trim() || 'Unknown region';
      case 'village':
        return e?.village?.trim() || 'Unknown LC1 / village';
      case 'district':
        return e?.district?.trim() || 'Unknown district';
      case 'city':
        return e?.city?.trim() || UNVERIFIED_CITY_LABEL;
      case 'country':
        return e?.country?.trim() || 'Unknown country';
      default:
        return '';
    }
  };

  const grouped = useMemo(() => {
    if (groupBy === 'none' || groupBy === 'drilldown') return null;
    const map = new Map<string, (TenantRow & { requestCount: number })[]>();
    for (const t of filtered) {
      const key = groupKeyFor(t);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries())
      .map(([key, rows]) => ({ key, rows }))
      .sort((a, b) => {
        // Unknown / Unassigned always last, otherwise by descending size.
        const aUnknown = /^Unknown |^Unassigned$/.test(a.key);
        const bUnknown = /^Unknown |^Unassigned$/.test(b.key);
        if (aUnknown !== bUnknown) return aUnknown ? 1 : -1;
        if (b.rows.length !== a.rows.length) return b.rows.length - a.rows.length;
        return a.key.localeCompare(b.key);
      });
  }, [filtered, groupBy, enrichment]);

  // Drill-down aggregations
  const drill = useMemo(() => {
    if (groupBy !== 'drilldown') return null;

    // Step 1: group by country. Tenants with no country default to Uganda
    // (current operating base). Always surface the priority country list even
    // when empty so ops can see expansion progress at a glance.
    const PRIORITY_COUNTRIES = ['Uganda', 'Kenya', 'Nigeria', 'South Africa'];
    const normalizeCountry = (raw: string | null | undefined): string => {
      const v = (raw || '').trim();
      if (!v) return 'Uganda';
      const lower = v.toLowerCase().replace(/\s+/g, ' ');
      if (['ug', 'uga', 'uganda'].includes(lower)) return 'Uganda';
      if (['ke', 'ken', 'kenya'].includes(lower)) return 'Kenya';
      if (['ng', 'nga', 'nigeria'].includes(lower)) return 'Nigeria';
      if (['za', 'rsa', 'south africa', 'southafrica', 's. africa', 'south-africa'].includes(lower)) return 'South Africa';
      return v.charAt(0).toUpperCase() + v.slice(1);
    };

    const byCountry = new Map<string, (TenantRow & { requestCount: number })[]>();
    for (const c of PRIORITY_COUNTRIES) byCountry.set(c, []);
    for (const t of filtered) {
      const e = enrichment.get(t.tenant_id);
      const c = normalizeCountry(e?.country);
      if (!byCountry.has(c)) byCountry.set(c, []);
      byCountry.get(c)!.push(t);
    }

    if (!drillCountry) {
      const entries = Array.from(byCountry.entries()).map(([key, rows]) => ({ key, count: rows.length }));
      const priority = PRIORITY_COUNTRIES
        .map((name) => entries.find((e) => e.key === name) || { key: name, count: 0 });
      const others = entries
        .filter((e) => !PRIORITY_COUNTRIES.includes(e.key))
        .sort((a, b) => b.count - a.count);
      return { level: 'country' as const, tiles: [...priority, ...others] };
    }

    const inCountry = byCountry.get(drillCountry) || [];

    // Step 2: group by city within country
    const byCity = new Map<string, (TenantRow & { requestCount: number })[]>();
    for (const t of inCountry) {
      const e = enrichment.get(t.tenant_id);
      const city = e?.city?.trim() || e?.district?.trim() || UNVERIFIED_CITY_LABEL;
      if (!byCity.has(city)) byCity.set(city, []);
      byCity.get(city)!.push(t);
    }

    if (!drillCity) {
      return {
        level: 'city' as const,
        tiles: Array.from(byCity.entries())
          .map(([key, rows]) => ({ key, count: rows.length }))
          .sort((a, b) => b.count - a.count),
      };
    }

    const inCity = byCity.get(drillCity) || [];

    // Step 3: group by agent within city
    const byAgent = new Map<string, (TenantRow & { requestCount: number })[]>();
    for (const t of inCity) {
      const e = enrichment.get(t.tenant_id);
      const a = e?.agent_name?.trim() || 'Unassigned';
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a)!.push(t);
    }

    if (!drillAgent) {
      return {
        level: 'agent' as const,
        tiles: Array.from(byAgent.entries())
          .map(([key, rows]) => ({ key, count: rows.length }))
          .sort((a, b) => b.count - a.count),
      };
    }

    // Step 4: tenant list
    return {
      level: 'tenants' as const,
      rows: byAgent.get(drillAgent) || [],
    };
  }, [groupBy, filtered, enrichment, drillCountry, drillCity, drillAgent]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );

  const categoryCounts = useMemo(() => {
    const counts: Record<Category, number> = {
      all: tenants.length,
      pending: 0,
      in_pipeline: 0,
      active: 0,
      repaying: 0,
      fully_repaid: 0,
      defaulted: 0,
    };
    for (const row of data) {
      for (const [cat, statuses] of Object.entries(STATUS_MAP)) {
        if (cat === 'all') continue;
        if (statuses.includes(row.status)) {
          // Count unique tenants per category
          counts[cat as Category] = (counts[cat as Category] || 0);
        }
      }
    }
    // Recalculate properly with unique tenant counts
    for (const cat of Object.keys(STATUS_MAP) as Category[]) {
      if (cat === 'all') continue;
      const statuses = STATUS_MAP[cat];
      const uniqueTenants = new Set(
        data.filter(r => statuses.includes(r.status)).map(r => r.tenant_id)
      );
      counts[cat] = uniqueTenants.size;
    }
    return counts;
  }, [data, tenants]);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">All Tenants</h3>
        <div className="flex items-center gap-2">
          <ExportActiveTenantsButton />
          <span className="text-xs text-muted-foreground">{filtered.length} tenants</span>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search name, phone, landlord..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-9"
        />
      </div>

      {/* Group-by selector */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold text-muted-foreground shrink-0">Group by</span>
        <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
          <SelectTrigger className="h-8 text-xs flex-1 max-w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUP_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value} className="text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {enriching && groupBy !== 'none' && (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Category filter chips */}
      <div className="flex gap-1.5 flex-wrap">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.value}
            onClick={() => setCategory(cat.value)}
            className={cn(
              'px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all border',
              category === cat.value
                ? `${cat.color} border-current shadow-sm`
                : 'bg-background text-muted-foreground border-border hover:bg-muted'
            )}
          >
            {cat.label}
            <span className="ml-1 opacity-70">({categoryCounts[cat.value]})</span>
          </button>
        ))}
      </div>

      {/* Tenant list — flat (when grouping is off) or grouped sections */}
      {groupBy === 'drilldown' ? (
        <DrillDownView
          drill={drill}
          drillCountry={drillCountry}
          drillCity={drillCity}
          drillAgent={drillAgent}
          setDrillCountry={setDrillCountry}
          setDrillCity={setDrillCity}
          setDrillAgent={setDrillAgent}
          onSelectTenant={onSelectTenant}
        />
      ) : groupBy === 'none' ? (
      <div className="space-y-1.5">
        {filtered.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              No tenants found
            </CardContent>
          </Card>
        ) : (
          paginated.map((tenant) => (
            <TenantRowCard
              key={tenant.tenant_id}
              tenant={tenant}
              onSelect={() => onSelectTenant(tenant.tenant_id, tenant.tenant_name)}
            />
          ))
        )}
      </div>
      ) : (
        <div className="space-y-3">
          {!grouped || grouped.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-muted-foreground text-sm">
                No tenants found
              </CardContent>
            </Card>
          ) : (
            grouped.map(({ key, rows }) => {
              const collapsed = collapsedGroups.has(key);
              const Icon = groupBy === 'agent' ? Users : MapPin;
              return (
                <div key={key} className="rounded-xl border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                      <span className="text-xs font-semibold text-foreground truncate">{key}</span>
                      <Badge variant="secondary" className="text-[10px] shrink-0">{rows.length}</Badge>
                    </div>
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 text-muted-foreground transition-transform',
                        collapsed && '-rotate-90',
                      )}
                    />
                  </button>
                  {!collapsed && (
                    <div className="p-2 space-y-1.5">
                      {rows.map((tenant) => (
                        <TenantRowCard
                          key={tenant.tenant_id}
                          tenant={tenant}
                          onSelect={() => onSelectTenant(tenant.tenant_id, tenant.tenant_name)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Pagination */}
      {groupBy === 'none' && filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2 border-t">
          <span className="text-[11px] text-muted-foreground">
            Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[11px] font-medium text-foreground tabular-nums px-2">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function TenantRowCard({
  tenant,
  onSelect,
}: {
  tenant: TenantRow & { requestCount: number };
  onSelect: () => void;
}) {
  return (
    <button onClick={onSelect} className="w-full text-left">
      <Card className="border hover:shadow-md hover:border-primary/30 transition-all cursor-pointer">
        <CardContent className="p-3 flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
            <User className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-foreground truncate">{tenant.tenant_name}</p>
              <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 shrink-0', statusBadgeColor(tenant.status))}>
                {tenant.status.replace(/_/g, ' ')}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Phone className="h-3 w-3" />{tenant.tenant_phone}
              </span>
              <span className="text-[11px] text-muted-foreground">
                UGX {Number(tenant.rent_amount || 0).toLocaleString()}
              </span>
              {tenant.requestCount > 1 && (
                <span className="text-[10px] text-muted-foreground">
                  {tenant.requestCount} requests
                </span>
              )}
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        </CardContent>
      </Card>
    </button>
  );
}

function ExportActiveTenantsButton() {
  const [exporting, setExporting] = useState(false);
  const handle = async () => {
    if (exporting) return;
    setExporting(true);
    const t = toast.loading('Generating active tenants report...');
    try {
      await generateAndDownloadActiveTenantsPdf();
      toast.success('Report downloaded', { id: t });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to generate report', { id: t });
    } finally {
      setExporting(false);
    }
  };
  return (
    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={handle} disabled={exporting}>
      {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      <span className="ml-1">Tenants Report PDF</span>
    </Button>
  );
}

type DrillTile = { key: string; count: number };
type DrillState =
  | { level: 'country'; tiles: DrillTile[] }
  | { level: 'city'; tiles: DrillTile[] }
  | { level: 'agent'; tiles: DrillTile[] }
  | { level: 'tenants'; rows: (TenantRow & { requestCount: number })[] }
  | null;

function DrillDownView({
  drill,
  drillCountry,
  drillCity,
  drillAgent,
  setDrillCountry,
  setDrillCity,
  setDrillAgent,
  onSelectTenant,
}: {
  drill: DrillState;
  drillCountry: string | null;
  drillCity: string | null;
  drillAgent: string | null;
  setDrillCountry: (v: string | null) => void;
  setDrillCity: (v: string | null) => void;
  setDrillAgent: (v: string | null) => void;
  onSelectTenant: (id: string, name: string) => void;
}) {
  if (!drill) return null;

  const crumb = (
    <div className="flex items-center gap-1 flex-wrap text-[11px] text-muted-foreground">
      <button
        onClick={() => { setDrillCountry(null); setDrillCity(null); setDrillAgent(null); }}
        className={cn(
          'px-2 py-0.5 rounded hover:bg-muted transition-colors flex items-center gap-1',
          !drillCountry && 'text-foreground font-semibold',
        )}
      >
        <Globe2 className="h-3 w-3" /> All countries
      </button>
      {drillCountry && (
        <>
          <ChevronRight className="h-3 w-3 opacity-50" />
          <button
            onClick={() => { setDrillCity(null); setDrillAgent(null); }}
            className={cn(
              'px-2 py-0.5 rounded hover:bg-muted transition-colors',
              !drillCity && 'text-foreground font-semibold',
            )}
          >
            {drillCountry}
          </button>
        </>
      )}
      {drillCity && (
        <>
          <ChevronRight className="h-3 w-3 opacity-50" />
          <button
            onClick={() => setDrillAgent(null)}
            className={cn(
              'px-2 py-0.5 rounded hover:bg-muted transition-colors',
              !drillAgent && 'text-foreground font-semibold',
            )}
          >
            {drillCity}
          </button>
        </>
      )}
      {drillAgent && (
        <>
          <ChevronRight className="h-3 w-3 opacity-50" />
          <span className="px-2 py-0.5 text-foreground font-semibold">{drillAgent}</span>
        </>
      )}
    </div>
  );

  const headerLabel =
    drill.level === 'country'
      ? 'Tap a country to drill in'
      : drill.level === 'city'
        ? `Cities & towns in ${drillCountry}`
        : drill.level === 'agent'
          ? `Agents serving ${drillCity}`
          : `Tenants under ${drillAgent}`;

  return (
    <div className="space-y-3">
      {crumb}
      <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        {headerLabel}
      </div>

      {drillCity && isUnverifiedCity(drillCity) && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          <strong className="font-semibold">City not recorded.</strong>{' '}
          These tenants were auto-grouped under <strong>{DEFAULT_UNVERIFIED_CITY}</strong> as a placeholder.
          Assigned agents should open each tenant and update the city, district and village so they roll up correctly.
        </div>
      )}

      {drill.level !== 'tenants' ? (
        drill.tiles.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              Nothing to show here yet
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {drill.tiles.map((tile) => {
              const Icon =
                drill.level === 'country' ? Globe2 : drill.level === 'city' ? Building2 : Users;
              const isEmpty = tile.count === 0;
              const disabled = drill.level === 'country' && isEmpty;
              return (
                <button
                  key={tile.key}
                  disabled={disabled}
                  onClick={() => {
                    if (drill.level === 'country') setDrillCountry(tile.key);
                    else if (drill.level === 'city') setDrillCity(tile.key);
                    else setDrillAgent(tile.key);
                  }}
                  className={cn(
                    'text-left rounded-xl border bg-card transition-all p-3 group',
                    disabled
                      ? 'opacity-60 cursor-not-allowed'
                      : 'hover:border-primary/40 hover:shadow-md',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    {!disabled && (
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    )}
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className={cn(
                      'text-2xl font-bold tabular-nums',
                      isEmpty ? 'text-muted-foreground' : 'text-foreground',
                    )}>
                      {tile.count}
                    </span>
                    <span className="text-sm font-semibold text-foreground truncate">
                      {drill.level === 'country' ? `Tenants in ${tile.key}` : tile.key}
                    </span>
                  </div>
                  {drill.level !== 'country' && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      {tile.count} tenant{tile.count === 1 ? '' : 's'}
                    </p>
                  )}
                  {drill.level === 'city' && isUnverifiedCity(tile.key) && (
                    <p className="text-[10px] mt-1 font-semibold text-amber-700 dark:text-amber-300">
                      ⚠ Needs agent verification
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )
      ) : drill.rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground text-sm">
            No tenants found
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {drill.rows.map((tenant) => (
            <TenantRowCard
              key={tenant.tenant_id}
              tenant={tenant}
              onSelect={() => onSelectTenant(tenant.tenant_id, tenant.tenant_name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

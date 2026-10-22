import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChevronDown, ChevronRight, MapPin, Users, ShieldCheck, Activity, Search, X, FileDown, Loader2, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import { AgentAvatar } from './AgentAvatar';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { downloadCsv } from '@/lib/csvExport';

interface Row {
  region: string;
  district: string;
  agent_count: number;
  verified_count: number;
  active_30d: number;
}

interface RegionGroup {
  region: string;
  total: number;
  verified: number;
  active: number;
  districts: Row[];
}

/**
 * One agent as returned by the directory register. Only the fields this
 * drill-down renders are declared — the profile panel fetches the rest.
 */
interface DistrictAgent {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  verified: boolean;
  region: string | null;
  district: string | null;
  agent_kind: 'agent' | 'sub_agent';
  total_tenants: number;
  daily_target: number;
  collected_today: number;
  status: 'active' | 'inactive' | 'frozen';
}

// The register caps every request at 100 rows, so a district is read a page at
// a time. The ceiling keeps one district from paging through tens of thousands
// of profiles in a single click; past it the reader is sent to the search box.
const RAW_PAGE = 100;
const MAX_RAW_PAGES = 10;

// Radix Select cannot use an empty string as an item value, so the "no district
// chosen" entry in the dropdown gets its own sentinel instead.
const ALL_DISTRICTS = '__all_districts__';

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-700 border-emerald-300',
  inactive: 'bg-muted text-muted-foreground border-border',
  frozen: 'bg-destructive/10 text-destructive border-destructive/30',
};

/** Every agent registered in one district, read through the same guarded register RPC. */
async function fetchDistrictAgentsAll(region: string, district: string): Promise<DistrictAgent[]> {
  const seen = new Set<string>();
  const out: DistrictAgent[] = [];
  for (let i = 0; i < 50; i++) {
    const { data, error } = await supabase.rpc('get_agent_directory_v2' as any, {
      p_search: district, p_type: 'all', p_status: 'all', p_limit: RAW_PAGE, p_offset: i * RAW_PAGE,
    });
    if (error) throw error;
    const rows = ((data as any)?.rows ?? []) as DistrictAgent[];
    for (const r of rows) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.district === district && r.region === region) out.push(r);
    }
    if (rows.length < RAW_PAGE) break;
  }
  return out;
}

/**
 * Agents of a single district, opened by clicking the district row.
 *
 * The regional summary RPC only ever returns counts, so the names come from the
 * same guarded register RPC the List view uses (`get_agent_directory_v2`). That
 * RPC filters by a free-text term, so the rows it returns are narrowed here to
 * the exact district (and region) the reader clicked — a district name that
 * also appears in someone's name, phone or territory must not leak into the
 * list. Nothing is invented: every row shown came from the server.
 */
function DistrictAgents({
  region,
  district,
  onOpenAgent,
}: {
  region: string;
  district: string;
  onOpenAgent: (id: string) => void;
}) {
  const [pages, setPages] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['agent-directory-district', region, district, pages],
    queryFn: async () => {
      const seen = new Set<string>();
      const exact: DistrictAgent[] = [];
      const districtOnly: DistrictAgent[] = [];
      let exhausted = false;

      for (let i = 0; i < pages; i++) {
        const { data, error } = await supabase.rpc('get_agent_directory_v2' as any, {
          p_search: district,
          p_type: 'all',
          p_status: 'all',
          p_limit: RAW_PAGE,
          p_offset: i * RAW_PAGE,
        });
        if (error) throw error;

        const rows = ((data as any)?.rows ?? []) as DistrictAgent[];
        for (const r of rows) {
          if (!r?.id || seen.has(r.id)) continue;
          seen.add(r.id);
          if (r.district !== district) continue;
          if (r.region === region) exact.push(r);
          else districtOnly.push(r);
        }

        if (rows.length < RAW_PAGE) {
          exhausted = true;
          break;
        }
      }

      // Region labels come from the same normalisation on both sides, but if
      // they ever drift the district's own agents are still worth showing
      // rather than an empty panel.
      return { agents: exact.length ? exact : districtOnly, exhausted };
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 px-4 py-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-destructive">
        Couldn&apos;t load the agents in {district}. {(error as any)?.message}
      </div>
    );
  }

  const agents = data?.agents ?? [];
  const capped = pages * RAW_PAGE >= MAX_RAW_PAGES;

  return (
    <div className="bg-background/50">
      <div className="flex items-center justify-between gap-2 px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        <span>
          {agents.length.toLocaleString()} agent{agents.length === 1 ? '' : 's'} in {district}
        </span>
        {isFetching && !isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>

      {agents.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">No agents listed in {district} yet.</p>
      ) : (
        <div className="divide-y divide-border/40">
          {agents.map((a) => (
            <Button
              key={a.id}
              variant="ghost"
              aria-label={`Open profile for ${a.full_name || 'Unknown Agent'}`}
              onClick={() => onOpenAgent(a.id)}
              className="grid h-auto min-h-[88px] w-full grid-cols-[40px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-none px-3 py-4 text-left whitespace-normal active:scale-100 sm:flex sm:min-h-[64px] sm:px-4"
            >
              <AgentAvatar src={a.avatar_url} name={a.full_name} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold break-words text-primary underline underline-offset-4">{a.full_name || 'Unknown Agent'}</span>
                  {a.verified && <ShieldCheck className="h-3 w-3 text-success shrink-0" aria-label="Verified" />}
                  {a.agent_kind === 'sub_agent' && (
                    <Badge variant="secondary" className="text-xs px-1.5 py-0">
                      Sub-Agent
                    </Badge>
                  )}
                </div>
                <span className="mt-1 flex items-center gap-1.5 text-sm font-normal text-muted-foreground break-all">
                  <Phone className="h-3.5 w-3.5 shrink-0" />
                  {a.phone || '—'}
                </span>
              </div>
              <span
                className="col-span-2 col-start-2 flex items-center gap-1.5 text-xs font-normal text-muted-foreground sm:shrink-0"
                title="Tenants"
              >
                <Users className="h-3 w-3" />
                <span className="font-semibold text-foreground">{a.total_tenants}</span><span className="sm:hidden">tenants</span>
              </span>
              <span className="col-span-2 col-start-2 grid min-w-0 gap-1 text-xs tabular-nums font-normal sm:hidden md:grid md:shrink-0 md:text-right">
                <span className={cn('font-semibold', Number(a.collected_today) > 0 ? 'text-success' : 'text-muted-foreground')}>
                  <span className="font-normal text-muted-foreground md:hidden">Today </span>
                  {formatUGX(Number(a.collected_today || 0))}
                </span>
                <span className="text-muted-foreground"><span className="md:hidden">Target </span><span className="hidden md:inline">/ </span>{formatUGX(Number(a.daily_target || 0))}</span>
              </span>
              <span
                className={cn(
                  'col-span-2 col-start-2 text-xs px-2 py-1 rounded-full border capitalize w-fit font-normal sm:shrink-0',
                  STATUS_STYLE[a.status] ?? STATUS_STYLE.inactive,
                )}
              >
                {a.status}
              </span>
              <ChevronRight className="col-start-3 row-start-1 h-4 w-4 text-muted-foreground shrink-0" />
            </Button>
          ))}
        </div>
      )}

      {data && !data.exhausted && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {capped
              ? 'This district has more agents than shown here — use the filter above or the List view.'
              : 'More agents in this district.'}
          </span>
          {!capped && (
            <Button variant="outline" size="sm" className="h-11 min-h-11 text-sm sm:h-9 sm:min-h-9" disabled={isFetching} onClick={() => setPages((p) => p + 2)}>
              {isFetching && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              Load more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A region as a one-tap filter. The agent count rides on the chip itself so
 * the reader can see where the field force actually sits before clicking —
 * typing "Central" into a box only helps once you already know the name.
 */
function AreaChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'default' : 'outline'}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label}: ${count.toLocaleString()} agents${active ? ', selected' : ''}`}
      className={cn(
        'flex min-h-11 h-auto min-w-0 items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm shadow-none sm:justify-center',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      <span className="whitespace-normal break-words text-left">{label}</span>
      <span className="shrink-0 font-semibold tabular-nums">{count.toLocaleString()}</span>
    </Button>
  );
}

export function AgentRegionBreakdown({
  verifiedOnly = false,
  onOpenAgent,
}: {
  verifiedOnly?: boolean;
  onOpenAgent?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [openDistrict, setOpenDistrict] = useState<string | null>(null);
  const [regionFilter, setRegionFilter] = useState<string | null>(null);
  const [districtKey, setDistrictKey] = useState<string | null>(null);

  // The same box also searches the register itself, so an agent can be found
  // by name or phone without knowing their area. Debounced so every keystroke
  // doesn't hit the server.
  const [agentTerm, setAgentTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setAgentTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error } = useQuery<Row[]>({
    queryKey: ['agent-region-breakdown', verifiedOnly],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_directory_region_breakdown', {
        _verified_only: verifiedOnly,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        region: r.region,
        district: r.district,
        agent_count: Number(r.agent_count ?? 0),
        verified_count: Number(r.verified_count ?? 0),
        active_30d: Number(r.active_30d ?? 0),
      }));
    },
    staleTime: 5 * 60_000,
  });

  // Up to ten agents whose name, phone, district or region matches the term,
  // read through the same guarded register RPC the List view uses.
  const agentSearch = useQuery({
    queryKey: ['agent-region-agent-search', agentTerm],
    enabled: agentTerm.length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_directory_v2' as any, {
        p_search: agentTerm,
        p_type: 'all',
        p_status: 'all',
        p_limit: 10,
        p_offset: 0,
      });
      if (error) throw error;
      const json = (data ?? {}) as any;
      const rows = ((json.rows ?? []) as DistrictAgent[]).filter((a) => !verifiedOnly || a.verified);
      return { total: Number(json.total_matched ?? 0), rows };
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const groups: RegionGroup[] = useMemo(() => {
    const map = new Map<string, RegionGroup>();
    (data ?? []).forEach((r) => {
      const g = map.get(r.region) ?? { region: r.region, total: 0, verified: 0, active: 0, districts: [] };
      g.total += r.agent_count;
      g.verified += r.verified_count;
      g.active += r.active_30d;
      g.districts.push(r);
      map.set(r.region, g);
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [data]);

  const term = search.trim().toLowerCase();

  // Region chips, the district dropdown and the text box narrow the same list,
  // so they compose: pick Central, then a district, and only that district's
  // row is left standing. The counts below always describe what is on screen.
  const filtered = useMemo(() => {
    let out = regionFilter ? groups.filter((g) => g.region === regionFilter) : groups;

    if (term) {
      out = out
        .map((g) => {
          const regionMatches = g.region.toLowerCase().includes(term);
          return {
            ...g,
            districts: regionMatches ? g.districts : g.districts.filter((d) => d.district.toLowerCase().includes(term)),
          };
        })
        .filter((g) => g.districts.length > 0 || g.region.toLowerCase().includes(term));
    }

    if (districtKey) {
      out = out
        .map((g) => ({ ...g, districts: g.districts.filter((d) => `${g.region}::${d.district}` === districtKey) }))
        .filter((g) => g.districts.length > 0);
    }

    return out;
  }, [groups, regionFilter, districtKey, term]);

  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  // Districts the dropdown can offer: the chosen region's own, or every
  // region's when "All regions" is active. Biggest first — that is where the
  // field force actually is.
  const districtOptions = useMemo(() => {
    const source = regionFilter ? groups.filter((g) => g.region === regionFilter) : groups;
    return source
      .flatMap((g) =>
        g.districts.map((d) => ({
          key: `${g.region}::${d.district}`,
          district: d.district,
          region: g.region,
          count: d.agent_count,
        })),
      )
      .sort((a, b) => b.count - a.count);
  }, [groups, regionFilter]);

  const selectedDistrict = useMemo(
    () => districtOptions.find((o) => o.key === districtKey) ?? null,
    [districtOptions, districtKey],
  );

  // Totals for the current view. A region matched by the text box keeps all of
  // its districts, so the region's own total is the truthful number there.
  const scope = useMemo(
    () =>
      filtered.reduce(
        (s, g) => {
          const ds = g.districts.length ? g.districts : null;
          return {
            agents: s.agents + (ds ? ds.reduce((t, d) => t + d.agent_count, 0) : g.total),
            verified: s.verified + (ds ? ds.reduce((t, d) => t + d.verified_count, 0) : g.verified),
            active: s.active + (ds ? ds.reduce((t, d) => t + d.active_30d, 0) : g.active),
          };
        },
        { agents: 0, verified: 0, active: 0 },
      ),
    [filtered],
  );

  const filtering = !!regionFilter || !!districtKey || !!term;
  const scopeLabel = selectedDistrict
    ? `in ${selectedDistrict.district}, ${selectedDistrict.region}`
    : regionFilter
      ? `in ${regionFilter}`
      : `across ${groups.length} region${groups.length === 1 ? '' : 's'}`;

  const pickRegion = (region: string | null) => {
    setRegionFilter(region);
    setDistrictKey(null);
    setOpenDistrict(null);
    if (region) setExpanded((prev) => (prev.has(region) ? prev : new Set(prev).add(region)));
  };

  const pickDistrict = (key: string) => {
    if (key === ALL_DISTRICTS) {
      setDistrictKey(null);
      setOpenDistrict(null);
      return;
    }
    setDistrictKey(key);
    setOpenDistrict(key);
    const region = key.slice(0, key.indexOf('::'));
    setExpanded((prev) => (prev.has(region) ? prev : new Set(prev).add(region)));
  };

  const clearAreaFilters = () => {
    setRegionFilter(null);
    setDistrictKey(null);
    setOpenDistrict(null);
  };

  const toggle = (region: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
  };

  const [exporting, setExporting] = useState(false);
  const handleExportAgents = async () => {
    setExporting(true);
    try {
      const rows: (string | number)[][] = [];
      for (const g of filtered) {
        for (const d of g.districts) {
          const agents = await fetchDistrictAgentsAll(g.region, d.district);
          for (const a of agents) {
            if (verifiedOnly && !a.verified) continue;
            rows.push([
              g.region, d.district, a.full_name ?? '', a.phone ?? '', a.email ?? '',
              a.agent_kind === 'sub_agent' ? 'Sub-agent' : 'Agent', a.verified ? 'Yes' : 'No',
              a.status, a.total_tenants ?? 0, a.daily_target ?? 0, a.collected_today ?? 0,
            ]);
          }
        }
      }
      const area = (regionFilter ?? 'all-regions').toLowerCase().replace(/\s+/g, '-');
      downloadCsv(
        `agents_${area}_${format(new Date(), 'yyyyMMdd-HHmm')}.csv`,
        ['Region', 'District', 'Name', 'Phone', 'Email', 'Type', 'Verified', 'Status', 'Tenants', 'Daily target (UGX)', 'Collected today (UGX)'],
        rows,
      );
    } catch (e) {
      console.error('[AgentRegionBreakdown] agent export failed:', e);
      alert('Could not download the agent list. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const handleExportPdf = () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    doc.setFontSize(14);
    doc.text('Agents by Region & District', 40, 40);
    doc.setFontSize(10);
    doc.text(
      `${grandTotal.toLocaleString()} qualifying agents · ${verifiedOnly ? 'Verified only' : 'All statuses'}`,
      40,
      58,
    );
    autoTable(doc, {
      startY: 74,
      head: [['Region', 'District', 'Agents', 'Verified', 'Active (30d)']],
      body: (data ?? []).map((r) => [
        r.region,
        r.district,
        r.agent_count.toLocaleString(),
        r.verified_count.toLocaleString(),
        r.active_30d.toLocaleString(),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [37, 99, 235] },
      columnStyles: {
        2: { halign: 'right' },
        3: { halign: 'right' },
        4: { halign: 'right' },
      },
    });
    const filename = `agents-by-region_${format(new Date(), 'yyyyMMdd-HHmm')}.pdf`;
    doc.save(filename);

    // Bulk export of every agent grouped by region/district, not logged
    // before this. Plain client-side insert so the audit_logs IP-capture
    // trigger sees the real browser IP directly. Never blocks the actual
    // download.
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        await supabase.from('audit_logs').insert({
          user_id: user?.id ?? null,
          action_type: 'pdf_report_exported',
          table_name: 'export',
          record_id: null,
          metadata: { filename, row_count: (data ?? []).length },
        });
      } catch (e) {
        console.warn('[AgentRegionBreakdown] audit log insert failed:', e);
      }
    })();
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-14 rounded-xl bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-6 text-sm text-destructive">
        Failed to load region breakdown. {(error as any)?.message}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground">
        <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-sm font-medium">No location data yet</p>
        <p className="text-xs mt-1">Agents haven&apos;t set a region or district on their profile.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
        <div className="relative col-span-2 min-w-0 sm:flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by region or district…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter by region or district"
            className="pl-10 pr-12 h-12 text-base sm:h-11 sm:text-sm"
          />
          {search && (
            <Button variant="ghost" size="icon"
              onClick={() => setSearch('')}
              className="absolute right-0.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-11 min-h-11 text-sm gap-1.5" onClick={handleExportPdf}>
          <FileDown className="h-3.5 w-3.5" />
          PDF
        </Button>
        <Button variant="outline" size="sm" className="h-11 min-h-11 text-sm gap-1.5" onClick={handleExportAgents} disabled={exporting || filtered.length === 0} aria-label="Download agent list">
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
          Agents CSV
        </Button>
      </div>

      {/* Area filters. The region chips carry their own agent count, so the
          reader can see where the field force sits before clicking anything,
          and the dropdown goes straight to a district inside the chosen area. */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center" role="group" aria-label="Filter by region">
          <AreaChip label="All regions" count={grandTotal} active={!regionFilter} onClick={() => pickRegion(null)} />
          {groups.map((g) => (
            <AreaChip
              key={g.region}
              label={g.region}
              count={g.total}
              active={regionFilter === g.region}
              onClick={() => pickRegion(g.region)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={districtKey ?? ALL_DISTRICTS} onValueChange={pickDistrict}>
            <SelectTrigger aria-label="Filter by district" className="h-12 w-full min-w-0 text-base sm:h-11 sm:w-[280px] sm:text-sm [&>span]:truncate">
              <SelectValue placeholder="All districts" />
            </SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">
              <SelectItem className="min-h-11 text-sm" value={ALL_DISTRICTS}>All districts</SelectItem>
              {districtOptions.map((o) => (
                <SelectItem className="min-h-11 text-sm [&>span:last-child]:whitespace-normal [&>span:last-child]:break-words" key={o.key} value={o.key}>
                  {o.district}
                  {!regionFilter && <span className="text-muted-foreground"> · {o.region}</span>}
                  <span className="ml-2 tabular-nums text-muted-foreground">{o.count.toLocaleString()}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {filtering && (
            <Button variant="ghost" size="sm" className="h-11 min-h-11 text-sm" onClick={clearAreaFilters}>
              <X className="h-3.5 w-3.5 mr-1" />
              Clear area
            </Button>
          )}
        </div>
      </div>

      <div className="text-sm leading-relaxed text-muted-foreground break-words">
        <span className="font-semibold text-foreground">{scope.agents.toLocaleString()}</span> agents {scopeLabel}
        {filtering && (
          <>
            {' · '}
            <span className="font-semibold text-foreground">{scope.verified.toLocaleString()}</span> verified
            {' · '}
            <span className="font-semibold text-foreground">{scope.active.toLocaleString()}</span> active in 30 days
          </>
        )}
      </div>

      <div className="space-y-1.5">
        {filtered.map((g) => {
          const isOpen = expanded.has(g.region) || !!term;
          const share = grandTotal > 0 ? (g.total / grandTotal) * 100 : 0;
          return (
            <div key={g.region} className="rounded-lg border border-border bg-card overflow-hidden">
              <Button variant="ghost"
                type="button"
                onClick={() => toggle(g.region)}
                className="h-auto min-h-[64px] w-full flex items-center gap-2 rounded-none p-3 hover:bg-muted/50 text-left whitespace-normal active:scale-100"
                aria-expanded={isOpen}
                aria-label={`${g.region} region, ${g.total.toLocaleString()} agents`}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <MapPin className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold break-words">{g.region}</span>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {share.toFixed(1)}%
                    </span>
                  </div>
                  <div className="mt-1 h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary/70"
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className="flex items-center gap-1 text-foreground font-semibold">
                    <Users className="h-3 w-3 text-muted-foreground" />
                    {g.total.toLocaleString()}
                  </span>
                  <span className="hidden sm:flex items-center gap-1 text-emerald-600">
                    <ShieldCheck className="h-3 w-3" />
                    {g.verified.toLocaleString()}
                  </span>
                  <span className="hidden sm:flex items-center gap-1 text-blue-600">
                    <Activity className="h-3 w-3" />
                    {g.active.toLocaleString()}
                  </span>
                </div>
              </Button>
              {isOpen && (
                <div className="border-t border-border/60 bg-muted/20 divide-y divide-border/40">
                  {g.districts
                    .slice()
                    .sort((a, b) => b.agent_count - a.agent_count)
                    .map((d) => {
                      const key = `${g.region}::${d.district}`;
                      const districtOpen = openDistrict === key;
                      return (
                        <div key={key}>
                          <Button variant="ghost"
                            type="button"
                            onClick={() => setOpenDistrict(districtOpen ? null : key)}
                            aria-expanded={districtOpen}
                            aria-label={`${d.district} district, ${d.agent_count.toLocaleString()} agents`}
                            className="h-auto min-h-12 w-full flex items-center gap-2 rounded-none px-3 py-3 text-sm font-normal hover:bg-muted/60 text-left whitespace-normal active:scale-100 sm:px-4"
                          >
                            {onOpenAgent ? (
                              districtOpen ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              )
                            ) : (
                              <span className="w-3 shrink-0" />
                            )}
                            <span className="min-w-0 flex-1 break-words text-foreground">{d.district}</span>
                            <Badge variant="secondary" className="text-xs gap-1 shrink-0">
                              <Users className="h-3 w-3" />
                              {d.agent_count.toLocaleString()}
                            </Badge>
                            <span className="hidden sm:flex items-center gap-1 text-emerald-600 w-14 justify-end">
                              <ShieldCheck className="h-3 w-3" />
                              {d.verified_count.toLocaleString()}
                            </span>
                            <span className="hidden sm:flex items-center gap-1 text-blue-600 w-14 justify-end">
                              <Activity className="h-3 w-3" />
                              {d.active_30d.toLocaleString()}
                            </span>
                          </Button>
                          {districtOpen && onOpenAgent && (
                            <DistrictAgents
                              region={g.region}
                              district={d.district}
                              onOpenAgent={onOpenAgent}
                            />
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

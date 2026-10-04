import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronRight, MapPin, Users, ShieldCheck, Activity, Search, X, FileDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';

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

export function AgentRegionBreakdown({ verifiedOnly = false }: { verifiedOnly?: boolean }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

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
  const filtered = useMemo(() => {
    if (!term) return groups;
    return groups
      .map((g) => ({
        ...g,
        districts: g.districts.filter(
          (d) => d.district.toLowerCase().includes(term) || g.region.toLowerCase().includes(term),
        ),
      }))
      .filter((g) => g.districts.length > 0 || g.region.toLowerCase().includes(term));
  }, [groups, term]);

  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  const toggle = (region: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
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
        <p className="text-xs mt-1">Agents haven't set a region or district on their profile.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by region or district…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 pr-10 h-9 text-sm"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-9 text-xs gap-1.5" onClick={handleExportPdf}>
          <FileDown className="h-3.5 w-3.5" />
          PDF
        </Button>
      </div>

      <div className="text-[11px] text-muted-foreground">
        <span className="font-semibold text-foreground">{grandTotal.toLocaleString()}</span> agents across{' '}
        <span className="font-semibold text-foreground">{groups.length}</span> region{groups.length === 1 ? '' : 's'}
      </div>

      <div className="space-y-1.5">
        {filtered.map((g) => {
          const isOpen = expanded.has(g.region) || !!term;
          const share = grandTotal > 0 ? (g.total / grandTotal) * 100 : 0;
          return (
            <div key={g.region} className="rounded-xl border border-border bg-card overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(g.region)}
                className="w-full flex items-center gap-2 p-2.5 hover:bg-muted/50 transition-colors text-left"
                aria-expanded={isOpen}
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <MapPin className="h-4 w-4 text-primary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold truncate">{g.region}</span>
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
              </button>
              {isOpen && (
                <div className="border-t border-border/60 bg-muted/20 divide-y divide-border/40">
                  {g.districts
                    .slice()
                    .sort((a, b) => b.agent_count - a.agent_count)
                    .map((d) => (
                      <div
                        key={`${g.region}::${d.district}`}
                        className="flex items-center gap-2 px-4 py-2 text-xs"
                      >
                        <span className="flex-1 truncate text-foreground">{d.district}</span>
                        <Badge variant="secondary" className="text-[10px] gap-1">
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
                      </div>
                    ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
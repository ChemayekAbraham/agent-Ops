import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  Loader2, Landmark, Search, CalendarIcon, ArrowRight, Banknote, HandCoins,
  Building2, Phone, Hash, Copy, CheckCircle2, X, Clock, Bookmark, Save, Trash2, ChevronsUpDown,
  AlertCircle, ChevronRight, MapPin, Wallet, FileText, Download, AlertTriangle, Flame
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/exportUtils';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

// ───── Inline multi-select with search + checkboxes (Popover-based) ─────
interface MultiSelectFilterProps {
  label: string;
  allLabel: string;
  options: Array<[string, string]>; // [key, displayLabel]
  selected: string[];
  onChange: (next: string[]) => void;
  width?: string;
}
function MultiSelectFilter({ label, allLabel, options, selected, onChange, width = 'w-[200px]' }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(([, lbl]) => lbl.toLowerCase().includes(needle));
  }, [options, q]);
  const labelForKey = (k: string) => options.find(([key]) => key === k)?.[1] || k;
  const toggle = (key: string) => {
    onChange(selectedSet.has(key) ? selected.filter((s) => s !== key) : [...selected, key]);
  };
  const triggerText =
    selected.length === 0
      ? `${allLabel} (${options.length})`
      : selected.length === 1
      ? labelForKey(selected[0])
      : `${label}: ${selected.length} selected`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 justify-between text-xs gap-2', width, selected.length === 0 && 'text-muted-foreground')}
        >
          <span className="truncate">{triggerText}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[280px]">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
            <span>{selected.length} of {options.length} selected</span>
            <div className="flex gap-2">
              <button
                type="button"
                className="hover:text-foreground disabled:opacity-40"
                disabled={filtered.length === 0}
                onClick={() => {
                  const visible = new Set(filtered.map(([k]) => k));
                  const merged = Array.from(new Set([...selected, ...visible]));
                  onChange(merged);
                }}
              >
                Select all
              </button>
              <button
                type="button"
                className="hover:text-foreground disabled:opacity-40"
                disabled={selected.length === 0}
                onClick={() => onChange([])}
              >
                Clear
              </button>
            </div>
          </div>
        </div>
        <div className="max-h-[260px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-[11px] text-center text-muted-foreground">No matches</p>
          ) : (
            filtered.map(([key, lbl]) => {
              const isOn = selectedSet.has(key);
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggle(key)}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-muted',
                    isOn && 'bg-[#9234EA]/5',
                  )}
                >
                  <Checkbox checked={isOn} className="h-3.5 w-3.5 pointer-events-none" />
                  <span className="truncate">{lbl}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type EventKind = 'funding' | 'allocation' | 'payout';

interface TimelineEvent {
  id: string;
  kind: EventKind;
  at: string;                 // ISO date
  amount: number;
  agent_id: string;
  agent_name: string;
  tenant_id?: string | null;
  tenant_name?: string | null;
  landlord_name?: string | null;
  landlord_phone?: string | null;
  status: string;
  reference: string | null;   // bank TID / MoMo TID / allocation id
  reference_label: string;    // "Bank TID" / "MoMo TID" / "Allocation ID"
  source_table: string;
  notes?: string | null;
  // Outstanding only meaningful for allocation rows.
  outstanding?: number;
  allocated_amount?: number;
  paid_out_amount?: number;
  raw?: any;                  // full DB row for drill-down
}

/**
 * Tenant Ops timeline of landlord-payout float movements.
 * Merges 3 event streams (READ-ONLY):
 *   1. CFO → agent fundings     (`agent_float_funding`, ref = bank TID)
 *   2. Per-tenant earmarks      (`agent_landlord_float_allocations`, ref = allocation UUID)
 *   3. Agent → landlord payouts (`agent_float_withdrawals`, ref = MoMo TID)
 * Filterable by date range + free-text search across reference IDs and party names.
 */
export function TenantOpsLandlordFloatTimeline() {
  const [from, setFrom] = useState<Date | undefined>(undefined);
  const [to, setTo] = useState<Date | undefined>(undefined);
  const [search, setSearch] = useState('');
  // Empty array = "All"; otherwise filter to selected keys (OR-include)
  const [agentFilter, setAgentFilter] = useState<string[]>([]);
  const [tenantFilter, setTenantFilter] = useState<string[]>([]);
  const [landlordFilter, setLandlordFilter] = useState<string[]>([]);
  const [outstandingOnly, setOutstandingOnly] = useState(false);

  // ───────────────────── Presets (localStorage) ─────────────────────
  interface Preset {
    id: string;
    name: string;
    from: string | null;   // ISO
    to: string | null;     // ISO
    search: string;
    agentFilter: string[];
    tenantFilter: string[];
    landlordFilter: string[];
  }
  const PRESETS_KEY = 'tenant-ops-float-timeline-presets-v2';
  const ACTIVE_KEY = 'tenant-ops-float-timeline-active-preset-v2';
  const LEGACY_PRESETS_KEY = 'tenant-ops-float-timeline-presets-v1';
  const LEGACY_ACTIVE_KEY = 'tenant-ops-float-timeline-active-preset-v1';
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>('');
  const [presetName, setPresetName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  // Drill-down dialog
  const [drillEvent, setDrillEvent] = useState<TimelineEvent | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PRESETS_KEY);
      if (raw) {
        setPresets(JSON.parse(raw));
      } else {
        // One-time migration from v1 single-select presets
        const legacy = localStorage.getItem(LEGACY_PRESETS_KEY);
        if (legacy) {
          const parsed = JSON.parse(legacy) as Array<any>;
          const migrated: Preset[] = parsed.map((p) => ({
            id: p.id,
            name: p.name,
            from: p.from ?? null,
            to: p.to ?? null,
            search: p.search ?? '',
            agentFilter: p.agentFilter && p.agentFilter !== 'all' ? [p.agentFilter] : [],
            tenantFilter: p.tenantFilter && p.tenantFilter !== 'all' ? [p.tenantFilter] : [],
            landlordFilter: p.landlordFilter && p.landlordFilter !== 'all' ? [p.landlordFilter] : [],
          }));
          setPresets(migrated);
          try { localStorage.setItem(PRESETS_KEY, JSON.stringify(migrated)); } catch { /* quota */ }
        }
      }
      const active = localStorage.getItem(ACTIVE_KEY) || localStorage.getItem(LEGACY_ACTIVE_KEY);
      if (active) setActivePresetId(active);
    } catch { /* ignore corrupt storage */ }
  }, []);

  const persistPresets = (next: Preset[]) => {
    setPresets(next);
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(next)); } catch { /* quota */ }
  };

  const applyPreset = (p: Preset) => {
    setFrom(p.from ? new Date(p.from) : undefined);
    setTo(p.to ? new Date(p.to) : undefined);
    setSearch(p.search || '');
    setAgentFilter(Array.isArray(p.agentFilter) ? p.agentFilter : []);
    setTenantFilter(Array.isArray(p.tenantFilter) ? p.tenantFilter : []);
    setLandlordFilter(Array.isArray(p.landlordFilter) ? p.landlordFilter : []);
    setActivePresetId(p.id);
    try { localStorage.setItem(ACTIVE_KEY, p.id); } catch { /* ignore */ }
    toast.success(`Loaded preset: ${p.name}`);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) { toast.error('Name required'); return; }
    const existing = presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const id = existing?.id || `pst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const snap: Preset = {
      id,
      name,
      from: from ? from.toISOString() : null,
      to: to ? to.toISOString() : null,
      search,
      agentFilter,
      tenantFilter,
      landlordFilter,
    };
    const next = existing
      ? presets.map((p) => (p.id === id ? snap : p))
      : [...presets, snap];
    persistPresets(next);
    setActivePresetId(id);
    try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
    setPresetName('');
    setSaveOpen(false);
    toast.success(existing ? `Updated preset: ${name}` : `Saved preset: ${name}`);
  };

  const deletePreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    persistPresets(presets.filter((x) => x.id !== id));
    if (activePresetId === id) {
      setActivePresetId('');
      try { localStorage.removeItem(ACTIVE_KEY); } catch { /* ignore */ }
    }
    if (p) toast.success(`Deleted preset: ${p.name}`);
  };

  const hasAnyFilter =
    !!from || !!to || !!search.trim() ||
    agentFilter.length > 0 || tenantFilter.length > 0 || landlordFilter.length > 0;

  const fromIso = from ? new Date(new Date(from).setHours(0, 0, 0, 0)).toISOString() : null;
  const toIso = to ? new Date(new Date(to).setHours(23, 59, 59, 999)).toISOString() : null;

  const { data: events = [], isLoading } = useQuery({
    queryKey: ['tenant-ops-landlord-float-timeline', fromIso, toIso],
    queryFn: async (): Promise<TimelineEvent[]> => {
      const applyRange = (q: any, col: string) => {
        if (fromIso) q = q.gte(col, fromIso);
        if (toIso) q = q.lte(col, toIso);
        return q;
      };

      const [fundRes, allocRes, payRes] = await Promise.all([
        applyRange(
          supabase
            .from('agent_float_funding' as any)
            .select('id, agent_id, amount, created_at, bank_reference, bank_name, notes, status')
            .order('created_at', { ascending: false })
            .limit(500),
          'created_at',
        ),
        applyRange(
          supabase
            .from('agent_landlord_float_allocations' as any)
            .select('id, agent_id, tenant_id, landlord_name, landlord_phone, allocated_amount, status, created_at, notes')
            .order('created_at', { ascending: false })
            .limit(500),
          'created_at',
        ),
        applyRange(
          supabase
            .from('agent_float_withdrawals' as any)
            .select('id, agent_id, tenant_id, landlord_name, landlord_phone, amount, transaction_id, status, created_at, notes')
            .order('created_at', { ascending: false })
            .limit(500),
          'created_at',
        ),
      ]);
      if (fundRes.error) throw fundRes.error;
      if (allocRes.error) throw allocRes.error;
      if (payRes.error) throw payRes.error;

      const fundings = (fundRes.data ?? []) as any[];
      const allocs = (allocRes.data ?? []) as any[];
      const pays = (payRes.data ?? []) as any[];

      // Resolve names once
      const ids = new Set<string>();
      for (const r of fundings) if (r.agent_id) ids.add(r.agent_id);
      for (const r of allocs) {
        if (r.agent_id) ids.add(r.agent_id);
        if (r.tenant_id) ids.add(r.tenant_id);
      }
      for (const r of pays) {
        if (r.agent_id) ids.add(r.agent_id);
        if (r.tenant_id) ids.add(r.tenant_id);
      }
      const nameMap = new Map<string, string>();
      if (ids.size) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', [...ids]);
        for (const p of profs || []) nameMap.set(p.id, p.full_name || 'Unknown');
      }

      const fundingEvents: TimelineEvent[] = fundings.map((r) => ({
        id: `fund:${r.id}`,
        kind: 'funding',
        at: r.created_at,
        amount: Number(r.amount) || 0,
        agent_id: r.agent_id,
        agent_name: nameMap.get(r.agent_id) || 'Unknown Agent',
        status: r.status || 'completed',
        reference: r.bank_reference || null,
        reference_label: `Bank TID${r.bank_name ? ` · ${r.bank_name}` : ''}`,
        source_table: 'agent_float_funding',
        notes: r.notes,
        raw: r,
      }));

      const allocationEvents: TimelineEvent[] = allocs.map((r) => ({
        id: `alloc:${r.id}`,
        kind: 'allocation',
        at: r.created_at,
        amount: Number(r.allocated_amount) || 0,
        agent_id: r.agent_id,
        agent_name: nameMap.get(r.agent_id) || 'Unknown Agent',
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_id ? nameMap.get(r.tenant_id) || 'Unknown Tenant' : null,
        landlord_name: r.landlord_name,
        landlord_phone: r.landlord_phone,
        status: r.status || 'open',
        reference: r.id,
        reference_label: 'Allocation ID',
        source_table: 'agent_landlord_float_allocations',
        notes: r.notes,
        allocated_amount: Number(r.allocated_amount) || 0,
        paid_out_amount: Number(r.paid_out_amount) || 0,
        outstanding: Math.max(0, Number(r.remaining_amount ?? (Number(r.allocated_amount || 0) - Number(r.paid_out_amount || 0))) || 0),
        raw: r,
      }));

      const payoutEvents: TimelineEvent[] = pays.map((r) => ({
        id: `pay:${r.id}`,
        kind: 'payout',
        at: r.created_at,
        amount: Number(r.amount) || 0,
        agent_id: r.agent_id,
        agent_name: nameMap.get(r.agent_id) || 'Unknown Agent',
        tenant_id: r.tenant_id,
        tenant_name: r.tenant_id ? nameMap.get(r.tenant_id) || 'Unknown Tenant' : null,
        landlord_name: r.landlord_name,
        landlord_phone: r.landlord_phone,
        status: r.status || 'pending',
        reference: r.transaction_id || null,
        reference_label: 'MoMo TID',
        source_table: 'agent_float_withdrawals',
        notes: r.notes,
        raw: r,
      }));

      return [...fundingEvents, ...allocationEvents, ...payoutEvents].sort(
        (a, b) => +new Date(b.at) - +new Date(a.at),
      );
    },
    staleTime: 30_000,
  });

  // Build distinct option lists from the loaded events
  const { agentOptions, tenantOptions, landlordOptions } = useMemo(() => {
    const agents = new Map<string, string>();
    const tenants = new Map<string, string>();
    const landlords = new Map<string, string>(); // key = name|phone
    for (const e of events) {
      if (e.agent_id) agents.set(e.agent_id, e.agent_name || 'Unknown Agent');
      if (e.tenant_id) tenants.set(e.tenant_id, e.tenant_name || 'Unknown Tenant');
      if (e.landlord_name || e.landlord_phone) {
        const key = `${e.landlord_name || ''}|${e.landlord_phone || ''}`;
        const label = e.landlord_name
          ? `${e.landlord_name}${e.landlord_phone ? ` · ${e.landlord_phone}` : ''}`
          : (e.landlord_phone as string);
        landlords.set(key, label);
      }
    }
    const sortByLabel = (a: [string, string], b: [string, string]) => a[1].localeCompare(b[1]);
    return {
      agentOptions: [...agents.entries()].sort(sortByLabel),
      tenantOptions: [...tenants.entries()].sort(sortByLabel),
      landlordOptions: [...landlords.entries()].sort(sortByLabel),
    };
  }, [events]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const agentSet = new Set(agentFilter);
    const tenantSet = new Set(tenantFilter);
    const landlordSet = new Set(landlordFilter);
    return events.filter((e) => {
      if (outstandingOnly) {
        if (e.kind !== 'allocation' || !((e.outstanding || 0) > 0)) return false;
      }
      if (agentSet.size > 0 && !agentSet.has(e.agent_id)) return false;
      if (tenantSet.size > 0 && (!e.tenant_id || !tenantSet.has(e.tenant_id))) return false;
      if (landlordSet.size > 0) {
        const key = `${e.landlord_name || ''}|${e.landlord_phone || ''}`;
        if (!landlordSet.has(key)) return false;
      }
      if (!q) return true;
      return [
        e.reference,
        e.agent_name,
        e.tenant_name,
        e.landlord_name,
        e.landlord_phone,
        e.status,
        e.kind,
        e.notes,
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [events, search, agentFilter, tenantFilter, landlordFilter, outstandingOnly]);

  // Group by calendar day
  const grouped = useMemo(() => {
    const m = new Map<string, TimelineEvent[]>();
    for (const e of filtered) {
      const day = format(new Date(e.at), 'yyyy-MM-dd');
      const arr = m.get(day) || [];
      arr.push(e);
      m.set(day, arr);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  const totals = useMemo(() => {
    let funded = 0, allocated = 0, paid = 0, outstanding = 0;
    let overdueCount = 0, criticalCount = 0;
    const now = Date.now();
    for (const e of filtered) {
      if (e.kind === 'funding') funded += e.amount;
      else if (e.kind === 'allocation') {
        allocated += e.amount;
        outstanding += e.outstanding || 0;
        if ((e.outstanding || 0) > 0) {
          const ageDays = (now - new Date(e.at).getTime()) / 86_400_000;
          if (ageDays >= 7) overdueCount++;
          if (ageDays >= 14 || (e.outstanding || 0) >= 1_000_000) criticalCount++;
        }
      }
      else if (e.kind === 'payout') paid += e.amount;
    }
    return { funded, allocated, paid, outstanding, overdueCount, criticalCount, count: filtered.length };
  }, [filtered]);

  const copyRef = async (ref: string) => {
    try {
      await navigator.clipboard.writeText(ref);
      toast.success('Reference copied');
    } catch {
      toast.error('Copy failed');
    }
  };

  const kindMeta: Record<EventKind, { label: string; icon: React.ElementType; color: string; dot: string }> = {
    funding:    { label: 'CFO Funding',          icon: Banknote,  color: 'bg-blue-100 text-blue-700 border-blue-200',     dot: 'bg-blue-500' },
    allocation: { label: 'Tenant Earmark',       icon: Building2, color: 'bg-fuchsia-100 text-fuchsia-700 border-fuchsia-200', dot: 'bg-fuchsia-500' },
    payout:     { label: 'Landlord Payout',      icon: HandCoins, color: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  };

  // ───── Priority for allocations with outstanding balance ─────
  type Priority = {
    level: 'low' | 'medium' | 'high' | 'critical';
    label: string;
    ageDays: number;
    badgeClass: string;
    borderClass: string;
    icon: React.ElementType;
  };
  const priorityFor = (e: TimelineEvent): Priority | null => {
    if (e.kind !== 'allocation' || !((e.outstanding || 0) > 0)) return null;
    const ageDays = (Date.now() - new Date(e.at).getTime()) / 86_400_000;
    const big = (e.outstanding || 0) >= 1_000_000;
    if (ageDays >= 14 || big) {
      return { level: 'critical', label: 'Critical', ageDays, icon: Flame,
        badgeClass: 'bg-red-100 text-red-800 border-red-300',
        borderClass: 'border-l-4 border-l-red-500' };
    }
    if (ageDays >= 7) {
      return { level: 'high', label: 'Overdue', ageDays, icon: AlertTriangle,
        badgeClass: 'bg-orange-100 text-orange-800 border-orange-300',
        borderClass: 'border-l-4 border-l-orange-500' };
    }
    if (ageDays >= 3) {
      return { level: 'medium', label: 'Aging', ageDays, icon: AlertTriangle,
        badgeClass: 'bg-amber-100 text-amber-800 border-amber-300',
        borderClass: 'border-l-4 border-l-amber-500' };
    }
    return { level: 'low', label: 'Open', ageDays, icon: AlertCircle,
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
      borderClass: 'border-l-2 border-l-amber-300' };
  };

  // ───────────────────── Exports (respect current filters) ─────────────────────
  const exportFilenameBase = () => {
    const parts = ['float-timeline'];
    if (from) parts.push(format(from, 'yyyyMMdd'));
    if (to) parts.push(format(to, 'yyyyMMdd'));
    return parts.join('_');
  };
  const filterSummaryLines = () => {
    const lines: string[] = [];
    lines.push(`Date range: ${from ? format(from, 'dd MMM yyyy') : '—'} → ${to ? format(to, 'dd MMM yyyy') : '—'}`);
    if (search.trim()) lines.push(`Search: "${search.trim()}"`);
    if (agentFilter.length) lines.push(`Agents: ${agentFilter.map((k) => agentOptions.find(([x]) => x === k)?.[1] || k).join(', ')}`);
    if (tenantFilter.length) lines.push(`Tenants: ${tenantFilter.map((k) => tenantOptions.find(([x]) => x === k)?.[1] || k).join(', ')}`);
    if (landlordFilter.length) lines.push(`Landlords: ${landlordFilter.map((k) => landlordOptions.find(([x]) => x === k)?.[1] || k).join(', ')}`);
    return lines;
  };
  const exportCsv = () => {
    if (filtered.length === 0) { toast.error('Nothing to export'); return; }
    const rows = filtered.map((e) => [
      format(new Date(e.at), 'yyyy-MM-dd HH:mm'),
      kindMeta[e.kind].label,
      e.amount,
      e.outstanding ?? '',
      e.status,
      e.agent_name || '',
      e.tenant_name || '',
      e.landlord_name || '',
      e.landlord_phone || '',
      e.reference_label,
      e.reference || '',
      e.source_table,
      e.notes || '',
    ]);
    exportToCSV(
      {
        headers: ['Date', 'Event', 'Amount (UGX)', 'Outstanding (UGX)', 'Status', 'Agent', 'Tenant', 'Landlord', 'Landlord Phone', 'Reference Type', 'Reference', 'Source', 'Notes'],
        rows,
      },
      exportFilenameBase(),
    );
    toast.success(`Exported ${filtered.length} events to CSV`);
  };
  const exportPdf = async () => {
    if (filtered.length === 0) { toast.error('Nothing to export'); return; }
    try {
      const { jsPDF } = await import('jspdf');
      const autoTableMod: any = await import('jspdf-autotable');
      const autoTable = autoTableMod.default || autoTableMod;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      doc.setFontSize(14);
      doc.text('Landlord Float Allocation Timeline', 40, 36);
      doc.setFontSize(9);
      doc.setTextColor(110);
      const summary = filterSummaryLines();
      summary.forEach((ln, i) => doc.text(ln, 40, 52 + i * 12));
      const totalsLine = `Events: ${totals.count}  ·  CFO Funded: ${fmt(totals.funded)}  ·  Earmarked: ${fmt(totals.allocated)}  ·  Paid: ${fmt(totals.paid)}  ·  Outstanding: ${fmt(totals.outstanding)}`;
      doc.text(totalsLine, 40, 52 + summary.length * 12);
      const startY = 60 + summary.length * 12 + 8;
      autoTable(doc, {
        startY,
        head: [['Date', 'Event', 'Amount', 'Outstanding', 'Status', 'Agent', 'Tenant', 'Landlord', 'Ref Type', 'Reference']],
        body: filtered.map((e) => [
          format(new Date(e.at), 'yyyy-MM-dd HH:mm'),
          kindMeta[e.kind].label,
          fmt(e.amount),
          e.kind === 'allocation' ? fmt(e.outstanding || 0) : '—',
          e.status,
          e.agent_name || '',
          e.tenant_name || '',
          [e.landlord_name, e.landlord_phone].filter(Boolean).join(' · '),
          e.reference_label,
          e.reference || '',
        ]),
        styles: { fontSize: 7, cellPadding: 3, overflow: 'linebreak' },
        headStyles: { fillColor: [146, 52, 234], textColor: 255 },
        alternateRowStyles: { fillColor: [248, 245, 255] },
        margin: { left: 40, right: 40 },
        didDrawPage: () => {
          const pageCount = (doc as any).internal.getNumberOfPages();
          const cur = (doc as any).internal.getCurrentPageInfo().pageNumber;
          doc.setFontSize(8);
          doc.setTextColor(140);
          doc.text(
            `Generated ${format(new Date(), 'yyyy-MM-dd HH:mm')} · Page ${cur} of ${pageCount}`,
            pageWidth - 40,
            doc.internal.pageSize.getHeight() - 18,
            { align: 'right' },
          );
        },
      });
      doc.save(`${exportFilenameBase()}_${format(new Date(), 'yyyyMMdd')}.pdf`);
      toast.success(`Exported ${filtered.length} events to PDF`);
    } catch (err) {
      console.error(err);
      toast.error('PDF export failed');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Landmark className="h-4 w-4 text-[#9234EA]" />
          Landlord Float Allocation Timeline
          {filtered.length > 0 && (
            <Badge variant="outline" className="text-[10px] ml-1 bg-[#9234EA]/10 text-[#9234EA] border-[#9234EA]/30">
              {totals.count} events
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Full audit trail: CFO fundings → per-tenant earmarks → agent MoMo payouts. Filter by date and search by reference ID (Bank TID, MoMo TID, allocation UUID) or party name.
        </p>
      </CardHeader>
      <CardContent>
        {/* Controls */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by TID, allocation ID, agent, tenant, landlord…"
              className="pl-8 h-9 text-sm"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn('h-9 gap-2', !from && 'text-muted-foreground')}>
                <CalendarIcon className="h-3.5 w-3.5" />
                {from ? format(from, 'dd MMM yy') : 'From'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={from} onSelect={setFrom} initialFocus />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className={cn('h-9 gap-2', !to && 'text-muted-foreground')}>
                <CalendarIcon className="h-3.5 w-3.5" />
                {to ? format(to, 'dd MMM yy') : 'To'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar mode="single" selected={to} onSelect={setTo} initialFocus />
            </PopoverContent>
          </Popover>
          {(from || to) && (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => { setFrom(undefined); setTo(undefined); }}>
              Clear dates
            </Button>
          )}
          <Button
            variant={outstandingOnly ? 'default' : 'outline'}
            size="sm"
            className={cn('h-9 gap-1.5', outstandingOnly && 'bg-amber-500 hover:bg-amber-600 text-white border-amber-500')}
            onClick={() => setOutstandingOnly((v) => !v)}
            title="Show only allocations with a positive outstanding balance"
            aria-pressed={outstandingOnly}
          >
            <AlertCircle className="h-3.5 w-3.5" />
            Outstanding only
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={exportCsv}
              disabled={filtered.length === 0}
              title="Export current filtered view to CSV"
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={exportPdf}
              disabled={filtered.length === 0}
              title="Export current filtered view to PDF"
            >
              <FileText className="h-3.5 w-3.5" />
              PDF
            </Button>
          </div>
        </div>

        {/* Presets bar */}
        <div className="flex flex-wrap items-center gap-2 mb-3 rounded-lg border border-dashed border-[#9234EA]/30 bg-[#9234EA]/5 p-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[#9234EA] uppercase tracking-wider px-1">
            <Bookmark className="h-3.5 w-3.5" />
            Presets
          </div>
          {presets.length === 0 ? (
            <span className="text-[11px] text-muted-foreground italic">No presets yet — set some filters and save.</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    'group inline-flex items-center gap-1 rounded-full border bg-background text-xs pl-2.5 pr-1 py-0.5 transition',
                    activePresetId === p.id
                      ? 'border-[#9234EA] ring-1 ring-[#9234EA]/40 text-[#9234EA] font-semibold'
                      : 'border-border hover:border-[#9234EA]/50',
                  )}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1"
                    onClick={() => applyPreset(p)}
                    title="Apply preset"
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(p.id)}
                    className="ml-1 rounded-full p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    aria-label={`Delete preset ${p.name}`}
                    title="Delete preset"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Popover open={saveOpen} onOpenChange={setSaveOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  disabled={!hasAnyFilter}
                  title={hasAnyFilter ? 'Save current filters as preset' : 'Set at least one filter first'}
                >
                  <Save className="h-3 w-3" /> Save current
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3">
                <p className="text-xs font-semibold mb-1.5">Save filter preset</p>
                <Input
                  autoFocus
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') savePreset(); }}
                  placeholder="e.g. Kampala overdue"
                  className="h-8 text-xs"
                />
                <div className="flex justify-end gap-1.5 mt-2">
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setSaveOpen(false); setPresetName(''); }}>
                    Cancel
                  </Button>
                  <Button size="sm" className="h-7 text-xs" onClick={savePreset}>
                    Save
                  </Button>
                </div>
                {presets.some((p) => p.name.toLowerCase() === presetName.trim().toLowerCase()) && presetName.trim() && (
                  <p className="text-[10px] text-amber-600 mt-1.5">Existing preset with this name will be overwritten.</p>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Party filters */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <MultiSelectFilter
            label="Agents"
            allLabel="All agents"
            options={agentOptions}
            selected={agentFilter}
            onChange={setAgentFilter}
            width="w-[200px]"
          />
          <MultiSelectFilter
            label="Tenants"
            allLabel="All tenants"
            options={tenantOptions}
            selected={tenantFilter}
            onChange={setTenantFilter}
            width="w-[200px]"
          />
          <MultiSelectFilter
            label="Landlords"
            allLabel="All landlords"
            options={landlordOptions}
            selected={landlordFilter}
            onChange={setLandlordFilter}
            width="w-[240px]"
          />
          {(agentFilter.length > 0 || tenantFilter.length > 0 || landlordFilter.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              onClick={() => { setAgentFilter([]); setTenantFilter([]); setLandlordFilter([]); }}
            >
              Clear party filters
            </Button>
          )}
        </div>

        {/* Selected-party chips (removable) */}
        {(agentFilter.length + tenantFilter.length + landlordFilter.length) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mr-1">
              Active:
            </span>
            {agentFilter.map((id) => {
              const label = agentOptions.find(([k]) => k === id)?.[1] || id;
              return (
                <button
                  key={`agent-${id}`}
                  type="button"
                  onClick={() => setAgentFilter(agentFilter.filter((x) => x !== id))}
                  className="group inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 text-blue-700 text-[11px] pl-2 pr-1 py-0.5 hover:bg-blue-100"
                  title="Remove agent filter"
                >
                  <span className="text-[9px] uppercase tracking-wider opacity-60">Agent</span>
                  <span className="font-medium truncate max-w-[140px]">{label}</span>
                  <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                </button>
              );
            })}
            {tenantFilter.map((id) => {
              const label = tenantOptions.find(([k]) => k === id)?.[1] || id;
              return (
                <button
                  key={`tenant-${id}`}
                  type="button"
                  onClick={() => setTenantFilter(tenantFilter.filter((x) => x !== id))}
                  className="group inline-flex items-center gap-1 rounded-full border border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 text-[11px] pl-2 pr-1 py-0.5 hover:bg-fuchsia-100"
                  title="Remove tenant filter"
                >
                  <span className="text-[9px] uppercase tracking-wider opacity-60">Tenant</span>
                  <span className="font-medium truncate max-w-[140px]">{label}</span>
                  <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                </button>
              );
            })}
            {landlordFilter.map((key) => {
              const label = landlordOptions.find(([k]) => k === key)?.[1] || key;
              return (
                <button
                  key={`landlord-${key}`}
                  type="button"
                  onClick={() => setLandlordFilter(landlordFilter.filter((x) => x !== key))}
                  className="group inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 text-[11px] pl-2 pr-1 py-0.5 hover:bg-emerald-100"
                  title="Remove landlord filter"
                >
                  <span className="text-[9px] uppercase tracking-wider opacity-60">Landlord</span>
                  <span className="font-medium truncate max-w-[180px]">{label}</span>
                  <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                </button>
              );
            })}
          </div>
        )}

        {/* Totals strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg border-2 border-[#9234EA]/20 bg-[#9234EA]/5 p-3 text-center mb-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">CFO Funded</p>
            <p className="font-bold text-sm text-blue-600">{fmt(totals.funded)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Earmarked</p>
            <p className="font-bold text-sm text-fuchsia-600">{fmt(totals.allocated)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Paid to Landlords</p>
            <p className="font-bold text-sm text-emerald-600">{fmt(totals.paid)}</p>
          </div>
          <div title="Sum of remaining_amount across allocations in view">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Outstanding</p>
            <p className={cn('font-bold text-sm', totals.outstanding > 0 ? 'text-amber-600' : 'text-muted-foreground')}>
              {fmt(totals.outstanding)}
            </p>
            {(totals.overdueCount > 0 || totals.criticalCount > 0) && (
              <p className="text-[10px] mt-0.5 inline-flex items-center gap-1 justify-center flex-wrap">
                {totals.criticalCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-red-700 font-semibold">
                    <Flame className="h-2.5 w-2.5" />{totals.criticalCount} critical
                  </span>
                )}
                {totals.overdueCount > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-orange-700 font-semibold">
                    <AlertTriangle className="h-2.5 w-2.5" />{totals.overdueCount} overdue
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Timeline */}
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
            <p className="font-medium">No movements match your filters</p>
            <p className="text-xs">Adjust the date range or clear the search.</p>
          </div>
        ) : (
          <div className="space-y-4 max-h-[640px] overflow-y-auto pr-1">
            {grouped.map(([day, dayEvents]) => (
              <div key={day}>
                <div className="sticky top-0 z-10 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/60 py-1 mb-2 border-b">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground inline-flex items-center gap-2">
                    <CalendarIcon className="h-3 w-3" />
                    {format(new Date(day), 'EEEE, dd MMM yyyy')}
                    <Badge variant="outline" className="text-[9px] px-1.5 py-0">{dayEvents.length}</Badge>
                  </p>
                </div>
                <ol className="relative border-l border-dashed border-muted ml-2 space-y-3">
                  {dayEvents.map((e) => {
                    const meta = kindMeta[e.kind];
                    const Icon = meta.icon;
                    const prio = priorityFor(e);
                    const PrioIcon = prio?.icon;
                    return (
                      <li key={e.id} className="ml-4">
                        <span className={cn('absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ring-4 ring-background', meta.dot)} />
                        <button
                          type="button"
                          onClick={() => setDrillEvent(e)}
                          className={cn(
                            'w-full text-left rounded-lg border p-2.5 bg-card hover:border-[#9234EA]/50 hover:shadow-sm transition focus:outline-none focus:ring-2 focus:ring-[#9234EA]/40',
                            prio?.borderClass,
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2 min-w-0">
                              <div className={cn('p-1.5 rounded-md border', meta.color)}>
                                <Icon className="h-3.5 w-3.5" />
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0', meta.color)}>{meta.label}</Badge>
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                                    <Clock className="h-2.5 w-2.5 mr-1" />
                                    {format(new Date(e.at), 'HH:mm')}
                                  </Badge>
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 capitalize">{e.status}</Badge>
                                  {prio && PrioIcon && (
                                    <Badge
                                      variant="outline"
                                      className={cn(
                                        'text-[9px] px-1.5 py-0 font-semibold inline-flex items-center gap-1',
                                        prio.badgeClass,
                                        prio.level === 'critical' && 'animate-pulse',
                                      )}
                                      title={`${prio.label} · ${Math.floor(prio.ageDays)}d old · ${fmt(e.outstanding || 0)} outstanding`}
                                    >
                                      <PrioIcon className="h-2.5 w-2.5" />
                                      {prio.label} · {Math.floor(prio.ageDays)}d · {fmt(e.outstanding || 0)}
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm font-medium mt-1 truncate">
                                  {e.kind === 'funding'
                                    ? <>CFO funded <span className="text-[#9234EA]">{e.agent_name}</span></>
                                    : e.kind === 'allocation'
                                    ? <><span className="text-[#9234EA]">{e.agent_name}</span> earmarked for {e.tenant_name || 'tenant'} → <span className="text-fuchsia-600">{e.landlord_name || 'landlord'}</span></>
                                    : <><span className="text-[#9234EA]">{e.agent_name}</span> paid {e.tenant_name || 'tenant'}'s landlord <span className="text-emerald-600">{e.landlord_name || ''}</span></>}
                                </p>
                                <div className="flex items-center gap-2 flex-wrap mt-1 text-[10px] text-muted-foreground">
                                  {e.landlord_phone && (
                                    <span className="inline-flex items-center gap-1">
                                      <Phone className="h-2.5 w-2.5" />{e.landlord_phone}
                                    </span>
                                  )}
                                  {e.reference && (
                                    <span className="inline-flex items-center gap-1">
                                      <Hash className="h-2.5 w-2.5" />
                                      <span className="font-mono">{e.reference_label}: {e.reference.length > 24 ? e.reference.slice(0, 8) + '…' + e.reference.slice(-6) : e.reference}</span>
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(ev) => { ev.stopPropagation(); copyRef(e.reference as string); }}
                                        onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.stopPropagation(); copyRef(e.reference as string); } }}
                                        className="hover:text-foreground"
                                        aria-label="Copy reference"
                                      >
                                        <Copy className="h-2.5 w-2.5" />
                                      </span>
                                    </span>
                                  )}
                                  <span className="text-muted-foreground/70">{e.source_table}</span>
                                </div>
                                {e.notes && (
                                  <p className="text-[10px] text-muted-foreground italic mt-1 line-clamp-2">{e.notes}</p>
                                )}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="font-bold text-sm">{fmt(e.amount)}</p>
                              {e.kind !== 'funding' && (
                                <p className="text-[10px] text-muted-foreground inline-flex items-center gap-1 justify-end">
                                  <ArrowRight className="h-2.5 w-2.5" />
                                  {e.kind === 'allocation' ? 'earmarked' : 'disbursed'}
                                </p>
                              )}
                              <p className="text-[10px] text-[#9234EA] inline-flex items-center gap-0.5 justify-end mt-0.5">
                                Details <ChevronRight className="h-2.5 w-2.5" />
                              </p>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}

        <FloatEventDrillDown
          event={drillEvent}
          allEvents={events}
          onClose={() => setDrillEvent(null)}
        />
      </CardContent>
    </Card>
  );
}

// ───────────────────── Drill-down dialog ─────────────────────
interface FloatEventDrillDownProps {
  event: TimelineEvent | null;
  allEvents: TimelineEvent[];
  onClose: () => void;
}
function FloatEventDrillDown({ event, allEvents, onClose }: FloatEventDrillDownProps) {
  // Live fetch agent wallet snapshot + chain so drill-down isn't stale.
  const enabled = !!event;
  const { data: chain, isLoading } = useQuery({
    queryKey: ['tenant-ops-float-drill', event?.id, event?.agent_id],
    enabled,
    staleTime: 15_000,
    queryFn: async () => {
      if (!event) return null;
      const [wallet, fundings, allocations, payouts] = await Promise.all([
        supabase.from('agent_landlord_float' as any)
          .select('id, balance, total_funded, total_paid_out, region, updated_at')
          .eq('agent_id', event.agent_id).maybeSingle(),
        supabase.from('agent_float_funding' as any)
          .select('id, amount, bank_reference, bank_name, status, created_at, notes')
          .eq('agent_id', event.agent_id)
          .order('created_at', { ascending: false }).limit(20),
        supabase.from('agent_landlord_float_allocations' as any)
          .select('id, tenant_id, landlord_name, landlord_phone, allocated_amount, paid_out_amount, remaining_amount, status, created_at')
          .eq('agent_id', event.agent_id)
          .order('created_at', { ascending: false }).limit(50),
        supabase.from('agent_float_withdrawals' as any)
          .select('id, tenant_id, landlord_name, landlord_phone, amount, transaction_id, status, created_at, gps_match, gps_distance_meters, mobile_money_provider, receipt_photo_urls')
          .eq('agent_id', event.agent_id)
          .order('created_at', { ascending: false }).limit(50),
      ]);
      return {
        wallet: wallet.data as any,
        fundings: (fundings.data || []) as any[],
        allocations: (allocations.data || []) as any[],
        payouts: (payouts.data || []) as any[],
      };
    },
  });

  if (!event) return null;

  // Related payouts/allocations that match this party combo
  const related = (() => {
    const sameAgent = chain?.payouts || [];
    const matchKey = (r: any) =>
      (event.tenant_id && r.tenant_id === event.tenant_id) ||
      (event.landlord_phone && r.landlord_phone === event.landlord_phone) ||
      (event.landlord_name && r.landlord_name === event.landlord_name);
    return {
      payouts: sameAgent.filter(matchKey),
      allocations: (chain?.allocations || []).filter(matchKey),
    };
  })();

  const fmtUgx = (n: number) =>
    new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

  const kindLabel = event.kind === 'funding' ? 'CFO Funding' : event.kind === 'allocation' ? 'Tenant Earmark' : 'Landlord Payout';

  // ───── Drill-down exports ─────
  const drillFilenameBase = () => {
    const refPart = (event.reference || event.id).toString().replace(/[^\w-]+/g, '_').slice(0, 32);
    return `float-drilldown_${event.kind}_${refPart}_${format(new Date(event.at), 'yyyyMMdd-HHmm')}`;
  };
  const exportDrillCsv = () => {
    const rows: (string | number)[][] = [];
    const push = (section: string, key: string, value: any) => {
      const v = value === null || value === undefined ? ''
        : typeof value === 'object' ? JSON.stringify(value)
        : String(value);
      rows.push([section, key, v]);
    };
    push('event', 'kind', kindLabel);
    push('event', 'date', format(new Date(event.at), 'yyyy-MM-dd HH:mm'));
    push('event', 'amount_ugx', event.amount);
    push('event', 'status', event.status);
    push('event', 'agent_id', event.agent_id);
    push('event', 'agent_name', event.agent_name);
    push('event', 'tenant_id', event.tenant_id || '');
    push('event', 'tenant_name', event.tenant_name || '');
    push('event', 'landlord_name', event.landlord_name || '');
    push('event', 'landlord_phone', event.landlord_phone || '');
    push('event', 'reference_label', event.reference_label);
    push('event', 'reference', event.reference || '');
    push('event', 'source_table', event.source_table);
    push('event', 'notes', event.notes || '');
    if (event.kind === 'allocation') {
      push('allocation_balance', 'allocated_ugx', event.allocated_amount || event.amount);
      push('allocation_balance', 'paid_out_ugx', event.paid_out_amount || 0);
      push('allocation_balance', 'outstanding_ugx', event.outstanding || 0);
    }
    if (chain?.wallet) {
      push('wallet_snapshot', 'on_card_now_ugx', Number(chain.wallet.balance) || 0);
      push('wallet_snapshot', 'lifetime_funded_ugx', Number(chain.wallet.total_funded) || 0);
      push('wallet_snapshot', 'lifetime_paid_out_ugx', Number(chain.wallet.total_paid_out) || 0);
      push('wallet_snapshot', 'region', chain.wallet.region || '');
      push('wallet_snapshot', 'updated_at', chain.wallet.updated_at || '');
    }
    Object.entries(event.raw || {}).forEach(([k, v]) => push('record_fields', k, v));
    (related.allocations || []).forEach((a: any) => {
      push('related_allocation', `${a.id}|allocated_ugx`, Number(a.allocated_amount) || 0);
      push('related_allocation', `${a.id}|paid_out_ugx`, Number(a.paid_out_amount) || 0);
      push('related_allocation', `${a.id}|remaining_ugx`, Number(a.remaining_amount) || 0);
      push('related_allocation', `${a.id}|status`, a.status);
      push('related_allocation', `${a.id}|created_at`, a.created_at);
    });
    (related.payouts || []).forEach((p: any) => {
      push('related_payout', `${p.id}|amount_ugx`, Number(p.amount) || 0);
      push('related_payout', `${p.id}|status`, p.status);
      push('related_payout', `${p.id}|transaction_id`, p.transaction_id || '');
      push('related_payout', `${p.id}|momo_provider`, p.mobile_money_provider || '');
      push('related_payout', `${p.id}|gps_match`, p.gps_match ?? '');
      push('related_payout', `${p.id}|gps_distance_m`, p.gps_distance_meters ?? '');
      push('related_payout', `${p.id}|created_at`, p.created_at);
    });
    exportToCSV({ headers: ['Section', 'Field', 'Value'], rows }, drillFilenameBase());
    toast.success('Drill-down exported to CSV');
  };
  const exportDrillPdf = async () => {
    try {
      const { jsPDF } = await import('jspdf');
      const autoTableMod: any = await import('jspdf-autotable');
      const autoTable = autoTableMod.default || autoTableMod;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      doc.setFontSize(14);
      doc.text(`${kindLabel} — ${fmtUgx(event.amount)}`, 40, 40);
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(`${format(new Date(event.at), 'EEEE dd MMM yyyy · HH:mm')}  ·  Source: ${event.source_table}`, 40, 56);
      doc.text(`Agent: ${event.agent_name}  ·  Ref (${event.reference_label}): ${event.reference || '—'}`, 40, 70);
      let y = 86;
      const section = (title: string, head: string[][], body: any[][]) => {
        if (body.length === 0) return;
        autoTable(doc, {
          startY: y,
          head,
          body,
          styles: { fontSize: 8, cellPadding: 3, overflow: 'linebreak' },
          headStyles: { fillColor: [146, 52, 234], textColor: 255 },
          alternateRowStyles: { fillColor: [248, 245, 255] },
          margin: { left: 40, right: 40 },
          didDrawPage: () => {
            doc.setFontSize(10);
            doc.setTextColor(80);
            doc.text(title, 40, (doc as any).lastAutoTable?.startY ? (doc as any).lastAutoTable.startY - 6 : 86 - 6);
          },
        });
        y = (doc as any).lastAutoTable.finalY + 18;
      };
      // Event summary + (optional) allocation balance + wallet snapshot
      const summaryRows: any[][] = [
        ['Status', event.status],
        ['Tenant', event.tenant_name || '—'],
        ['Landlord', [event.landlord_name, event.landlord_phone].filter(Boolean).join(' · ') || '—'],
        ['Notes', event.notes || '—'],
      ];
      if (event.kind === 'allocation') {
        summaryRows.push(['Allocated', fmtUgx(event.allocated_amount || event.amount)]);
        summaryRows.push(['Paid out', fmtUgx(event.paid_out_amount || 0)]);
        summaryRows.push(['Outstanding', fmtUgx(event.outstanding || 0)]);
      }
      if (chain?.wallet) {
        summaryRows.push(['Wallet · On Card', fmtUgx(Number(chain.wallet.balance) || 0)]);
        summaryRows.push(['Wallet · Lifetime Funded', fmtUgx(Number(chain.wallet.total_funded) || 0)]);
        summaryRows.push(['Wallet · Lifetime Paid Out', fmtUgx(Number(chain.wallet.total_paid_out) || 0)]);
      }
      section('Event summary', [['Field', 'Value']], summaryRows);

      // Raw record fields
      const rawRows = Object.entries(event.raw || {}).map(([k, v]) => [
        k,
        v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v),
      ]);
      section(`Record fields · ${event.source_table}`, [['Field', 'Value']], rawRows);

      // Related allocations
      if (related.allocations.length) {
        section('Related allocations', [['Date', 'Status', 'Allocated', 'Paid Out', 'Outstanding']],
          related.allocations.map((a: any) => [
            format(new Date(a.created_at), 'yyyy-MM-dd HH:mm'),
            a.status,
            fmtUgx(Number(a.allocated_amount) || 0),
            fmtUgx(Number(a.paid_out_amount) || 0),
            fmtUgx(Number(a.remaining_amount) || 0),
          ]));
      }

      // Related payouts
      if (related.payouts.length) {
        section('Related landlord payouts', [['Date', 'Status', 'Amount', 'TID', 'MoMo', 'GPS (m)']],
          related.payouts.map((p: any) => [
            format(new Date(p.created_at), 'yyyy-MM-dd HH:mm'),
            p.status,
            fmtUgx(Number(p.amount) || 0),
            p.transaction_id || '',
            p.mobile_money_provider || '',
            typeof p.gps_distance_meters === 'number' ? Math.round(p.gps_distance_meters).toString() : '—',
          ]));
      }

      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(
        `Generated ${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
        pageWidth - 40,
        doc.internal.pageSize.getHeight() - 18,
        { align: 'right' },
      );
      doc.save(`${drillFilenameBase()}.pdf`);
      toast.success('Drill-down exported to PDF');
    } catch (err) {
      console.error(err);
      toast.error('PDF export failed');
    }
  };

  return (
    <Dialog open={!!event} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Landmark className="h-4 w-4 text-[#9234EA]" />
            {kindLabel} · {fmtUgx(event.amount)}
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={exportDrillCsv}
                title="Export drill-down to CSV"
              >
                <Download className="h-3 w-3" /> CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={exportDrillPdf}
                title="Export drill-down to PDF"
              >
                <FileText className="h-3 w-3" /> PDF
              </Button>
            </div>
          </DialogTitle>
          <DialogDescription className="text-xs">
            {format(new Date(event.at), 'EEEE dd MMM yyyy · HH:mm')} · {event.source_table}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] pr-3">
          <div className="space-y-3">
            {/* Agent wallet snapshot */}
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 inline-flex items-center gap-1">
                <Wallet className="h-3 w-3" /> Agent float wallet — {event.agent_name}
              </p>
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : chain?.wallet ? (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] text-muted-foreground">On Card Now</p>
                    <p className="font-bold text-sm">{fmtUgx(Number(chain.wallet.balance) || 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Lifetime Funded</p>
                    <p className="font-bold text-sm text-blue-600">{fmtUgx(Number(chain.wallet.total_funded) || 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Lifetime Paid Out</p>
                    <p className="font-bold text-sm text-emerald-600">{fmtUgx(Number(chain.wallet.total_paid_out) || 0)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No wallet record found.</p>
              )}
            </div>

            {/* This event raw fields */}
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 inline-flex items-center gap-1">
                <FileText className="h-3 w-3" /> Record fields ({event.source_table})
              </p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs">
                {Object.entries(event.raw || {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground font-mono text-[10px] truncate">{k}</dt>
                    <dd className="font-mono text-[11px] break-all">
                      {v === null || v === undefined
                        ? <span className="text-muted-foreground/60 italic">null</span>
                        : typeof v === 'object'
                        ? JSON.stringify(v)
                        : String(v)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Allocation chain: outstanding */}
            {event.kind === 'allocation' && (
              <div className="rounded-lg border bg-amber-50/50 border-amber-200 p-3">
                <p className="text-[11px] uppercase tracking-wider text-amber-700 font-semibold mb-2 inline-flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> Allocation balance
                </p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[10px] text-muted-foreground">Allocated</p>
                    <p className="font-bold text-sm text-fuchsia-600">{fmtUgx(event.allocated_amount || event.amount)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Paid Out</p>
                    <p className="font-bold text-sm text-emerald-600">{fmtUgx(event.paid_out_amount || 0)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground">Outstanding</p>
                    <p className={cn('font-bold text-sm', (event.outstanding || 0) > 0 ? 'text-amber-700' : 'text-muted-foreground')}>
                      {fmtUgx(event.outstanding || 0)}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Compare: allocations vs payouts side-by-side for this party */}
            {(related.allocations.length > 0 || related.payouts.length > 0) && (() => {
              const allocs = related.allocations;
              const payouts = related.payouts;
              const allocTotal = allocs.reduce((s, a: any) => s + (Number(a.allocated_amount) || 0), 0);
              const allocPaid = allocs.reduce((s, a: any) => s + (Number(a.paid_out_amount) || 0), 0);
              const allocRemaining = allocs.reduce((s, a: any) => s + (Number(a.remaining_amount) || 0), 0);
              const allocOpen = allocs.filter((a: any) => (Number(a.remaining_amount) || 0) > 0).length;
              const allocLastAt = allocs.length ? allocs.map((a: any) => new Date(a.created_at).getTime()).sort((x, y) => y - x)[0] : null;
              const payoutTotal = payouts.reduce((s, p: any) => s + (Number(p.amount) || 0), 0);
              const payoutSettled = payouts.filter((p: any) => ['completed', 'settled', 'success'].includes(String(p.status).toLowerCase())).length;
              const payoutPending = payouts.length - payoutSettled;
              const payoutLastAt = payouts.length ? payouts.map((p: any) => new Date(p.created_at).getTime()).sort((x, y) => y - x)[0] : null;
              const reconDelta = allocPaid - payoutTotal; // positive => allocations claim more paid than actual MoMo payouts
              const reconClass = Math.abs(reconDelta) < 1
                ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                : 'text-red-700 bg-red-50 border-red-200';
              return (
                <div className="rounded-lg border-2 border-[#9234EA]/20 bg-[#9234EA]/5 p-3">
                  <p className="text-[11px] uppercase tracking-wider text-[#9234EA] font-semibold mb-2 inline-flex items-center gap-1">
                    <ChevronsUpDown className="h-3 w-3" /> Compare — Allocations vs Payouts
                  </p>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    Same tenant/landlord context for this agent.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {/* Allocations column */}
                    <div className="rounded-md border bg-card p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-fuchsia-700 font-semibold inline-flex items-center gap-1 mb-1.5">
                        <Building2 className="h-3 w-3" /> Allocations ({allocs.length})
                      </p>
                      <dl className="text-xs space-y-1">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Total allocated</dt>
                          <dd className="font-mono font-semibold text-fuchsia-700">{fmtUgx(allocTotal)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Paid out (per allocs)</dt>
                          <dd className="font-mono font-semibold">{fmtUgx(allocPaid)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Outstanding</dt>
                          <dd className={cn('font-mono font-semibold', allocRemaining > 0 ? 'text-amber-700' : 'text-muted-foreground')}>
                            {fmtUgx(allocRemaining)}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Open allocations</dt>
                          <dd className="font-mono">{allocOpen}/{allocs.length}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Last</dt>
                          <dd className="font-mono text-[10px]">
                            {allocLastAt ? format(new Date(allocLastAt), 'dd MMM HH:mm') : '—'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    {/* Payouts column */}
                    <div className="rounded-md border bg-card p-2.5">
                      <p className="text-[10px] uppercase tracking-wider text-emerald-700 font-semibold inline-flex items-center gap-1 mb-1.5">
                        <HandCoins className="h-3 w-3" /> Payouts ({payouts.length})
                      </p>
                      <dl className="text-xs space-y-1">
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Total paid (MoMo)</dt>
                          <dd className="font-mono font-semibold text-emerald-700">{fmtUgx(payoutTotal)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Settled</dt>
                          <dd className="font-mono">{payoutSettled}/{payouts.length}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Pending / other</dt>
                          <dd className={cn('font-mono', payoutPending > 0 ? 'text-amber-700 font-semibold' : '')}>{payoutPending}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Avg per payout</dt>
                          <dd className="font-mono">{fmtUgx(payouts.length ? payoutTotal / payouts.length : 0)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">Last</dt>
                          <dd className="font-mono text-[10px]">
                            {payoutLastAt ? format(new Date(payoutLastAt), 'dd MMM HH:mm') : '—'}
                          </dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                  {/* Reconciliation strip */}
                  <div className={cn('mt-2 rounded-md border px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2', reconClass)}>
                    <span className="inline-flex items-center gap-1.5 font-semibold">
                      {Math.abs(reconDelta) < 1
                        ? <CheckCircle2 className="h-3.5 w-3.5" />
                        : <AlertTriangle className="h-3.5 w-3.5" />}
                      Reconciliation
                    </span>
                    <span className="font-mono">
                      Allocs paid {fmtUgx(allocPaid)} − Payouts {fmtUgx(payoutTotal)} ={' '}
                      <span className="font-semibold">
                        {reconDelta > 0 ? '+' : ''}{fmtUgx(reconDelta)}
                      </span>
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* Related allocations for this party */}
            {related.allocations.length > 0 && (
              <div className="rounded-lg border bg-card p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                  Related allocations for this tenant/landlord ({related.allocations.length})
                </p>
                <ul className="text-xs space-y-1 max-h-[180px] overflow-y-auto">
                  {related.allocations.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 py-1 border-b last:border-0">
                      <span className="truncate">
                        <span className="font-mono text-[10px] text-muted-foreground">{a.id.slice(0, 8)}…</span>
                        {' · '}
                        {format(new Date(a.created_at), 'dd MMM HH:mm')}
                        {' · '}
                        <Badge variant="outline" className="text-[9px] px-1 py-0 capitalize">{a.status}</Badge>
                      </span>
                      <span className="font-mono text-[11px] shrink-0">
                        {fmtUgx(Number(a.allocated_amount) || 0)}
                        {Number(a.remaining_amount) > 0 && (
                          <span className="text-amber-700"> · {fmtUgx(Number(a.remaining_amount))} left</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Related payouts for this party */}
            {related.payouts.length > 0 && (
              <div className="rounded-lg border bg-card p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
                  Related landlord payouts ({related.payouts.length})
                </p>
                <ul className="text-xs space-y-1 max-h-[180px] overflow-y-auto">
                  {related.payouts.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 py-1 border-b last:border-0">
                      <span className="truncate inline-flex items-center gap-1">
                        {format(new Date(p.created_at), 'dd MMM HH:mm')}
                        {' · '}
                        <Badge variant="outline" className="text-[9px] px-1 py-0 capitalize">{p.status}</Badge>
                        {p.mobile_money_provider && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0">{p.mobile_money_provider}</Badge>
                        )}
                        {p.transaction_id && <span className="font-mono text-[10px] text-muted-foreground">· {p.transaction_id}</span>}
                        {typeof p.gps_distance_meters === 'number' && (
                          <span className={cn('inline-flex items-center gap-0.5 text-[10px]', p.gps_match ? 'text-emerald-600' : 'text-amber-600')}>
                            <MapPin className="h-2.5 w-2.5" />{Math.round(p.gps_distance_meters)}m
                          </span>
                        )}
                      </span>
                      <span className="font-mono text-[11px] shrink-0">{fmtUgx(Number(p.amount) || 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Cross-reference in current view */}
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                In current timeline view
              </p>
              <p className="text-[11px] text-muted-foreground">
                {allEvents.filter((x) => x.agent_id === event.agent_id).length} other rows for this agent loaded in the timeline.
              </p>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
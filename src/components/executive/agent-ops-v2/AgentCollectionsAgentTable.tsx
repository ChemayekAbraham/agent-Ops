import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { Search, FileDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

export interface AgentTableRow {
  agent_id: string;
  name: string;
  phone: string | null;
  avatar_url: string | null;
  collected: number;
  expected: number;
  collections_count: number;
  tenants_paid: number;
  active_tenants: number;
  last_collection_at: string | null;
  pct: number | null;
}

const initials = (name: string) =>
  (name || 'A')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase())
    .join('');

const cycleLabel = (f: string | null) => {
  const v = (f || 'daily').toLowerCase();
  if (v.startsWith('week')) return 'Weekly';
  if (v.startsWith('month')) return 'Monthly';
  return 'Daily';
};

const expectedInstallment = (daily: number | null, cycle: string | null) => {
  const d = Number(daily || 0);
  const v = (cycle || 'daily').toLowerCase();
  if (v.startsWith('week')) return d * 7;
  if (v.startsWith('month')) return d * 30;
  return d;
};

const ratingTone = (pct: number | null) =>
  pct === null ? 'text-muted-foreground'
    : pct >= 90 ? 'text-emerald-600'
    : pct >= 50 ? 'text-amber-600'
    : 'text-destructive';

interface DrillRow {
  id: string;
  tenantName: string;
  tenantPhone: string | null;
  amount: number;
  expectedAmount: number;
  createdAt: string;
  balance: number;
  tenantOutstanding: number;
  cycle: string;
}

function AgentCollectionsDrilldown({
  agent, start, end, onClose,
}: { agent: AgentTableRow; start: Date; end: Date; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['agent-ops-collections-drill', agent.agent_id, start.toISOString(), end.toISOString()],
    staleTime: 30_000,
    queryFn: async (): Promise<DrillRow[]> => {
      const { data: res, error: rpcErr } = await supabase.rpc('get_agent_collection_records', {
        p_agent_id: agent.agent_id,
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (rpcErr) throw rpcErr;

      const rows = (Array.isArray(res) ? res : []) as any[];
      return rows.map(r => {
        const amount = Number(r.amount) || 0;
        const expected = Number(r.expected_amount) || 0;
        return {
          id: String(r.id),
          tenantName: r.tenant_name || 'Tenant',
          tenantPhone: r.tenant_phone ?? null,
          amount,
          expectedAmount: expected,
          createdAt: r.created_at,
          balance: Math.max(0, expected - amount),
          tenantOutstanding: Number(r.tenant_outstanding) || 0,
          cycle: cycleLabel(r.cycle ?? null),
        };
      });
    },
  });

  const rows = data ?? [];
  const [tenantSearch, setTenantSearch] = useState('');
  const tenantFiltered = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.tenantName.toLowerCase().includes(q) ||
      (r.tenantPhone ?? '').toLowerCase().includes(q)
    );
  }, [rows, tenantSearch]);

  const total = tenantFiltered.reduce((s, r) => s + r.amount, 0);
  const totalExpected = tenantFiltered.reduce((s, r) => s + r.expectedAmount, 0);
  const totalBalance = tenantFiltered.reduce((s, r) => s + r.balance, 0);

  const [exporting, setExporting] = useState(false);

  const exportPdf = async () => {
    const sourceRows = tenantFiltered.length ? tenantFiltered : rows;
    if (sourceRows.length === 0) return;
    setExporting(true);
    try {
      const [{ default: jsPDF }, autoTableMod] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable'),
      ]);
      const autoTable = (autoTableMod as any).default ?? autoTableMod;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

      doc.setFontSize(14);
      doc.text(`${agent.name || 'Agent'} — collection records`, 40, 40);
      doc.setFontSize(9);
      doc.text(
        `${format(start, 'dd MMM yyyy')} – ${format(end, 'dd MMM yyyy')}  ·  ${sourceRows.length} records  ·  Collected ${formatUGX(total)}  ·  Balance ${formatUGX(totalBalance)}  ·  Expected ${formatUGX(totalExpected)}`,
        40,
        58,
      );

      autoTable(doc, {
        startY: 74,
        head: [['Tenant', 'Phone', 'Collected', 'Expected', 'Balance', 'Total outstanding', 'Cycle', 'Collected at']],
        body: sourceRows.map(r => [
          r.tenantName,
          r.tenantPhone ?? '—',
          formatUGX(r.amount),
          formatUGX(r.expectedAmount),
          formatUGX(r.balance),
          formatUGX(r.tenantOutstanding),
          r.cycle,
          format(new Date(r.createdAt), 'dd MMM yyyy HH:mm'),
        ]),
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 8 },
        columnStyles: { 1: { cellWidth: 90 } },
      });

      doc.save(
        `${agent.name || 'agent'}-collections-${format(start, 'yyyyMMdd')}-${format(end, 'yyyyMMdd')}.pdf`.replace(/\s+/g, '-'),
      );
      toast.success('Collection records exported');
    } catch (e) {
      toast.error('Could not create the PDF');
    } finally {
      setExporting(false);
    }
  };


  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-4xl w-[calc(100vw-1.5rem)] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">
            {agent.name} — collection records
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="text-[10px]">
            {format(start, 'dd MMM yyyy')} – {format(end, 'dd MMM yyyy')}
          </Badge>
          <span>{tenantFiltered.length} records</span>
          <span className="font-semibold text-emerald-600">{formatUGX(total)} collected</span>
          <span className="font-semibold text-destructive">
            {formatUGX(totalBalance)} balance
          </span>
          <Button size="sm" variant="outline" className="h-8 text-xs ml-auto" disabled={tenantFiltered.length === 0 || exporting} onClick={exportPdf}>
            <FileDown className="h-3.5 w-3.5 mr-1" /> {exporting ? 'Preparing…' : 'Export PDF'}

          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={tenantSearch}
            onChange={e => setTenantSearch(e.target.value)}
            placeholder="Search tenant"
            className="h-8 pl-7 text-xs"
          />
        </div>

        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading records…</p>
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">{(error as any)?.message || 'Could not load records'}</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No collections recorded in this period.</p>
        ) : tenantFiltered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No tenants match your search.</p>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="space-y-2 md:hidden">
              {tenantFiltered.map(r => (
                <div key={r.id} className="rounded-lg border p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{r.tenantName}</p>
                      <p className="text-[11px] text-muted-foreground">{format(new Date(r.createdAt), 'dd MMM h:mm a')}</p>
                    </div>
                    <p className="text-sm font-semibold tabular-nums text-emerald-600">{formatUGX(r.amount)}</p>
                  </div>
                  <div className="mt-1.5 grid grid-cols-4 gap-2 text-[11px]">
                    <div>
                      <p className="text-muted-foreground">Expected</p>
                      <p className="font-medium tabular-nums">{formatUGX(r.expectedAmount)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Balance</p>
                      <p className="font-medium tabular-nums text-destructive">{formatUGX(r.balance)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Outstanding</p>
                      <p className="font-medium tabular-nums text-primary">{formatUGX(r.tenantOutstanding)}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Cycle</p>
                      <p className="font-medium">{r.cycle}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">Tenant</th>
                    <th className="p-2 font-medium text-right">Collected</th>
                    <th className="p-2 font-medium text-right">Expected</th>
                    <th className="p-2 font-medium text-right">Balance</th>
                    <th className="p-2 font-medium text-right">Outstanding</th>
                    <th className="p-2 font-medium">Cycle</th>
                    <th className="p-2 font-medium">Collected at</th>
                  </tr>
                </thead>
                <tbody>
                  {tenantFiltered.map(r => (
                    <tr key={r.id} className="border-t hover:bg-accent/30">
                      <td className="p-2">
                        <p className="font-medium">{r.tenantName}</p>
                        {r.tenantPhone && <p className="text-[10px] text-muted-foreground">{r.tenantPhone}</p>}
                      </td>
                      <td className="p-2 text-right font-semibold tabular-nums text-emerald-600">{formatUGX(r.amount)}</td>
                      <td className="p-2 text-right tabular-nums">{formatUGX(r.expectedAmount)}</td>
                      <td className="p-2 text-right tabular-nums text-destructive">{formatUGX(r.balance)}</td>
                      <td className="p-2 text-right tabular-nums text-primary">{formatUGX(r.tenantOutstanding)}</td>
                      <td className="p-2">
                        <Badge variant="outline" className="text-[10px]">{r.cycle}</Badge>
                      </td>
                      <td className="p-2 text-muted-foreground whitespace-nowrap">
                        {format(new Date(r.createdAt), 'dd MMM h:mm a')}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/40 font-semibold">
                    <td className="p-2">Total · {tenantFiltered.length} records</td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(total)}</td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(totalExpected)}</td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(totalBalance)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AgentCollectionsAgentTable({
  agents, isLoading, start, end, onExportStatement, exporting,
}: {
  agents: AgentTableRow[];
  isLoading: boolean;
  start: Date;
  end: Date;
  onExportStatement?: () => void;
  exporting?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [visible, setVisible] = useState(20);
  const [selected, setSelected] = useState<AgentTableRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? agents.filter(a => (a.name || '').toLowerCase().includes(q) || (a.phone || '').includes(q))
      : agents;
  }, [agents, search]);

  const shown = filtered.slice(0, visible);

  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold mr-auto">Agents by collections vs expected</h3>
        <Badge variant="outline" className="text-[10px]">{filtered.length} agents</Badge>
        {onExportStatement && (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={exporting || isLoading} onClick={onExportStatement}>
            <FileDown className="h-3.5 w-3.5 mr-1" />
            {exporting ? 'Preparing…' : 'Financial statement (PDF)'}
          </Button>
        )}
        <div className="relative w-full sm:w-48">
          <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setVisible(20); }}
            placeholder="Search agent"
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-6 text-center">Loading collections…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">No agents match this range.</p>
      ) : (
        <>
          {/* Mobile list */}
          <div className="space-y-2 md:hidden">
            {shown.map(a => (
              <button
                key={a.agent_id}
                onClick={() => setSelected(a)}
                className="w-full text-left rounded-lg border bg-card/60 p-2.5 hover:bg-accent/40 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <Avatar className="h-8 w-8 shrink-0">
                    {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.name} />}
                    <AvatarFallback className="text-[10px]">{initials(a.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{a.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {a.active_tenants} tenants{a.phone ? ` · ${a.phone}` : ''}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <p className="text-muted-foreground">Collected</p>
                    <p className="font-semibold tabular-nums">{formatUGX(a.collected)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Expected</p>
                    <p className="font-medium tabular-nums">{formatUGX(a.expected)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Rating</p>
                    <p className={cn('font-semibold', ratingTone(a.pct))}>{a.pct === null ? '—' : `${a.pct}%`}</p>
                  </div>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {a.last_collection_at ? `Last ${format(new Date(a.last_collection_at), 'dd MMM h:mm a')}` : 'No collection yet'}
                </p>
              </button>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">Agent</th>
                  <th className="p-2 font-medium text-right">Total tenants</th>
                  <th className="p-2 font-medium text-right">Collected</th>
                  <th className="p-2 font-medium text-right">Expected</th>
                  <th className="p-2 font-medium text-right">Rating</th>
                  <th className="p-2 font-medium">Last collection</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map(a => (
                  <tr
                    key={a.agent_id}
                    onClick={() => setSelected(a)}
                    className="border-t cursor-pointer hover:bg-accent/30"
                  >
                    <td className="p-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar className="h-7 w-7 shrink-0">
                          {a.avatar_url && <AvatarImage src={a.avatar_url} alt={a.name} />}
                          <AvatarFallback className="text-[10px]">{initials(a.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{a.name}</p>
                          {a.phone && <p className="text-[10px] text-muted-foreground truncate">{a.phone}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="p-2 text-right tabular-nums">{a.active_tenants}</td>
                    <td className="p-2 text-right font-semibold tabular-nums">{formatUGX(a.collected)}</td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(a.expected)}</td>
                    <td className={cn('p-2 text-right font-semibold tabular-nums', ratingTone(a.pct))}>
                      {a.pct === null ? '—' : `${a.pct}%`}
                    </td>
                    <td className="p-2 text-muted-foreground whitespace-nowrap">
                      {a.last_collection_at ? format(new Date(a.last_collection_at), 'dd MMM h:mm a') : '—'}
                    </td>
                    <td className="p-2 text-right">
                      <ChevronRight className="h-4 w-4 text-muted-foreground inline" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visible < filtered.length && (
            <div className="pt-3 text-center">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setVisible(v => v + 20)}>
                Load more · {filtered.length - visible} remaining
              </Button>
            </div>
          )}
        </>
      )}

      <p className="text-[11px] text-muted-foreground mt-2">
        Rating is collected against expected for this period. Expected is the sum of the instalments each tenant's agreed
        payment plan schedules inside this period. Tap an agent to see their collection records.
      </p>

      {selected && (
        <AgentCollectionsDrilldown agent={selected} start={start} end={end} onClose={() => setSelected(null)} />
      )}
    </Card>
  );
}

export default AgentCollectionsAgentTable;

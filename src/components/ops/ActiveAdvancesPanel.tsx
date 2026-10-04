import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Search, Pencil } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX, frequencyLabel } from '@/lib/agentAdvanceCalculations';
import { EditAdvanceTermsDialog } from '@/components/advances/EditAdvanceTermsDialog';

type Row = {
  id: string;
  agent_id: string;
  principal: number;
  access_fee: number;
  registration_fee: number;
  outstanding_balance: number;
  arrears_balance: number;
  daily_installment: number;
  monthly_rate: number;
  cycle_days: number;
  repayment_frequency?: string | null;
  installment_amount?: number | null;
  status: string;
  issued_at: string;
  expires_at: string;
  agent_name?: string;
  agent_phone?: string;
};

const STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  repaying: 'bg-emerald-100 text-emerald-700',
  overdue: 'bg-rose-100 text-rose-700',
  pending: 'bg-amber-100 text-amber-700',
  completed: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground',
};

export function ActiveAdvancesPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('active');
  const [editing, setEditing] = useState<Row | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['active-advances', statusFilter],
    queryFn: async (): Promise<Row[]> => {
      let q = supabase
        .from('agent_advances')
        .select('id, agent_id, principal, access_fee, registration_fee, outstanding_balance, arrears_balance, daily_installment, monthly_rate, cycle_days, repayment_frequency, installment_amount, status, issued_at, expires_at')
        .order('issued_at', { ascending: false })
        .limit(500);
      if (statusFilter !== 'all') {
        if (statusFilter === 'active') {
          q = q.in('status', ['active', 'repaying', 'overdue']);
        } else {
          q = q.eq('status', statusFilter);
        }
      }
      const { data, error } = await q;
      if (error) throw error;
      const advances = (data || []) as any[];
      const ids = [...new Set(advances.map(a => a.agent_id))];
      if (ids.length === 0) return advances as Row[];
      const profiles: Record<string, any> = {};
      const BATCH = 50;
      for (let i = 0; i < ids.length; i += BATCH) {
        const { data: pdata } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids.slice(i, i + BATCH));
        (pdata || []).forEach(p => { profiles[p.id] = p; });
      }
      return advances.map(a => ({
        ...a,
        agent_name: profiles[a.agent_id]?.full_name || '—',
        agent_phone: profiles[a.agent_id]?.phone || '',
      })) as Row[];
    },
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(r =>
      (r.agent_name || '').toLowerCase().includes(s) ||
      (r.agent_phone || '').toLowerCase().includes(s) ||
      r.id.toLowerCase().includes(s),
    );
  }, [rows, search]);

  const totalOutstanding = rows.reduce((s, r) => s + Number(r.outstanding_balance || 0), 0);
  const totalArrears = rows.reduce((s, r) => s + Number(r.arrears_balance || 0), 0);
  const totalDaily = rows.reduce((s, r) => s + Number(r.daily_installment || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Advances" value={rows.length.toLocaleString()} />
        <StatCard label="Outstanding" value={formatUGX(totalOutstanding)} />
        <StatCard label="Arrears" value={formatUGX(totalArrears)} tone="rose" />
        <StatCard label="Expected Daily" value={formatUGX(totalDaily)} tone="emerald" />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <CardTitle className="text-base">Active Advances</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search name, phone or ID…"
                  className="pl-8 w-56"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active + Overdue</SelectItem>
                  <SelectItem value="repaying">Repaying only</SelectItem>
                  <SelectItem value="overdue">Overdue only</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading advances…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No advances match your filters.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Principal</TableHead>
                    <TableHead className="text-right">Outstanding / Repaid</TableHead>
                    <TableHead className="text-right">Daily</TableHead>
                    <TableHead className="text-center">Cycle</TableHead>
                    <TableHead>Issued</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map(r => {
                    const totalDue = Number(r.principal || 0) + Number(r.access_fee || 0) + Number(r.registration_fee || 0);
                    const outstanding = Number(r.outstanding_balance || 0);
                    const repaid = Math.max(0, totalDue - outstanding);
                    const pct = totalDue > 0 ? Math.min(100, Math.round((repaid / totalDue) * 100)) : 0;
                    const arrears = Number(r.arrears_balance || 0);
                    const isBehind = arrears > 0;
                    return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="font-medium">{r.agent_name}</div>
                        <div className="text-xs text-muted-foreground">{r.agent_phone}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatUGX(r.principal)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <div className="font-semibold">{formatUGX(outstanding)}</div>
                        <div className="text-[11px] text-emerald-600">Repaid {formatUGX(repaid)} · {pct}%</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatUGX(Number(r.installment_amount ?? r.daily_installment ?? 0))}
                        <div className="text-[11px] text-muted-foreground">{frequencyLabel(r.repayment_frequency)}</div>
                      </TableCell>
                      <TableCell className="text-center">{r.cycle_days}d</TableCell>
                      <TableCell className="text-xs">{r.issued_at ? format(new Date(r.issued_at), 'dd MMM yy') : '—'}</TableCell>
                      <TableCell className="text-xs">{r.expires_at ? format(new Date(r.expires_at), 'dd MMM yy') : '—'}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge className={STATUS_TONE[r.status] || 'bg-muted text-muted-foreground'} variant="secondary">
                            {r.status}
                          </Badge>
                          {isBehind && (
                            <span className="text-[11px] font-medium text-rose-600">
                              Behind {formatUGX(arrears)}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                          <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <EditAdvanceTermsDialog
        advance={editing ? { ...editing, agent_name: editing.agent_name } : null}
        open={!!editing}
        onOpenChange={(o) => { if (!o) setEditing(null); }}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['active-advances'] });
          setEditing(null);
        }}
      />
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: 'rose' | 'emerald' }) {
  const toneClass = tone === 'rose' ? 'text-rose-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-foreground';
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-medium tabular-nums">{value}</p>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Pencil, Plus, Download, FileSpreadsheet, RefreshCw, Search, X,
  ShieldCheck, AlertTriangle, Users, Receipt, Landmark, CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

type Row = {
  run_id: string; period_code: string | null; staff_id: string; staff_ref: string | null;
  full_name: string | null; phone: string | null; source: 'survey' | 'payroll' | 'cfo_added';
  tin: string | null; nssf_number: string | null; paye_on: boolean; nssf_on: boolean;
  starts_next_run: boolean; gross: number; paye: number; nssf_employee: number;
  nssf_employer: number; nssf_total: number; lst: number; total_remittance: number;
};
type StaffOpt = { staff_id: string; staff_ref: string | null; full_name: string | null };

const NOT_PAY = 'This records their tax IDs only. It does not change their pay — switching PAYE/NSSF on is done by HR.';
const SOURCE: Record<Row['source'], { label: string; badgeCls: string }> = {
  survey: { label: 'Survey Consent', badgeCls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20' },
  payroll: { label: 'Active on Payroll', badgeCls: 'bg-primary/10 text-primary border-primary/20' },
  cfo_added: { label: 'Added by CFO', badgeCls: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20' },
};
const n = (v: unknown) => Number(v ?? 0);
const ugx = (v: number) => `UGX ${Math.round(v).toLocaleString('en-US')}`;
const AMT = ['gross', 'paye', 'nssf_employee', 'nssf_employer', 'nssf_total', 'lst', 'total_remittance'] as const;

function MissingTag({ label = 'Missing' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

async function saveIds(staffId: string, tin: string, nssf: string) {
  const { data, error } = await supabase.rpc('cfo_set_staff_tax_ids' as never, { _staff_id: staffId, _tin: tin, _nssf: nssf } as never);
  if (error) throw new Error(error.message);
  return data as unknown as { tax_on_in_payroll?: boolean };
}

function IdsDialog({ open, onClose, row, onSaved }: { open: boolean; onClose: () => void; row: Row | null; onSaved: () => void }) {
  const isAdd = !row;
  const [tin, setTin] = useState(row?.tin ?? '');
  const [nssf, setNssf] = useState(row?.nssf_number ?? '');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<StaffOpt | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const opts = useQuery({
    queryKey: ['cfo-staff-tax-options'], enabled: open && isAdd,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_staff_tax_staff_options' as never);
      if (error) throw error;
      return (data ?? []) as StaffOpt[];
    },
  });
  const filtered = (opts.data ?? []).filter((o) => {
    const q = search.trim().toLowerCase();
    return !q || `${o.full_name ?? ''} ${o.staff_ref ?? ''}`.toLowerCase().includes(q);
  }).slice(0, 50);

  const reset = () => { setTin(''); setNssf(''); setSearch(''); setPicked(null); setErr(null); };
  const staffId = row?.staff_id ?? picked?.staff_id;

  const submit = async () => {
    if (!staffId) { setErr('Choose a staff member'); return; }
    setBusy(true); setErr(null);
    try {
      const res = await saveIds(staffId, tin, nssf);
      toast.success('Tax IDs saved successfully');
      if (isAdd && res?.tax_on_in_payroll === false) toast.warning(NOT_PAY);
      reset(); onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-bold">
            {isAdd ? 'Add staff to tax register' : `Edit statutory tax IDs — ${row?.full_name ?? ''}`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isAdd ? 'Register employee TIN and NSSF identifiers for statutory reporting.' : 'Update recorded Uganda Revenue Authority TIN and NSSF numbers.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          {isAdd && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Select Staff Member</Label>
              {picked ? (
                <div className="flex items-center justify-between rounded-lg border border-border/80 bg-muted/30 p-2.5 text-xs">
                  <div>
                    <span className="font-semibold text-foreground">{picked.full_name ?? '—'}</span>
                    <span className="text-muted-foreground ml-1.5">({picked.staff_ref || 'No ref'})</span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 text-xs text-primary" onClick={() => setPicked(null)}>Change</Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Search name or staff ref…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="h-8 text-xs pl-8"
                    />
                  </div>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-border/70 bg-card divide-y divide-border/40">
                    {opts.isLoading ? <p className="p-3 text-xs text-muted-foreground text-center">Loading staff directory…</p>
                      : opts.error ? <p className="p-3 text-xs text-destructive text-center">{(opts.error as Error).message}</p>
                      : filtered.length === 0 ? <p className="p-3 text-xs text-muted-foreground text-center">No staff found.</p>
                      : filtered.map((o) => (
                        <button key={o.staff_id} type="button" onClick={() => setPicked(o)}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-muted/60 transition-colors flex items-center justify-between">
                          <span className="font-medium text-foreground">{o.full_name ?? '—'}</span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">{o.staff_ref}</span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">TIN (10-digit URA Tax Number)</Label>
            <Input
              inputMode="numeric"
              maxLength={10}
              placeholder={row?.tin ?? 'e.g. 1000123456'}
              value={tin}
              onChange={(e) => setTin(e.target.value.replace(/\D/g, ''))}
              className="h-8 text-xs font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">NSSF Number</Label>
            <Input
              maxLength={30}
              placeholder={row?.nssf_number ?? 'e.g. 1234567890'}
              value={nssf}
              onChange={(e) => setNssf(e.target.value)}
              className="h-8 text-xs font-mono"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">Leave a field blank to preserve the currently recorded value.</p>
          {isAdd && (
            <div className="rounded-lg bg-muted/40 p-2.5 border border-border/60">
              <p className="text-[11px] text-muted-foreground leading-relaxed">{NOT_PAY}</p>
            </div>
          )}
          {err && <p className="text-xs text-destructive font-medium">{err}</p>}
        </div>
        <DialogFooter className="pt-2">
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button size="sm" className="h-8 text-xs" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save Tax IDs'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StatutoryConsentList() {
  const qc = useQueryClient();
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filterMissing, setFilterMissing] = useState(false);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['cfo-staff-tax-register'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_staff_tax_register' as never);
      if (error) throw error;
      return ((data ?? []) as Row[]).sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
    },
  });

  const allRows = data ?? [];
  const period = allRows[0]?.period_code ?? '';

  const filteredRows = useMemo(() => {
    let list = allRows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) =>
        (r.full_name ?? '').toLowerCase().includes(q) ||
        (r.staff_ref ?? '').toLowerCase().includes(q) ||
        (r.phone ?? '').toLowerCase().includes(q) ||
        (r.tin ?? '').toLowerCase().includes(q) ||
        (r.nssf_number ?? '').toLowerCase().includes(q)
      );
    }
    if (filterMissing) {
      list = list.filter((r) => !r.tin || !r.nssf_number);
    }
    return list;
  }, [allRows, search, filterMissing]);

  const totals = useMemo(() => {
    const t = Object.fromEntries(AMT.map((k) => [k, 0])) as Record<(typeof AMT)[number], number>;
    filteredRows.forEach((r) => AMT.forEach((k) => { t[k] += n(r[k]); }));
    return t;
  }, [filteredRows]);

  const missingTinCount = useMemo(() => allRows.filter((r) => !r.tin).length, [allRows]);
  const missingNssfCount = useMemo(() => allRows.filter((r) => !r.nssf_number).length, [allRows]);

  const refetch = () => qc.invalidateQueries({ queryKey: ['cfo-staff-tax-register'] });

  const downloadCsv = () => {
    const head = ['#', 'Name', 'Staff ref', 'Phone', 'Source', 'TIN', 'NSSF no.', 'Gross', 'PAYE', 'NSSF 5%', 'NSSF 10%', 'NSSF total', 'LST', 'Total to remit'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = filteredRows.map((r, i) => [
      i + 1,
      r.full_name,
      r.staff_ref,
      r.phone,
      SOURCE[r.source]?.label ?? r.source,
      r.tin ?? 'Missing',
      r.nssf_number ?? 'Missing',
      ...AMT.map((k) => n(r[k]))
    ]);
    lines.push(['', 'TOTAL', '', '', '', '', '', ...AMT.map((k) => totals[k])]);
    const csv = [head, ...lines].map((l) => l.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `staff-tax-register-${period || 'latest'}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      {/* Executive Command Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/60 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Landmark className="h-4 w-4" />
            </span>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">
              Staff Tax Register
            </h1>
            {period ? (
              <Badge variant="secondary" className="text-xs font-semibold bg-primary/10 text-primary border-primary/20">
                {period}
              </Badge>
            ) : null}
            <Badge variant="outline" className="text-[10px] font-semibold uppercase tracking-wider bg-muted/60 text-muted-foreground border-border/80">
              Statutory
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground max-w-2xl leading-relaxed">
            Statutory tax compliance tracking for URA (PAYE, LST) and NSSF (15%) remittances across staff payroll runs.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={downloadCsv}
            disabled={!filteredRows.length}
            className="h-8 gap-1.5 rounded-lg text-xs font-medium border-border/80 hover:bg-muted/80 shadow-2xs"
          >
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Download CSV</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            className="h-8 gap-1.5 rounded-lg text-xs font-semibold shadow-2xs"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Staff</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={refetch}
            disabled={isFetching}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
            title="Refresh register"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      {/* KPI Metric Strip */}
      <section aria-label="Statutory summary" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3.5">
        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">Staff Enrolled</span>
            <Users className="h-3.5 w-3.5 text-primary shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">{allRows.length}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
            {missingTinCount > 0 ? `${missingTinCount} missing TIN` : 'All TINs recorded'}
          </p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">Gross Payroll</span>
            <Receipt className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">{ugx(totals.gross)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Subject to assessment</p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">PAYE (URA)</span>
            <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/30 text-primary">URA</Badge>
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">{ugx(totals.paye)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Income tax withheld</p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">NSSF Staff (5%)</span>
            <Badge variant="outline" className="text-[9px] px-1 py-0">5%</Badge>
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">{ugx(totals.nssf_employee)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Employee contribution</p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">NSSF Total (15%)</span>
            <Badge variant="outline" className="text-[9px] px-1 py-0 border-blue-500/30 text-blue-600 dark:text-blue-400">15%</Badge>
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-blue-600 dark:text-blue-400 truncate">{ugx(totals.nssf_total)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">5% staff + 10% employer</p>
        </div>

        <div className="min-w-0 rounded-xl border border-border/80 bg-card p-3.5 shadow-2xs bg-primary/5 border-primary/20">
          <div className="flex items-center justify-between gap-1 mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-primary truncate">Total Remittance</span>
            <ShieldCheck className="h-3.5 w-3.5 text-primary shrink-0" />
          </div>
          <p className="text-base sm:text-lg font-bold tabular-nums tracking-tight text-foreground truncate">{ugx(totals.total_remittance)}</p>
          <p className="text-[10px] text-primary/80 mt-0.5 truncate">PAYE + NSSF + LST</p>
        </div>
      </section>

      {/* Main Ledger Card */}
      <Card className="rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden">
        {/* Filter and Search Bar */}
        <div className="p-3.5 sm:p-4 border-b border-border/60 bg-muted/15 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search staff, ref, phone, TIN…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 pr-7 text-xs bg-background"
              aria-label="Search staff tax register"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {(missingTinCount > 0 || missingNssfCount > 0) && (
              <Button
                variant={filterMissing ? 'secondary' : 'outline'}
                size="sm"
                className={`h-8 text-xs gap-1.5 ${filterMissing ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30' : ''}`}
                onClick={() => setFilterMissing(!filterMissing)}
              >
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span>Missing IDs ({missingTinCount + missingNssfCount})</span>
              </Button>
            )}

            <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pl-1">
              Showing <strong className="text-foreground">{filteredRows.length}</strong> of {allRows.length} staff
            </span>
          </div>
        </div>

        {/* Register Table */}
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
              <RefreshCw className="h-5 w-5 animate-spin text-primary" />
              <span className="text-xs font-medium">Loading tax register…</span>
            </div>
          ) : error ? (
            <div className="p-8 text-center text-xs text-destructive">
              Could not load staff tax register: {(error as Error).message}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="p-12 text-center text-xs text-muted-foreground">
              No staff records match your search query.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/30 hover:bg-muted/30 text-[11px] text-muted-foreground uppercase tracking-wider">
                    <TableHead className="py-2.5 px-3 w-10 text-center font-semibold">#</TableHead>
                    <TableHead className="py-2.5 px-3 min-w-[200px] font-semibold">Staff Member</TableHead>
                    <TableHead className="py-2.5 px-3 font-semibold">Source</TableHead>
                    <TableHead className="py-2.5 px-3 font-semibold">TIN (URA)</TableHead>
                    <TableHead className="py-2.5 px-3 font-semibold">NSSF No.</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">Gross (UGX)</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">PAYE (UGX)</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">NSSF 5%</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">NSSF 10%</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">NSSF Total</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold">LST</TableHead>
                    <TableHead className="py-2.5 px-3 text-right font-semibold text-foreground">Total to Remit</TableHead>
                    <TableHead className="py-2.5 px-2 w-10 text-center"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.map((r, i) => {
                    const src = SOURCE[r.source] ?? { label: r.source, badgeCls: 'bg-muted text-muted-foreground' };
                    return (
                      <TableRow key={r.staff_id} className="hover:bg-muted/40 transition-colors">
                        <TableCell className="py-3 px-3 text-center text-xs text-muted-foreground tabular-nums">
                          {i + 1}
                        </TableCell>
                        <TableCell className="py-3 px-3">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-semibold text-xs text-foreground leading-tight">
                              {r.full_name ?? '—'}
                            </span>
                            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
                              {r.staff_ref && <span>{r.staff_ref}</span>}
                              {r.staff_ref && r.phone && <span>·</span>}
                              {r.phone && <span>{r.phone}</span>}
                            </div>
                            {r.starts_next_run && (
                              <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                                Deductions commence next run
                              </span>
                            )}
                            {!r.paye_on && !r.nssf_on && (
                              <span className="text-[10px] text-rose-600 dark:text-rose-400 font-medium">
                                Inactive in payroll (HR action pending)
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="py-3 px-3 whitespace-nowrap">
                          <Badge variant="outline" className={`text-[10px] font-medium border ${src.badgeCls}`}>
                            {src.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="py-3 px-3 whitespace-nowrap text-xs font-mono">
                          {r.tin ? <span className="text-foreground font-medium">{r.tin}</span> : <MissingTag label="No TIN" />}
                        </TableCell>
                        <TableCell className="py-3 px-3 whitespace-nowrap text-xs font-mono">
                          {r.nssf_number ? <span className="text-foreground font-medium">{r.nssf_number}</span> : <MissingTag label="No NSSF" />}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap font-medium text-foreground">
                          {ugx(n(r.gross))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap text-foreground">
                          {ugx(n(r.paye))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap text-muted-foreground">
                          {ugx(n(r.nssf_employee))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap text-muted-foreground">
                          {ugx(n(r.nssf_employer))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap font-medium text-blue-600 dark:text-blue-400">
                          {ugx(n(r.nssf_total))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap text-muted-foreground">
                          {ugx(n(r.lst))}
                        </TableCell>
                        <TableCell className="py-3 px-3 text-right tabular-nums text-xs whitespace-nowrap font-bold text-foreground bg-primary/5">
                          {ugx(n(r.total_remittance))}
                        </TableCell>
                        <TableCell className="py-3 px-2 text-center">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Edit tax IDs for ${r.full_name ?? 'staff'}`}
                            onClick={() => setEditRow(r)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow className="bg-muted/40 font-bold text-xs border-t-2 border-border/80">
                    <TableCell colSpan={5} className="py-3 px-4 font-bold text-foreground">
                      Total ({filteredRows.length} staff)
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-bold text-foreground">
                      {ugx(totals.gross)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-bold text-foreground">
                      {ugx(totals.paye)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-semibold text-foreground">
                      {ugx(totals.nssf_employee)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-semibold text-foreground">
                      {ugx(totals.nssf_employer)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-bold text-blue-600 dark:text-blue-400">
                      {ugx(totals.nssf_total)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-semibold text-foreground">
                      {ugx(totals.lst)}
                    </TableCell>
                    <TableCell className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-extrabold text-foreground bg-primary/10">
                      {ugx(totals.total_remittance)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <IdsDialog key={editRow?.staff_id ?? 'none'} open={!!editRow} row={editRow} onClose={() => setEditRow(null)} onSaved={refetch} />
      <IdsDialog open={addOpen} row={null} onClose={() => setAddOpen(false)} onSaved={refetch} />
    </div>
  );
}

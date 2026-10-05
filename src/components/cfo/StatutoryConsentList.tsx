import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Download } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Row = {
  run_id: string; period_code: string | null; staff_id: string; staff_ref: string | null;
  full_name: string | null; phone: string | null; source: 'survey' | 'payroll' | 'cfo_added';
  tin: string | null; nssf_number: string | null; paye_on: boolean; nssf_on: boolean;
  starts_next_run: boolean; gross: number; paye: number; nssf_employee: number;
  nssf_employer: number; nssf_total: number; lst: number; total_remittance: number;
};
type StaffOpt = { staff_id: string; staff_ref: string | null; full_name: string | null };

const NOT_PAY = 'This records their tax IDs only. It does not change their pay — switching PAYE/NSSF on is done by HR.';
const SOURCE: Record<Row['source'], string> = { survey: 'Survey', payroll: 'Already on payroll tax', cfo_added: 'Added by CFO' };
const n = (v: unknown) => Number(v ?? 0);
const ugx = (v: number) => `UGX ${Math.round(v).toLocaleString('en-US')}`;
const AMT = ['gross', 'paye', 'nssf_employee', 'nssf_employer', 'nssf_total', 'lst', 'total_remittance'] as const;

function Missing() { return <span className="font-medium text-destructive">Missing</span>; }

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
      toast.success('Tax IDs saved');
      if (isAdd && res?.tax_on_in_payroll === false) toast.warning(NOT_PAY);
      reset(); onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{isAdd ? 'Add staff to tax register' : `Edit tax IDs — ${row?.full_name ?? ''}`}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {isAdd && (
            <div className="space-y-2">
              <Label>Staff member</Label>
              {picked ? (
                <div className="flex items-center justify-between rounded-md border p-2 text-sm">
                  <span>{picked.full_name ?? '—'} <span className="text-muted-foreground">{picked.staff_ref}</span></span>
                  <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>Change</Button>
                </div>
              ) : (
                <>
                  <Input placeholder="Search name or staff ref" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <div className="max-h-48 overflow-y-auto rounded-md border">
                    {opts.isLoading ? <p className="p-2 text-sm text-muted-foreground">Loading…</p>
                      : opts.error ? <p className="p-2 text-sm text-destructive">{(opts.error as Error).message}</p>
                      : filtered.length === 0 ? <p className="p-2 text-sm text-muted-foreground">No staff found.</p>
                      : filtered.map((o) => (
                        <button key={o.staff_id} type="button" onClick={() => setPicked(o)}
                          className="block w-full px-2 py-1.5 text-left text-sm hover:bg-muted">
                          {o.full_name ?? '—'} <span className="text-muted-foreground">{o.staff_ref}</span>
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="space-y-2">
            <Label>TIN (10 digits)</Label>
            <Input inputMode="numeric" maxLength={10} placeholder={row?.tin ?? ''} value={tin} onChange={(e) => setTin(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="space-y-2">
            <Label>NSSF number</Label>
            <Input maxLength={30} placeholder={row?.nssf_number ?? ''} value={nssf} onChange={(e) => setNssf(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">Leave a field blank to keep the existing value.</p>
          {isAdd && <p className="text-xs text-muted-foreground">{NOT_PAY}</p>}
          {err && <p className="text-sm text-destructive">{err}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function StatutoryConsentList() {
  const qc = useQueryClient();
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['cfo-staff-tax-register'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_staff_tax_register' as never);
      if (error) throw error;
      return ((data ?? []) as Row[]).sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''));
    },
  });
  const rows = data ?? [];
  const period = rows[0]?.period_code ?? '';
  const totals = useMemo(() => {
    const t = Object.fromEntries(AMT.map((k) => [k, 0])) as Record<(typeof AMT)[number], number>;
    rows.forEach((r) => AMT.forEach((k) => { t[k] += n(r[k]); }));
    return t;
  }, [rows]);
  const refetch = () => qc.invalidateQueries({ queryKey: ['cfo-staff-tax-register'] });

  const downloadCsv = () => {
    const head = ['#', 'Name', 'Staff ref', 'Phone', 'Source', 'TIN', 'NSSF no.', 'Gross', 'PAYE', 'NSSF 5%', 'NSSF 10%', 'NSSF total', 'LST', 'Total to remit'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r, i) => [i + 1, r.full_name, r.staff_ref, r.phone, SOURCE[r.source], r.tin ?? 'Missing', r.nssf_number ?? 'Missing', ...AMT.map((k) => n(r[k]))]);
    lines.push(['', 'TOTAL', '', '', '', '', '', ...AMT.map((k) => totals[k])]);
    const csv = [head, ...lines].map((l) => l.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `staff-tax-register-${period || 'latest'}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const cards: [string, number][] = [
    ['PAYE', totals.paye], ['NSSF staff 5%', totals.nssf_employee], ['NSSF employer 10%', totals.nssf_employer],
    ['NSSF total 15%', totals.nssf_total], ['LST', totals.lst], ['Total to remit', totals.total_remittance],
  ];

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Staff tax register{period ? ` — ${period}` : ''}</CardTitle>
            <p className="text-sm text-muted-foreground">
              Staff with PAYE/NSSF on payroll, staff who accepted tax in the survey, and staff added by the CFO. Amounts are from this payroll run.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus className="mr-1 h-4 w-4" />Add staff</Button>
            <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!rows.length}><Download className="mr-1 h-4 w-4" />Download CSV</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
          : error ? <p className="text-sm text-destructive">{(error as Error).message}</p>
          : !rows.length ? <p className="text-sm text-muted-foreground">No staff on the tax register for this run.</p>
          : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                <div className="rounded-md border p-3"><p className="text-xs text-muted-foreground">Staff</p><p className="text-lg font-semibold">{rows.length}</p></div>
                {cards.map(([l, v]) => (
                  <div key={l} className="rounded-md border p-3"><p className="text-xs text-muted-foreground">{l}</p><p className="text-sm font-semibold">{ugx(v)}</p></div>
                ))}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Phone</TableHead><TableHead>Source</TableHead>
                    <TableHead>TIN</TableHead><TableHead>NSSF no.</TableHead>
                    <TableHead className="text-right">Gross</TableHead><TableHead className="text-right">PAYE</TableHead>
                    <TableHead className="text-right">NSSF 5%</TableHead><TableHead className="text-right">NSSF 10%</TableHead>
                    <TableHead className="text-right">NSSF total</TableHead><TableHead className="text-right">LST</TableHead>
                    <TableHead className="text-right">Total to remit</TableHead><TableHead />
                  </TableRow></TableHeader>
                  <TableBody>
                    {rows.map((r, i) => (
                      <TableRow key={r.staff_id}>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell className="min-w-[180px]">
                          <div className="font-medium">{r.full_name ?? '—'}</div>
                          {r.staff_ref && <div className="text-xs text-muted-foreground">{r.staff_ref}</div>}
                          {r.starts_next_run && <div className="text-xs text-muted-foreground">Deductions start next payroll</div>}
                          {!r.paye_on && !r.nssf_on && <div className="text-xs text-destructive">PAYE/NSSF off in payroll — HR to switch on</div>}
                        </TableCell>
                        <TableCell>{r.phone ?? '—'}</TableCell>
                        <TableCell><Badge variant="secondary" className="whitespace-nowrap">{SOURCE[r.source]}</Badge></TableCell>
                        <TableCell>{r.tin ?? <Missing />}</TableCell>
                        <TableCell>{r.nssf_number ?? <Missing />}</TableCell>
                        {AMT.map((k) => <TableCell key={k} className="whitespace-nowrap text-right">{ugx(n(r[k]))}</TableCell>)}
                        <TableCell>
                          <Button size="icon" variant="ghost" aria-label="Edit tax IDs" onClick={() => setEditRow(r)}><Pencil className="h-4 w-4" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter><TableRow>
                    <TableCell colSpan={6} className="font-semibold">Total</TableCell>
                    {AMT.map((k) => <TableCell key={k} className="whitespace-nowrap text-right font-semibold">{ugx(totals[k])}</TableCell>)}
                    <TableCell />
                  </TableRow></TableFooter>
                </Table>
              </div>
            </>
          )}
      </CardContent>
      <IdsDialog key={editRow?.staff_id ?? 'none'} open={!!editRow} row={editRow} onClose={() => setEditRow(null)} onSaved={refetch} />
      <IdsDialog open={addOpen} row={null} onClose={() => setAddOpen(false)} onSaved={refetch} />
    </Card>
  );
}

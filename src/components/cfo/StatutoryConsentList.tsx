import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = {
  run_id: string | null; paid_at: string | null; user_id: string; full_name: string | null; phone: string | null;
  tin: string | null; nssf_number: string | null; responded_at: string;
};

const fmt = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const fmtDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', year: 'numeric' });
const byName = (a: Row, b: Row) => (a.full_name ?? '').localeCompare(b.full_name ?? '');

function Missing() {
  return <span className="font-medium text-destructive">Missing</span>;
}

function Group({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <Table>
        <TableHeader><TableRow>
          <TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Phone</TableHead>
          <TableHead>TIN</TableHead><TableHead>NSSF number</TableHead><TableHead>Accepted</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.user_id}>
              <TableCell>{i + 1}</TableCell><TableCell>{r.full_name ?? '—'}</TableCell>
              <TableCell>{r.phone ?? '—'}</TableCell>
              <TableCell>{r.tin ?? <Missing />}</TableCell>
              <TableCell>{r.nssf_number ?? <Missing />}</TableCell>
              <TableCell>{fmt(r.responded_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function StatutoryConsentList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cfo-statutory-consent-list'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_statutory_consent_list' as never);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const paid = (data ?? []).filter((r) => r.run_id).sort(byName);
  const current = (data ?? []).filter((r) => !r.run_id).sort(byName);
  const paidAt = paid[0]?.paid_at;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Staff tax registrations</CardTitle>
        <p className="text-sm text-muted-foreground">
          Staff who accepted gross pay (PAYE and NSSF).
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
          : error ? <p className="text-sm text-destructive">{(error as Error).message}</p>
          : !data?.length ? <p className="text-sm text-muted-foreground">No staff tax acceptances yet.</p>
          : (
            <>
              {paid.length > 0 && (
                <Group
                  title={`Paid in payroll run of ${paidAt ? fmtDate(paidAt) : '—'} — register with URA/NSSF`}
                  rows={paid}
                />
              )}
              {current.length > 0 && <Group title="Accepted this cycle — not yet paid" rows={current} />}
            </>
          )}
      </CardContent>
    </Card>
  );
}

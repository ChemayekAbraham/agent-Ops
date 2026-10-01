import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Row = {
  run_id: string; paid_at: string; user_id: string; full_name: string | null; phone: string | null;
  tin: string | null; nssf_number: string | null; responded_at: string;
};

const fmt = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });

export function StatutoryConsentList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['cfo-statutory-consent-list'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_statutory_consent_list' as never);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gross pay consent — staff with TIN / NSSF</CardTitle>
        <p className="text-sm text-muted-foreground">
          Staff who accepted gross pay (PAYE and NSSF) with a TIN, an NSSF number, or both, before the last payroll was paid.
          {data?.[0] && <> Payroll paid {fmt(data[0].paid_at)}.</>}
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
          : error ? <p className="text-sm text-destructive">{(error as Error).message}</p>
          : !data?.length ? <p className="text-sm text-muted-foreground">The list appears here after the next payroll is paid.</p>
          : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Phone</TableHead>
                <TableHead>TIN</TableHead><TableHead>NSSF number</TableHead><TableHead>Accepted</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.map((r, i) => (
                  <TableRow key={r.user_id}>
                    <TableCell>{i + 1}</TableCell><TableCell>{r.full_name ?? '—'}</TableCell>
                    <TableCell>{r.phone ?? '—'}</TableCell><TableCell>{r.tin ?? '—'}</TableCell>
                    <TableCell>{r.nssf_number ?? '—'}</TableCell><TableCell>{fmt(r.responded_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </CardContent>
    </Card>
  );
}

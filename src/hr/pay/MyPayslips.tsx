import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Receipt } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { listMyPayslips, type MyPayslipRow } from '@/hr/pay/api/myPay';

const headCell = 'text-[11px] font-semibold uppercase tracking-wider text-muted-foreground';

function formatAmount(value: number): string {
  return new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Employee self-service list of their own paid payslips. */
export default function MyPayslips() {
  const [rows, setRows] = useState<MyPayslipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await listMyPayslips();
        if (alive) setRows(data);
      } catch (err) {
        if (alive) setError((err as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <PersonalLayout title="My payslips">
      <Card className="overflow-hidden border-border/70 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Receipt className="h-4 w-4" />
            </span>
            <div>
              <CardTitle className="text-sm font-semibold tracking-tight">Your pay records</CardTitle>
              <p className="text-[11px] text-muted-foreground">Amounts shown in UGX</p>
            </div>
          </div>
          {!loading && !error && rows.length > 0 && (
            <Badge
              variant="outline"
              className="rounded-full border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary"
            >
              {rows.length}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="border-b border-border/60 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          {loading && (
            <div className="space-y-2.5 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <FileText className="h-5 w-5" />
              </span>
              <p className="text-sm font-medium">No payslips yet</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                They appear here once a payroll run has been paid.
              </p>
            </div>
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="[&_tr]:border-b [&_tr]:border-border/60">
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className={headCell}>Period</TableHead>
                    <TableHead className={headCell}>Pay date</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>Gross</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>PAYE</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>NSSF</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>Deductions</TableHead>
                    <TableHead className={cn(headCell, 'text-right')}>Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="border-border/50 transition-colors hover:bg-primary/[0.04]"
                    >
                      <TableCell className="py-3">
                        <Link
                          className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                          to={`/hr/pay/payslips/${r.id}`}
                        >
                          {r.period_code ?? '—'}
                        </Link>
                      </TableCell>
                      <TableCell className="py-3 text-xs tabular-nums text-muted-foreground">
                        <Link
                          className="underline-offset-4 hover:underline"
                          to={`/hr/pay/payslips/${r.id}`}
                        >
                          {formatDate(r.pay_date)}
                        </Link>
                      </TableCell>
                      <TableCell className="py-3 text-right text-sm tabular-nums">
                        {formatAmount(r.gross)}
                      </TableCell>
                      <TableCell className="py-3 text-right text-sm tabular-nums text-muted-foreground">
                        {formatAmount(r.paye)}
                      </TableCell>
                      <TableCell className="py-3 text-right text-sm tabular-nums text-muted-foreground">
                        {formatAmount(r.nssf_employee)}
                      </TableCell>
                      <TableCell className="py-3 text-right text-sm tabular-nums text-muted-foreground">
                        {formatAmount(r.other_deductions)}
                      </TableCell>
                      <TableCell className="py-3 text-right text-sm font-semibold tabular-nums">
                        {formatAmount(r.net)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
            This is your own record. If any figure looks wrong, contact HR.
          </p>
        </CardContent>
      </Card>
    </PersonalLayout>
  );
}

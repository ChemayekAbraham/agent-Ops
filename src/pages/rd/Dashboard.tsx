import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import WelileLogo from '@/components/WelileLogo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

type Idea = { name: string; customers: number | null; cashIn: number | null; cashOut: number | null; net: number | null };

// Figures as supplied by R&D (2026-10-02). Blank cells are not yet reported.
const IDEAS: Idea[] = [
  { name: 'Welile Car', customers: 19, cashIn: 21_000_000, cashOut: 38_000_000, net: 17_000_000 },
  { name: 'Welile Dowry', customers: null, cashIn: null, cashOut: null, net: null },
  { name: 'Welile Home', customers: null, cashIn: null, cashOut: null, net: null },
  { name: 'Welile School of AI', customers: null, cashIn: null, cashOut: null, net: null },
];

const DASH = <span className="text-muted-foreground">—</span>;
const count = (v: number | null) => (v === null ? DASH : v.toLocaleString('en-US'));
const cash = (v: number | null) => (v === null ? DASH : formatUGX(v));

export default function RDDashboard() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2">
          <Button variant="ghost" size="sm" className="gap-1.5 px-2" onClick={() => navigate('/admin/dashboard')}>
            <ArrowLeft className="h-4 w-4" />
            Back to dashboards
          </Button>
          <WelileLogo showText={false} size="sm" linkToHome={false} className="ml-auto" />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-5">
        <div className="rounded-2xl border border-border/80 bg-gradient-to-r from-card via-card to-muted/20 p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
                <FlaskConical className="h-5 w-5 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Internal
                </p>
                <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                  Research &amp; Development
                </h1>
                <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  New Welile business ideas and how each one is performing so far — customers
                  served, cash in, cash out and net position.
                </p>
              </div>
            </div>
            <div className="shrink-0 sm:text-right">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                Reported
              </p>
              <p className="text-sm font-semibold text-foreground">2 October 2026</p>
            </div>
          </div>
        </div>
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Business ideas</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Business idea</TableHead>
                  <TableHead className="text-right">No. of customers</TableHead>
                  <TableHead className="text-right">Cash in</TableHead>
                  <TableHead className="text-right">Cash out</TableHead>
                  <TableHead className="text-right">Net position</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {IDEAS.map((i) => (
                  <TableRow key={i.name}>
                    <TableCell className="font-medium">{i.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{count(i.customers)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cash(i.cashIn)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cash(i.cashOut)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{cash(i.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

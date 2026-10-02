import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Idea = { name: string; customers: number | null; cashIn: string | null; cashOut: string | null; net: string | null };

// Figures as supplied by R&D (2026-10-02). Blank cells are not yet reported.
const IDEAS: Idea[] = [
  { name: 'Welile Car', customers: 19, cashIn: 'UGX 21M', cashOut: 'UGX 38M', net: 'UGX 17M' },
  { name: 'Welile Dowry', customers: null, cashIn: null, cashOut: null, net: null },
  { name: 'Welile Home', customers: null, cashIn: null, cashOut: null, net: null },
  { name: 'Welile School of AI', customers: null, cashIn: null, cashOut: null, net: null },
];

const cell = (v: string | number | null) => (v === null ? <span className="text-muted-foreground">—</span> : v);

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
          <div className="ml-auto flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-bold text-foreground">R&amp;D</h1>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-4">
        <Card>
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
                    <TableCell className="text-right tabular-nums">{cell(i.customers)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(i.cashIn)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(i.cashOut)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{cell(i.net)}</TableCell>
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

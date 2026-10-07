import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Users, Wallet, CalendarClock, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { LendingLoan, outstandingOf, dueStateOf } from '@/components/vouch/agent/lendingHelpers';

interface BorrowerGroup {
  key: string;
  name: string;
  phone?: string | null;
  loans: LendingLoan[];
  totalOwed: number;
  overdueCount: number;
  nextDue: string | null;
}

const isOpen = (l: LendingLoan) => l.status === 'active' || l.status === 'partially_repaid';
const nextDateOf = (l: LendingLoan) => l.next_deduction_date || l.expected_repayment_date || null;
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export default function LoanDashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loans, setLoans] = useState<LendingLoan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await (supabase
        .from('lending_agent_loans' as any)
        .select('*')
        .eq('lender_agent_id', user.id)
        .in('status', ['active', 'partially_repaid'])
        .order('created_at', { ascending: false })
        .limit(1000) as any);
      setLoans((data as LendingLoan[]) || []);
      setLoading(false);
    })();
  }, [user]);

  const { groups, totals } = useMemo(() => {
    const map = new Map<string, BorrowerGroup>();
    for (const l of loans.filter(isOpen)) {
      const key = l.borrower_ai_id || l.borrower_phone || l.id;
      const g = map.get(key) ?? {
        key, name: l.borrower_display_name || 'Borrower', phone: l.borrower_phone,
        loans: [], totalOwed: 0, overdueCount: 0, nextDue: null,
      };
      g.loans.push(l);
      g.totalOwed += outstandingOf(l);
      if (dueStateOf(l) === 'overdue') g.overdueCount += 1;
      const nd = nextDateOf(l);
      if (nd && (!g.nextDue || nd < g.nextDue)) g.nextDue = nd;
      map.set(key, g);
    }
    const list = [...map.values()].sort(
      (a, b) => b.overdueCount - a.overdueCount || b.totalOwed - a.totalOwed,
    );
    return {
      groups: list,
      totals: {
        owed: list.reduce((s, g) => s + g.totalOwed, 0),
        overdue: list.reduce((s, g) => s + g.overdueCount, 0),
        loans: list.reduce((s, g) => s + g.loans.length, 0),
      },
    };
  }, [loans]);

  return (
    <main className="min-h-screen bg-background pb-10">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-lg font-bold">Loan Dashboard</h1>
      </header>

      <div className="mx-auto max-w-3xl space-y-4 p-3">
        <div className="grid grid-cols-3 gap-2">
          <Card><CardContent className="p-3">
            <Wallet className="mb-1 h-4 w-4 text-primary" />
            <p className="text-[11px] text-muted-foreground">Total owed</p>
            <p className="text-sm font-bold">{formatUGX(totals.owed)}</p>
          </CardContent></Card>
          <Card><CardContent className="p-3">
            <Users className="mb-1 h-4 w-4 text-primary" />
            <p className="text-[11px] text-muted-foreground">Borrowers</p>
            <p className="text-sm font-bold">{groups.length} <span className="text-xs font-normal">({totals.loans} loans)</span></p>
          </CardContent></Card>
          <Card><CardContent className="p-3">
            <AlertTriangle className="mb-1 h-4 w-4 text-destructive" />
            <p className="text-[11px] text-muted-foreground">Overdue</p>
            <p className="text-sm font-bold text-destructive">{totals.overdue}</p>
          </CardContent></Card>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : groups.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">No active loans yet.</p>
        ) : (
          groups.map((g) => (
            <Card key={g.key} className={g.overdueCount ? 'border-destructive/50' : undefined}>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{g.name}</p>
                    {g.phone && <p className="text-xs text-muted-foreground">{g.phone}</p>}
                  </div>
                  {g.overdueCount > 0 ? (
                    <Badge variant="destructive">{g.overdueCount} overdue</Badge>
                  ) : (
                    <Badge variant="secondary">On time</Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Total owed</p>
                    <p className="font-bold">{formatUGX(g.totalOwed)}</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <CalendarClock className="h-3 w-3" /> Next payment due
                    </p>
                    <p className="font-bold">{fmtDate(g.nextDue)}</p>
                  </div>
                </div>
                {g.loans.length > 1 && (
                  <ul className="space-y-1 border-t pt-2 text-xs">
                    {g.loans.map((l) => (
                      <li key={l.id} className="flex justify-between gap-2">
                        <span className="text-muted-foreground">
                          {formatUGX(l.principal_ugx)} · due {fmtDate(nextDateOf(l))}
                        </span>
                        <span className={dueStateOf(l) === 'overdue' ? 'font-semibold text-destructive' : 'font-medium'}>
                          {formatUGX(outstandingOf(l))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </main>
  );
}

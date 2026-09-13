import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, TrendingUp, TrendingDown, DollarSign, Download, FileDown } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, startOfDay } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { cn } from '@/lib/utils';
import { exportCategoryReport, exportAllCategoriesReport } from '@/lib/categoryReportExport';
import { toast } from 'sonner';
import { CFO_REVENUE_CATEGORIES, CFO_EXPENSE_CATEGORIES } from '@/lib/ledgerConstants';
import { TX_ITEM_OPTIONS, type TxItemFilter } from '@/lib/transactionsFeed';
import { welileItemImage } from '@/lib/welileItemImages';

const REVENUE_CATEGORY_CODES = CFO_REVENUE_CATEGORIES.map(c => c.category);
const EXPENSE_CATEGORY_CODES = CFO_EXPENSE_CATEGORIES.map(c => c.category);
const REVENUE_LABEL_MAP: Record<string, string> = Object.fromEntries(CFO_REVENUE_CATEGORIES.map(c => [c.category, c.label]));
const EXPENSE_LABEL_MAP: Record<string, string> = Object.fromEntries(CFO_EXPENSE_CATEGORIES.map(c => [c.category, c.label]));

const PIE_COLORS = [
  'hsl(var(--primary))', 'hsl(var(--success))', 'hsl(142, 76%, 36%)',
  'hsl(var(--warning))', 'hsl(var(--destructive))', 'hsl(262, 83%, 58%)',
  'hsl(31, 92%, 50%)', 'hsl(199, 89%, 48%)', 'hsl(330, 81%, 60%)',
  'hsl(173, 80%, 40%)', 'hsl(280, 65%, 60%)', 'hsl(45, 93%, 47%)',
];

export function RevenueExpenseDashboard() {
  // Welile item filter: 'all' keeps the company-wide view; picking an item
  // re-reads the same platform records restricted to entries whose text names
  // that item, so Revenue / Expenses / Net Income / Margin all become per-item.
  const [item, setItem] = useState<TxItemFilter>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['revenue-expense-dashboard', item],
    queryFn: async () => {
      const startDate = startOfDay(subDays(new Date(), 29)).toISOString();

      let query = supabase
        .from('general_ledger')
        .select('amount, direction, category, transaction_date')
        .gte('transaction_date', startDate)
        .eq('ledger_scope', 'platform');
      if (item !== 'all') query = query.ilike('description', `%${item}%`);
      const { data: ledger, error } = await query;
      if (error) throw error;

      // Totals — accumulate by category, including zero buckets so every canonical category is visible.
      let totalRevenue = 0, totalExpenses = 0;
      const revBreakdown: Record<string, number> = Object.fromEntries(REVENUE_CATEGORY_CODES.map(c => [c, 0]));
      const expBreakdown: Record<string, number> = Object.fromEntries(EXPENSE_CATEGORY_CODES.map(c => [c, 0]));

      for (const e of ledger || []) {
        if (REVENUE_CATEGORY_CODES.includes(e.category)) {
          totalRevenue += e.amount;
          revBreakdown[e.category] = (revBreakdown[e.category] || 0) + e.amount;
        }
        if (EXPENSE_CATEGORY_CODES.includes(e.category)) {
          totalExpenses += e.amount;
          expBreakdown[e.category] = (expBreakdown[e.category] || 0) + e.amount;
        }
      }

      // Daily trend (last 30 days)
      const dailyData: any[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = subDays(new Date(), i);
        const dateStr = format(d, 'yyyy-MM-dd');
        const dayEntries = (ledger || []).filter(e => e.transaction_date?.startsWith(dateStr));
        const rev = dayEntries.filter(e => REVENUE_CATEGORY_CODES.includes(e.category)).reduce((s, e) => s + e.amount, 0);
        const exp = dayEntries.filter(e => EXPENSE_CATEGORY_CODES.includes(e.category)).reduce((s, e) => s + e.amount, 0);
        dailyData.push({ date: format(d, 'dd MMM'), revenue: rev, expenses: exp, profit: rev - exp });
      }

      // Build full canonical lists (every category, even 0) — sorted by value desc but zeros kept at the bottom.
      const revPie = REVENUE_CATEGORY_CODES
        .map(k => ({ name: REVENUE_LABEL_MAP[k] || formatCategoryLabel(k), value: revBreakdown[k] || 0, category: k }))
        .sort((a, b) => b.value - a.value);
      const expPie = EXPENSE_CATEGORY_CODES
        .map(k => ({ name: EXPENSE_LABEL_MAP[k] || formatCategoryLabel(k), value: expBreakdown[k] || 0, category: k }))
        .sort((a, b) => b.value - a.value);

      return { totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses, dailyData, revPie, expPie };
    },
    staleTime: 120_000,
  });

  if (isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (!data) return null;

  const margin = data.totalRevenue > 0 ? ((data.netIncome / data.totalRevenue) * 100).toFixed(1) : '0';

  return (
    <div className="space-y-4">
      {/* KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-2 border-success/30"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Revenue (30d)</p><p className="text-xl font-bold font-mono text-success">{formatUGX(data.totalRevenue)}</p></CardContent></Card>
        <Card className="border-2 border-destructive/30"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Expenses (30d)</p><p className="text-xl font-bold font-mono text-destructive">{formatUGX(data.totalExpenses)}</p></CardContent></Card>
        <Card className={cn('border-2', data.netIncome >= 0 ? 'border-primary/30' : 'border-destructive/30')}>
          <CardContent className="p-4 text-center">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Net Income</p>
            <div className="flex items-center justify-center gap-1">
              {data.netIncome >= 0 ? <TrendingUp className="h-4 w-4 text-success" /> : <TrendingDown className="h-4 w-4 text-destructive" />}
              <p className={cn('text-xl font-bold font-mono', data.netIncome >= 0 ? 'text-primary' : 'text-destructive')}>{formatUGX(data.netIncome)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-2"><CardContent className="p-4 text-center"><p className="text-xs text-muted-foreground uppercase tracking-wider">Margin</p><p className="text-2xl font-bold">{margin}%</p></CardContent></Card>
      </div>

      {/* Trend */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><DollarSign className="h-4 w-4 text-primary" />Revenue vs Expenses (30 Days)</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.dailyData}>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval={4} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${(v / 1000000).toFixed(1)}M`} />
              <RechartsTooltip formatter={(v: number) => formatUGX(v)} />
              <Line type="monotone" dataKey="revenue" stroke="hsl(var(--success))" strokeWidth={2} dot={false} name="Revenue" />
              <Line type="monotone" dataKey="expenses" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} name="Expenses" />
              <Line type="monotone" dataKey="profit" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} strokeDasharray="5 5" name="Net" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Breakdown Pies */}
      <div className="grid sm:grid-cols-2 gap-4">
        <CategoryBreakdownCard title="Revenue Breakdown" items={data.revPie} type="revenue" emptyText="No revenue data" />
        <CategoryBreakdownCard title="Expense Breakdown" items={data.expPie} type="expense" emptyText="No expense data" />
      </div>
    </div>
  );
}

interface BreakdownItem { name: string; value: number; category: string }

function CategoryBreakdownCard({ title, items, type, emptyText }: { title: string; items: BreakdownItem[]; type: 'revenue' | 'expense'; emptyText: string }) {
  const [busy, setBusy] = useState<string | null>(null);

  const handleExport = async (item: BreakdownItem) => {
    setBusy(item.category);
    toast.loading(`Generating ${item.name} report...`, { id: item.category });
    try {
      const filename = await exportCategoryReport(item.category, item.name, type);
      toast.success(`Downloaded ${filename}`, { id: item.category });
    } catch (e: any) {
      toast.error(`Export failed: ${e.message || 'Unknown error'}`, { id: item.category });
    } finally {
      setBusy(null);
    }
  };

  const handleExportAll = async () => {
    setBusy('__all__');
    toast.loading(`Generating combined ${type} report...`, { id: '__all__' });
    try {
      const filename = await exportAllCategoriesReport(items.map(i => ({ category: i.category, label: i.name })), type);
      toast.success(`Downloaded ${filename}`, { id: '__all__' });
    } catch (e: any) {
      toast.error(`Export failed: ${e.message || 'Unknown error'}`, { id: '__all__' });
    } finally {
      setBusy(null);
    }
  };

  const nonZeroItems = items.filter(i => i.value > 0);
  const activeCount = nonZeroItems.length;

  return (
    <Card>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div className="flex flex-col">
          <CardTitle className="text-sm">{title}</CardTitle>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {items.length} categories · {activeCount} active in 30d
          </p>
        </div>
        {items.length > 0 && (
          <Button size="sm" variant="outline" onClick={handleExportAll} disabled={busy !== null} className="h-7 text-xs">
            {busy === '__all__' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <FileDown className="h-3 w-3 mr-1" />}
            Export All
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {nonZeroItems.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">{emptyText}</p>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={nonZeroItems} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value" label={({ name }) => name}>
                {nonZeroItems.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <RechartsTooltip formatter={(v: number) => formatUGX(v)} />
            </PieChart>
          </ResponsiveContainer>
        )}
        <div className="mt-3 space-y-1 border-t pt-3 max-h-[320px] overflow-y-auto">
          {items.map((item, i) => {
            const isZero = item.value <= 0;
            return (
              <div
                key={item.category}
                className={cn(
                  'flex items-center justify-between gap-2 text-xs py-1 px-2 rounded transition-colors',
                  isZero ? 'opacity-60 hover:bg-muted/30' : 'hover:bg-muted/50',
                )}
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span
                    className="h-2.5 w-2.5 rounded-full flex-shrink-0"
                    style={{ background: isZero ? 'hsl(var(--muted-foreground) / 0.3)' : PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                  <span className={cn('truncate', isZero ? 'text-muted-foreground' : 'font-medium')}>{item.name}</span>
                </div>
                {isZero ? (
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">No activity</span>
                ) : (
                  <span className="font-mono text-muted-foreground tabular-nums">{formatUGX(item.value)}</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleExport(item)}
                  disabled={busy !== null}
                  className="h-6 w-6 p-0"
                  title={`Export ${item.name} report`}
                >
                  {busy === item.category ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function formatCategoryLabel(cat: string): string {
  return cat.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

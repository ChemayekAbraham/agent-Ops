import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KPICard } from '@/components/executive/KPICard';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, Activity, AlertTriangle, Wrench } from 'lucide-react';

interface ClassificationRow {
  classification: string;
  direction: string;
  count: number;
  total: number;
}

interface CategoryRow {
  classification: string;
  category: string;
  direction: string;
  count: number;
  total: number;
}

const CLASSIFICATION_META: Record<string, { label: string; color: string; bgColor: string; icon: typeof ShieldCheck; badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  production: { label: 'Production', color: 'bg-green-500/10 text-green-600', bgColor: 'bg-green-50 dark:bg-green-950/30', icon: ShieldCheck, badgeVariant: 'default' },
  legacy_real: { label: 'Legacy Real', color: 'bg-blue-500/10 text-blue-600', bgColor: 'bg-blue-50 dark:bg-blue-950/30', icon: Activity, badgeVariant: 'secondary' },
  test_dev: { label: 'Test / Dev', color: 'bg-amber-500/10 text-amber-600', bgColor: 'bg-amber-50 dark:bg-amber-950/30', icon: AlertTriangle, badgeVariant: 'outline' },
  admin_correction: { label: 'Admin Correction', color: 'bg-muted text-muted-foreground', bgColor: 'bg-muted/40', icon: Wrench, badgeVariant: 'outline' },
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);
}

function fmtCount(n: number) {
  return n.toLocaleString();
}

export function LedgerHealthPanel() {
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['ledger-health-summary'],
    queryFn: async () => {
      const res = await supabase
        .from('general_ledger')
        .select('classification, direction, amount')
        .limit(50000);
      if (res.error) throw res.error;

      const rows = res.data || [];
      const map = new Map<string, { cash_in: number; cash_out: number; count_in: number; count_out: number }>();

      for (const r of rows) {
        const cls = (r as any).classification || 'production';
        const dir = (r as any).direction;
        const amt = Number((r as any).amount) || 0;
        if (!map.has(cls)) map.set(cls, { cash_in: 0, cash_out: 0, count_in: 0, count_out: 0 });
        const entry = map.get(cls)!;
        if (dir === 'cash_in') {
          entry.cash_in += amt;
          entry.count_in++;
        } else {
          entry.cash_out += amt;
          entry.count_out++;
        }
      }

      return map;
    },
  });

  const { data: categoryData, isLoading: categoryLoading } = useQuery({
    queryKey: ['ledger-health-categories'],
    queryFn: async () => {
      const res = await supabase
        .from('general_ledger')
        .select('classification, category, direction, amount')
        .limit(50000);
      if (res.error) throw res.error;

      const rows = res.data || [];
      const map = new Map<string, { cash_in: number; cash_out: number; count: number }>();

      for (const r of rows) {
        const cls = (r as any).classification || 'production';
        const cat = (r as any).category || 'unknown';
        const key = `${cls}::${cat}`;
        const dir = (r as any).direction;
        const amt = Number((r as any).amount) || 0;
        if (!map.has(key)) map.set(key, { cash_in: 0, cash_out: 0, count: 0 });
        const entry = map.get(key)!;
        entry.count++;
        if (dir === 'cash_in') entry.cash_in += amt;
        else entry.cash_out += amt;
      }

      const result: { classification: string; category: string; cash_in: number; cash_out: number; count: number; net: number }[] = [];
      map.forEach((v, k) => {
        const [cls, cat] = k.split('::');
        result.push({ classification: cls, category: cat, ...v, net: v.cash_in - v.cash_out });
      });
      result.sort((a, b) => a.classification.localeCompare(b.classification) || b.count - a.count);
      return result;
    },
  });

  const isLoading = summaryLoading || categoryLoading;
  const classifications = ['production', 'legacy_real', 'test_dev', 'admin_correction'];

  const getStats = (cls: string) => {
    if (!summaryData?.has(cls)) return { count: 0, cash_in: 0, cash_out: 0, net: 0 };
    const e = summaryData.get(cls)!;
    return { count: e.count_in + e.count_out, cash_in: e.cash_in, cash_out: e.cash_out, net: e.cash_in - e.cash_out };
  };

  const totalReal = (() => {
    const p = getStats('production');
    const l = getStats('legacy_real');
    return { count: p.count + l.count, net: p.net + l.net };
  })();

  const totalExcluded = (() => {
    const t = getStats('test_dev');
    const a = getStats('admin_correction');
    return { count: t.count + a.count, net: t.net + a.net };
  })();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">🩺 Ledger Health</h1>
        <p className="text-sm text-muted-foreground">
          Real-time classification of all ledger entries — production vs legacy vs test vs corrections.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {classifications.map((cls) => {
          const meta = CLASSIFICATION_META[cls];
          const stats = getStats(cls);
          return (
            <KPICard
              key={cls}
              title={meta.label}
              value={fmtCount(stats.count)}
              icon={meta.icon}
              color={meta.color}
              loading={isLoading}
              subtitle={`Net: ${fmt(stats.net)}`}
            />
          );
        })}
      </div>

      {/* Real vs Excluded summary */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Real Money (Production + Legacy)</p>
            <p className="text-lg font-bold text-green-600">{fmtCount(totalReal.count)} entries</p>
            <p className="text-sm">Net: {fmt(totalReal.net)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Excluded (Test + Corrections)</p>
            <p className="text-lg font-bold text-amber-600">{fmtCount(totalExcluded.count)} entries</p>
            <p className="text-sm">Net: {fmt(totalExcluded.net)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Category breakdown table */}
      <Card>
        <CardHeader>
          <CardTitle>Category Breakdown by Classification</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground">Loading…</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-4">Classification</th>
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4 text-right">Entries</th>
                    <th className="py-2 pr-4 text-right">Cash In</th>
                    <th className="py-2 pr-4 text-right">Cash Out</th>
                    <th className="py-2 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {(categoryData || []).map((row, i) => {
                    const meta = CLASSIFICATION_META[row.classification] || CLASSIFICATION_META.production;
                    return (
                      <tr key={i} className="border-b border-border/40 hover:bg-muted/30">
                        <td className="py-1.5 pr-4">
                          <Badge variant={meta.badgeVariant} className="text-[10px]">
                            {meta.label}
                          </Badge>
                        </td>
                        <td className="py-1.5 pr-4 font-mono text-xs">{row.category}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums">{fmtCount(row.count)}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums text-green-600">{fmt(row.cash_in)}</td>
                        <td className="py-1.5 pr-4 text-right tabular-nums text-red-500">{fmt(row.cash_out)}</td>
                        <td className="py-1.5 text-right tabular-nums font-medium">{fmt(row.net)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

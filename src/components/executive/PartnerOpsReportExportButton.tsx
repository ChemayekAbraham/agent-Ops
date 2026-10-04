import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FileDown, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';

type Period = 'daily' | 'yesterday' | 'weekly' | 'monthly' | 'last_month' | 'weekend';

const OPTIONS: { key: Period; label: string; hint: string }[] = [
  { key: 'daily', label: 'Daily report', hint: 'Today only (EAT)' },
  { key: 'yesterday', label: "Yesterday's report", hint: 'Previous day only (EAT)' },
  { key: 'weekly', label: 'Weekly report', hint: 'Last 7 days' },
  { key: 'monthly', label: 'Monthly report', hint: 'Month to date' },
  { key: 'last_month', label: 'Last month report', hint: 'Previous full calendar month' },
  { key: 'weekend', label: 'Weekend report', hint: 'Latest Sat - Sun' },
];

/** EAT (UTC+3) calendar day, offset by `days`. */
function eatDay(offset = 0): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 + offset * 86_400_000).toISOString().slice(0, 10);
}

/** First and last day of the previous full calendar month (EAT anchored). */
function lastMonthWindow(): { start: string; end: string } {
  const today = eatDay(0);
  const [y, m] = today.split('-').map(Number);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  return { start: `${prevY}-${pad(prevM)}-01`, end: `${prevY}-${pad(prevM)}-${pad(lastDay)}` };
}


type Format = 'pdf' | 'html';

/** Exports the metrics-only Partner Ops report (PDF or HTML brief) for a chosen window. */
export function PartnerOpsReportExportButton() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (period: Period, format: Format = 'pdf') => {
    setBusy(`${period}:${format}`);
    try {
      const lm = period === 'last_month' ? lastMonthWindow() : null;
      const day = lm ? lm.end : period === 'yesterday' ? eatDay(-1) : eatDay(0);
      const resolved = period === 'yesterday' ? 'daily' : period === 'last_month' ? 'monthly' : period;
      const range = lm ? { start: lm.start, end: lm.end } : {};
      if (format === 'html') {
        const { data, error } = await supabase.functions.invoke('partner-ops-daily-report', {
          body: { period: resolved, date: day, ...range, preview: true },
        });
        if (error) throw error;

        const html = typeof data === 'string' ? data : await (data as Blob).text();
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Welile_Partner_Ops_${period}_${day}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast({ title: 'Brief exported', description: `${period} partnership brief downloaded as HTML.` });
        return;
      }
      const { data, error } = await supabase.functions.invoke('partner-ops-daily-report', {
        body: { period: resolved, date: day, ...range, pdf: true },
      });

      if (error) throw error;
      const blob = data instanceof Blob ? data : new Blob([data as any], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Welile_Partner_Ops_${period}_${day}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast({ title: 'Report exported', description: `${period} partnership report downloaded.` });
    } catch (e: any) {
      toast({ title: 'Export failed', description: e?.message || 'Could not build the report.', variant: 'destructive' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={!!busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
          Export report
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs">PDF report</DropdownMenuLabel>
        {OPTIONS.map(o => (
          <DropdownMenuItem key={o.key} onClick={() => download(o.key)} disabled={!!busy}>
            <div className="flex flex-col">
              <span className="text-sm">{o.label}</span>
              <span className="text-[10px] text-muted-foreground">{o.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
        <DropdownMenuLabel className="text-xs">HTML brief (same as the emailed brief)</DropdownMenuLabel>
        {OPTIONS.map(o => (
          <DropdownMenuItem key={`html-${o.key}`} onClick={() => download(o.key, 'html')} disabled={!!busy}>
            <div className="flex flex-col">
              <span className="text-sm">{o.label} — HTML</span>
              <span className="text-[10px] text-muted-foreground">{o.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

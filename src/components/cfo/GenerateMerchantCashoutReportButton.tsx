import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

/**
 * CFO-only button that triggers the `merchant-cashout-daily-report` edge
 * function on demand. Defaults to today (EAT) and forces regeneration so
 * the email is sent even if the idempotent cron already ran.
 */
export default function GenerateMerchantCashoutReportButton() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const today = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [date, setDate] = useState<string>(today);

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        'merchant-cashout-daily-report',
        { body: { date, force: true } },
      );
      if (error) throw error;
      const d = data as { success?: boolean; total_payouts?: number; total_paid?: number; error?: string };
      if (!d?.success) throw new Error(d?.error || 'Failed to generate report');
      toast({
        title: 'Merchant cash-out report queued',
        description: `Date ${date}: ${d.total_payouts ?? 0} payouts · UGX ${(d.total_paid ?? 0).toLocaleString('en-US')}. Email dispatched to the ops recipients.`,
      });
    } catch (e) {
      toast({
        title: 'Failed to generate report',
        description: (e as Error).message,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <FileDown className="h-4 w-4 text-primary" />
            Merchant Cash-Out Report
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Regenerate and email the merchant cash-out daily report for the chosen
            EAT date. Emails go to the standard ops recipients.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
          disabled={busy}
        />
        <Button size="sm" onClick={() => void run()} disabled={busy || !date}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin mr-1" />
          ) : (
            <FileDown className="h-4 w-4 mr-1" />
          )}
          Generate & email report
        </Button>
      </div>
    </div>
  );
}
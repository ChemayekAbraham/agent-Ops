import { HeroCard } from '@/components/cfo/HeroCard';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { MessageSquare } from 'lucide-react';
import {
  SMS_PROVIDERS, countPayments, kampalaDay, paymentsBetween, sumPayments, useProviderPayments,
} from '@/hooks/useProviderPayments';

/**
 * What finance has paid to Yoola and Africa's Talking, from approved requisitions.
 * Sits beside Money Paid Out but is NOT added into it: that card counts completed
 * withdrawals and reconciles to the ledger, while these are requisitions.
 */
export function SmsProvidersPaidCard({ onOpenReport }: { onOpenReport?: () => void }) {
  const q = useProviderPayments();
  const all = q.data ?? [];
  const today = kampalaDay(new Date().toISOString());
  const month = paymentsBetween(all, `${today.slice(0, 7)}-01`, today);
  const ready = !q.isLoading && !q.error;
  const dots = ['bg-amber-500', 'bg-rose-500'];

  return (
    <HeroCard
      icon={<MessageSquare className="h-5 w-5" />}
      tone="warning"
      title="SMS & OTP Providers Paid"
      value={ready ? formatUGX(sumPayments(month)) : '—'}
      percentageLabel={ready ? `This month, ${countPayments(month).toLocaleString()} requisitions` : '—'}
      items={ready ? [
        ...SMS_PROVIDERS.filter((n) => countPayments(month, n) > 0).map((n, i) => ({
          dot: dots[i] ?? 'bg-primary',
          label: `${n} (${countPayments(month, n).toLocaleString()})`,
          value: formatUGX(sumPayments(month, n)),
        })),
        { dot: 'bg-muted-foreground', label: `All time (${countPayments(all).toLocaleString()})`, value: formatUGX(sumPayments(all)) },
      ] : []}
      footer={q.error ? 'Could not load provider payments' : 'Approved requisitions naming Yoola or Africa’s Talking. Not added into Money Paid Out.'}
      action={onOpenReport ? <Button size="sm" variant="outline" onClick={onOpenReport}>Open SMS &amp; OTP Costs</Button> : undefined}
    />
  );
}

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert } from 'lucide-react';
import { usePayoutVerificationCounts } from '@/hooks/usePayoutVerification';

/**
 * Full-width card at the very top of the Financial Ops dashboard: how many
 * payout destinations are waiting for a verification call, and how much money
 * is held until they are cleared.
 */
export default function PayoutVerificationCallout({ onOpen }: { onOpen: () => void }) {
  const counts = usePayoutVerificationCounts();
  const waiting = counts.data?.waiting ?? 0;
  const held = counts.data?.waiting_balance ?? 0;

  return (
    <Card className="border-2 border-primary/50 bg-primary/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold leading-tight">Verify Payout Numbers</h3>
              {waiting > 0 && <Badge variant="destructive">{waiting > 999 ? '999+' : waiting} waiting</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {waiting > 0
                ? `UGX ${Math.round(held).toLocaleString()} cannot be paid out until these numbers are confirmed by phone.`
                : 'Every payout destination has been confirmed by phone.'}
            </p>
          </div>
        </div>
        <Button onClick={onOpen} className="h-12 w-full sm:w-auto">
          Open queue
        </Button>
      </div>
    </Card>
  );
}

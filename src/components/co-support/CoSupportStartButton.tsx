import { useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCreateCoSupport } from '@/hooks/useCoSupport';
import { coSupportErrorMessage, type CoSupportInvite } from '@/lib/coSupport';
import { CoSupportShareSheet } from './CoSupportShareSheet';

/** Plans under this amount cannot be shared (server: CO_SUPPORT_PLAN_TOO_SMALL). */
export const CO_SUPPORT_MIN_PLAN_AMOUNT = 100_000;

/**
 * Section 1: "Support with a partner" on a Rent Plan (never on empty houses).
 * `planAmount` is the amount the partner pays for the whole plan; the button is
 * hidden under UGX 100,000. Halves come from the server after the tap.
 */
export function CoSupportStartButton({
  rentRequestId,
  planAmount,
  className,
  showExplanation = true,
}: {
  rentRequestId: string | null | undefined;
  planAmount: number;
  className?: string;
  showExplanation?: boolean;
}) {
  const create = useCreateCoSupport();
  const [invite, setInvite] = useState<CoSupportInvite | null>(null);

  if (!rentRequestId || !(Number(planAmount) >= CO_SUPPORT_MIN_PLAN_AMOUNT)) return null;

  const start = () =>
    create.mutate(rentRequestId, {
      onSuccess: (data) => setInvite(data),
      onError: (error) => toast.error(coSupportErrorMessage(error)),
    });

  return (
    <div className={cn('space-y-1.5', className)}>
      <Button variant="outline" className="h-11 w-full rounded-lg font-semibold" onClick={start} disabled={create.isPending}>
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Users className="h-4 w-4" aria-hidden />}
        Support with a partner
      </Button>
      {showExplanation ? (
        <p className="text-xs text-muted-foreground">
          You pay half and a partner pays half. We hold your half for 48 hours while they decide.
        </p>
      ) : null}
      <CoSupportShareSheet invite={invite} open={!!invite} onOpenChange={(o) => !o && setInvite(null)} />
    </div>
  );
}

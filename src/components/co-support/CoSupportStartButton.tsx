import { useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCreateCoSupport, useCreateCoSupportHouse } from '@/hooks/useCoSupport';
import { coSupportErrorMessage, type CoSupportInvite } from '@/lib/coSupport';
import { CoSupportShareSheet } from './CoSupportShareSheet';

/** Plans under this amount cannot be shared (server: CO_SUPPORT_PLAN_TOO_SMALL). */
export const CO_SUPPORT_MIN_PLAN_AMOUNT = 100_000;

/**
 * Sections 1 and 6: "Support with a partner" on a Rent Plan or a verified empty house.
 * `planAmount` is the amount the partner pays for the whole plan; the button is
 * hidden under UGX 100,000. Halves come from the server after the tap.
 */
export function CoSupportStartButton({
  rentRequestId,
  houseId,
  planAmount,
  className,
  showExplanation = true,
}: {
  rentRequestId?: string | null;
  /** Verified empty house: shared through the house hook instead. */
  houseId?: string | null;
  planAmount: number;
  className?: string;
  showExplanation?: boolean;
}) {
  const createPlan = useCreateCoSupport();
  const createHouse = useCreateCoSupportHouse();
  const isHouse = !!houseId;
  const create = isHouse ? createHouse : createPlan;
  const targetId = isHouse ? houseId : rentRequestId;
  const [invite, setInvite] = useState<CoSupportInvite | null>(null);

  if (!targetId || !(Number(planAmount) >= CO_SUPPORT_MIN_PLAN_AMOUNT)) return null;

  const start = () =>
    create.mutate(targetId, {
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
          {isHouse ? ' Partner Ops then approve the house.' : ''}
        </p>
      ) : null}
      <CoSupportShareSheet invite={invite} open={!!invite} onOpenChange={(o) => !o && setInvite(null)} />
    </div>
  );
}

import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Plain-language explanation of what tapping "Fund" does. Regulatory copy:
 * "Rent Plan", "Returns" — never "loan" / "interest".
 */
export const FUND_HOUSE_TOOLTIP =
  'Tap Fund to start a 12-month Rent Plan for this house. A Welile agent is notified and places a tenant within 7 days. Welile collects the rent for you, and you earn 15% per month of the amount you contribute.';

/**
 * Accessible wrapper for every Fund button in the empty-house flow.
 * Built on the Radix tooltip, so it works for:
 *  - keyboard users (opens on focus, closes with Escape)
 *  - screen readers (announced via aria-describedby on the trigger)
 *  - touch devices (opens on tap and stays until dismissed)
 * The trigger keeps the button fully clickable — the tooltip never blocks the action.
 */
export function FundHouseTooltip({
  children,
  side = 'top',
}: {
  children: ReactNode;
  side?: 'top' | 'bottom';
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} collisionPadding={12} className="max-w-[17rem] p-3">
          <p className="text-left text-[12px] leading-snug">{FUND_HOUSE_TOOLTIP}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default FundHouseTooltip;

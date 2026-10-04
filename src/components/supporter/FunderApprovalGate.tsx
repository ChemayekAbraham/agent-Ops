import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Verification is no longer required — all joined users can invest as long as
 * they have funds in their wallet. The approval banner is retired and renders
 * nothing; kept as a no-op so existing call sites remain valid.
 */
export function FunderApprovalBanner(_props: { className?: string }) {
  return null;
}

export function FunderApprovedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-success/10 text-success border border-success/30 px-2 py-0.5 text-[10px] font-semibold',
        className
      )}
    >
      <CheckCircle2 className="h-2.5 w-2.5" /> Verified Partner
    </span>
  );
}
import { AlertTriangle } from 'lucide-react';
import { useTenantAgreement } from '@/hooks/useTenantAgreement';

interface TenantAgreementNoticeProps {
  onAcceptClick: () => void;
}

export default function TenantAgreementNotice({ onAcceptClick }: TenantAgreementNoticeProps) {
  const { isAccepted, isLoading } = useTenantAgreement();

  if (isLoading || isAccepted) {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs">
      <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
      <span className="text-amber-700 dark:text-amber-300">
        You must accept Terms to continue.{' '}
        <button
          onClick={onAcceptClick}
          className="font-medium underline hover:no-underline"
        >
          Accept now
        </button>
      </span>
    </div>
  );
}

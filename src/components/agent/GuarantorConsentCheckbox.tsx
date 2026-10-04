import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle } from 'lucide-react';

interface GuarantorConsentCheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function GuarantorConsentCheckbox({ checked, onCheckedChange }: GuarantorConsentCheckboxProps) {
  return (
    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
          Guarantor Responsibility
        </p>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">
        By onboarding this tenant, you accept full financial responsibility if they default on rent payments. 
        Defaults will be recovered from your <strong>commission wallet</strong> after a 72-hour grace period.
      </p>
      <label className="flex items-center gap-2 cursor-pointer pt-1">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
        <span className="text-xs font-medium text-foreground">
          I accept guarantor responsibility for this tenant
        </span>
      </label>
    </div>
  );
}

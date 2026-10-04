import { useState } from 'react';
import { Copy, CheckCircle2, ArrowDownCircle } from 'lucide-react';
import { toast } from 'sonner';

interface MerchantPillProps {
  label: string;
  code: string;
  dotColor: string;
  borderColor: string;
}

function MerchantPill({ label, code, dotColor, borderColor }: MerchantPillProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    toast.success(`${label} merchant code copied!`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-muted/50 border ${borderColor} active:scale-95 transition-transform touch-manipulation`}
    >
      <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
      <span className="text-[11px] font-semibold text-muted-foreground">{label}</span>
      <span className="text-[11px] font-mono font-bold text-foreground">{code}</span>
      {copied ? (
        <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground shrink-0" />
      )}
    </button>
  );
}

interface MerchantCodePillsProps {
  onDeposit?: () => void;
}

export function MerchantCodePills({ onDeposit }: MerchantCodePillsProps) {
  return (
    <div className="flex flex-col items-center gap-1.5 my-2">
      <div className="flex flex-wrap justify-center gap-1.5">
        <MerchantPill label="MTN" code="090777" dotColor="bg-yellow-500" borderColor="border-yellow-500/30" />
        <MerchantPill label="Airtel" code="4380664" dotColor="bg-red-500" borderColor="border-red-500/30" />
      </div>
      {onDeposit && (
        <button
          onClick={onDeposit}
          className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-success/10 border border-success/30 active:scale-95 transition-transform touch-manipulation hover:bg-success/20"
        >
          <ArrowDownCircle className="h-3.5 w-3.5 text-success shrink-0" />
          <span className="text-[11px] font-bold text-success">Deposit Funds</span>
        </button>
      )}
    </div>
  );
}

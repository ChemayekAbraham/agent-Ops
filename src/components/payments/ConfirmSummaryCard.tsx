import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Shield, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SummaryItem {
  label: string;
  value: string;
  highlight?: boolean;
  secondary?: boolean;
}

interface ConfirmSummaryCardProps {
  title?: string;
  items: SummaryItem[];
  fees?: { label: string; value: string }[];
  total?: { label: string; value: string };
  confirmText?: string;
  confirmed?: boolean;
  onConfirmChange?: (confirmed: boolean) => void;
  showSecurityNote?: boolean;
  className?: string;
}

export default function ConfirmSummaryCard({
  title = 'Payment Summary',
  items,
  fees,
  total,
  confirmText = 'I confirm this payment is correct',
  confirmed,
  onConfirmChange,
  showSecurityNote = true,
  className,
}: ConfirmSummaryCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className="pb-3 bg-muted/30">
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {/* Main items */}
        <div className="space-y-3">
          {items.map((item, index) => (
            <div 
              key={index} 
              className={cn(
                'flex justify-between items-center',
                item.secondary && 'text-sm text-muted-foreground'
              )}
            >
              <span className={item.secondary ? '' : 'font-medium'}>{item.label}</span>
              <span className={cn(
                item.highlight && 'text-primary font-semibold',
                !item.secondary && 'font-semibold'
              )}>
                {item.value}
              </span>
            </div>
          ))}
        </div>

        {/* Fees section */}
        {fees && fees.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3" /> Fee Breakdown
              </p>
              {fees.map((fee, index) => (
                <div key={index} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{fee.label}</span>
                  <span>{fee.value}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Total */}
        {total && (
          <>
            <Separator />
            <div className="flex justify-between items-center py-2 bg-primary/5 -mx-4 px-4 rounded-lg">
              <span className="font-bold text-lg">{total.label}</span>
              <span className="font-bold text-lg text-primary">{total.value}</span>
            </div>
          </>
        )}

        {/* Security note */}
        {showSecurityNote && (
          <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg text-xs text-muted-foreground">
            <Shield className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <p>Your payment is secured with end-to-end encryption. We never store your sensitive payment information.</p>
          </div>
        )}

        {/* Confirmation checkbox */}
        {onConfirmChange && (
          <div className="flex items-start gap-3 pt-2">
            <Checkbox 
              id="confirm" 
              checked={confirmed}
              onCheckedChange={(checked) => onConfirmChange(checked === true)}
            />
            <Label htmlFor="confirm" className="text-sm leading-tight cursor-pointer">
              {confirmText}
            </Label>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

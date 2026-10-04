import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Check, Clock, CreditCard, Building2, Smartphone, Wallet, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PaymentMethod {
  id: string;
  name: string;
  type: 'momo' | 'airtel' | 'bank' | 'card' | 'wallet' | 'international';
  region: 'local' | 'international';
  fee: string;
  feeAmount?: number;
  eta: string;
  icon?: string;
  disabled?: boolean;
  comingSoon?: boolean;
  currencies?: string[];
}

interface PaymentMethodCardProps {
  method: PaymentMethod;
  selected?: boolean;
  onSelect?: () => void;
  showFee?: boolean;
}

const typeIcons = {
  momo: Smartphone,
  airtel: Smartphone,
  bank: Building2,
  card: CreditCard,
  wallet: Wallet,
  international: Globe,
};

const typeColors = {
  momo: 'border-[#FFCC00] bg-[#FFCC00]/5',
  airtel: 'border-[#ED1C24] bg-[#ED1C24]/5',
  bank: 'border-blue-500 bg-blue-500/5',
  card: 'border-purple-500 bg-purple-500/5',
  wallet: 'border-primary bg-primary/5',
  international: 'border-teal-500 bg-teal-500/5',
};

export default function PaymentMethodCard({ 
  method, 
  selected, 
  onSelect, 
  showFee = true 
}: PaymentMethodCardProps) {
  const Icon = typeIcons[method.type];
  
  return (
    <Card
      onClick={method.disabled || method.comingSoon ? undefined : onSelect}
      className={cn(
        'relative p-4 transition-all cursor-pointer border-2',
        selected ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50',
        typeColors[method.type],
        (method.disabled || method.comingSoon) && 'opacity-60 cursor-not-allowed'
      )}
    >
      {/* Selection indicator */}
      {selected && (
        <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
          <Check className="w-3 h-3 text-primary-foreground" />
        </div>
      )}

      {/* Coming soon badge */}
      {method.comingSoon && (
        <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
          Coming Soon
        </Badge>
      )}

      <div className="flex items-start gap-3">
        <div className={cn(
          'w-10 h-10 rounded-lg flex items-center justify-center',
          method.type === 'momo' && 'bg-[#FFCC00]',
          method.type === 'airtel' && 'bg-[#ED1C24]',
          method.type === 'bank' && 'bg-blue-500',
          method.type === 'card' && 'bg-purple-500',
          method.type === 'wallet' && 'bg-primary',
          method.type === 'international' && 'bg-teal-500',
        )}>
          <Icon className="w-5 h-5 text-white" />
        </div>

        <div className="flex-1 min-w-0">
          <h4 className="font-semibold text-sm">{method.name}</h4>
          
          {showFee && (
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
              <span>Fee: {method.fee}</span>
              <span>•</span>
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {method.eta}
              </span>
            </div>
          )}

          {method.currencies && method.currencies.length > 0 && (
            <div className="flex gap-1 mt-2">
              {method.currencies.map(currency => (
                <Badge key={currency} variant="outline" className="text-xs px-1.5 py-0">
                  {currency}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

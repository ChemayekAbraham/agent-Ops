import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { MapPin, Calendar, Shield, TrendingUp } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { VirtualHouse } from './VirtualHouseCard';
import { format } from 'date-fns';

interface VirtualHouseDetailsSheetProps {
  house: VirtualHouse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const healthConfig = {
  green: { label: 'Good', color: 'text-success', bg: 'bg-success/10' },
  amber: { label: 'Pending', color: 'text-amber-600', bg: 'bg-amber-500/10' },
  red: { label: 'At Risk', color: 'text-destructive', bg: 'bg-destructive/10' },
};

export function VirtualHouseDetailsSheet({ house, open, onOpenChange }: VirtualHouseDetailsSheetProps) {
  const { formatAmount } = useCurrency();

  if (!house) return null;

  const health = healthConfig[house.paymentHealth];
  const confidenceScore = house.paymentHealth === 'green' ? 95 : house.paymentHealth === 'amber' ? 65 : 30;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-xl">🏠</span>
            House #{house.shortId}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 pt-2">
          {/* Location */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4" />
            <span>{house.area}, {house.city}</span>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-muted/50 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Monthly Rent</p>
              <p className="text-lg font-bold">{formatAmount(house.rentAmount)}</p>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Duration</p>
              <p className="text-lg font-bold">{house.durationDays} days</p>
            </div>
            <div className="rounded-xl bg-muted/50 p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Last Update</p>
              <p className="text-sm font-semibold">{format(new Date(house.updatedAt), 'dd MMM yyyy')}</p>
            </div>
            <div className={`rounded-xl p-3 ${health.bg}`}>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Confidence</p>
              <p className={`text-lg font-bold ${health.color}`}>{confidenceScore}%</p>
            </div>
          </div>

          {/* Management status */}
          <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 border border-border/50">
            <Shield className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-medium">
                {house.agentManaged ? 'Agent Managed' : 'Self-Managed'}
              </p>
              <p className="text-xs text-muted-foreground">
                {house.agentManaged 
                  ? 'This house is managed by a verified Welile agent.'
                  : 'This house was registered directly by the tenant.'}
              </p>
            </div>
          </div>

          {/* Payment health badge */}
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Payment Health:</span>
            <Badge variant="outline" className={`${health.bg} ${health.color}`}>
              {health.label}
            </Badge>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

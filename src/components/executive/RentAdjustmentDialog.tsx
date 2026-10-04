import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { TrendingDown, Calculator } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface RentAdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listing: {
    id: string;
    title: string;
    monthly_rent: number;
    daily_rate: number;
    address: string;
  };
  onSuccess: () => void;
}

export function RentAdjustmentDialog({ open, onOpenChange, listing, onSuccess }: RentAdjustmentDialogProps) {
  const { toast } = useToast();
  const [newRent, setNewRent] = useState(listing.monthly_rent.toString());
  const [saving, setSaving] = useState(false);

  const parsedRent = parseInt(newRent) || 0;
  const discount = listing.monthly_rent - parsedRent;
  const discountPct = listing.monthly_rent > 0 ? Math.round((discount / listing.monthly_rent) * 100) : 0;

  // Recalculate daily rate with new rent
  const accessFee = Math.round(parsedRent * (Math.pow(1.33, 1) - 1));
  const platformFee = parsedRent <= 200000 ? 10000 : 20000;
  const totalMonthlyCost = parsedRent + accessFee + platformFee;
  const newDailyRate = Math.ceil(totalMonthlyCost / 30);

  const handleSave = async () => {
    if (parsedRent <= 0 || parsedRent >= listing.monthly_rent) {
      toast({ title: 'Invalid amount', description: 'New rent must be lower than current rent', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('house_listings')
        .update({
          monthly_rent: parsedRent,
          daily_rate: newDailyRate,
          access_fee: accessFee,
          platform_fee: platformFee,
          total_monthly_cost: totalMonthlyCost,
        })
        .eq('id', listing.id);

      if (error) throw error;

      toast({
        title: '✅ Rent Adjusted',
        description: `${listing.title} reduced from ${listing.monthly_rent.toLocaleString()} to ${parsedRent.toLocaleString()}/mo`,
      });
      onSuccess();
      onOpenChange(false);
    } catch (err: any) {
      toast({ title: 'Failed to adjust rent', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TrendingDown className="h-5 w-5 text-primary" />
            Adjust Rent Price
          </DialogTitle>
          <DialogDescription>
            Reduce rent to attract tenants for: <strong>{listing.title}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-3 rounded-lg bg-muted/50 space-y-1">
            <p className="text-xs text-muted-foreground">Current Rent</p>
            <p className="font-bold text-lg">UGX {listing.monthly_rent.toLocaleString()}/mo</p>
            <p className="text-xs text-muted-foreground">Daily: UGX {listing.daily_rate.toLocaleString()}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="newRent">New Monthly Rent (UGX)</Label>
            <Input
              id="newRent"
              type="number"
              value={newRent}
              onChange={(e) => setNewRent(e.target.value)}
              placeholder="Enter reduced rent"
            />
          </div>

          {parsedRent > 0 && parsedRent < listing.monthly_rent && (
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Discount</span>
                <Badge className="bg-success/20 text-success border-0">
                  -{discountPct}% (UGX {discount.toLocaleString()})
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">New Daily Rate</span>
                <span className="font-bold text-sm flex items-center gap-1">
                  <Calculator className="h-3 w-3" />
                  UGX {newDailyRate.toLocaleString()}/day
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Old: {listing.daily_rate.toLocaleString()}/day → New: {newDailyRate.toLocaleString()}/day
              </p>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              className="flex-1"
              onClick={handleSave}
              disabled={saving || parsedRent <= 0 || parsedRent >= listing.monthly_rent}
            >
              {saving ? 'Saving...' : 'Apply Reduction'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

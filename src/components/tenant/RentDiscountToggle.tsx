import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Sparkles, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

export default function RentDiscountToggle() {
  const { user } = useAuth();
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    if (user) {
      fetchStatus();
    }
  }, [user]);

  const fetchStatus = async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('profiles')
      .select('rent_discount_active')
      .eq('id', user.id)
      .single();

    if (!error && data) {
      setActive(data.rent_discount_active || false);
    }
    setLoading(false);
  };

  const toggleStatus = async (checked: boolean) => {
    if (!user) return;
    
    setUpdating(true);
    
    const { error } = await supabase
      .from('profiles')
      .update({ rent_discount_active: checked })
      .eq('id', user.id);

    setUpdating(false);

    if (error) {
      toast.error('Failed to update status');
      return;
    }

    setActive(checked);
    toast.success(checked ? 'Rent discount service activated!' : 'Rent discount service deactivated');
  };

  if (loading) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 flex items-center justify-center">
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Card>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className={`border ${active ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-border/50'}`}>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${active ? 'bg-emerald-500/20' : 'bg-muted'}`}>
                <Sparkles className={`h-4 w-4 ${active ? 'text-emerald-500' : 'text-muted-foreground'}`} />
              </div>
              <div>
                <Label htmlFor="rent-discount-toggle" className="font-medium cursor-pointer">
                  Rent Discount Service
                </Label>
                <p className="text-xs text-muted-foreground">
                  {active ? 'You are active and earning discounts' : 'Activate to start earning rent discounts'}
                </p>
              </div>
            </div>
            <Switch
              id="rent-discount-toggle"
              checked={active}
              onCheckedChange={toggleStatus}
              disabled={updating}
            />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

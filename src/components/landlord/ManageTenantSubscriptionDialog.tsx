import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { 
  Settings, 
  Loader2, 
  Save,
  Pause,
  Play,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface TenantSubscription {
  subscription_id: string;
  tenant_id: string;
  tenant_name: string;
  monthly_rent: number;
  total_savings: number;
  months_enrolled: number;
  subscription_status: string;
}

interface ManageTenantSubscriptionDialogProps {
  subscription: TenantSubscription;
  trigger?: React.ReactNode;
}

export function ManageTenantSubscriptionDialog({ 
  subscription, 
  trigger 
}: ManageTenantSubscriptionDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [monthlyRent, setMonthlyRent] = useState(subscription.monthly_rent.toString());

  const updateMutation = useMutation({
    mutationFn: async (updates: { monthly_rent?: number; subscription_status?: string }) => {
      const { error } = await supabase
        .from('welile_homes_subscriptions')
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq('id', subscription.subscription_id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Subscription updated successfully');
      queryClient.invalidateQueries({ queryKey: ['landlord-welile-homes-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['landlord-welile-homes-tenants-full'] });
      queryClient.invalidateQueries({ queryKey: ['welile-homes-landlord-leaderboard'] });
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to update subscription');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('welile_homes_subscriptions')
        .delete()
        .eq('id', subscription.subscription_id);

      if (error) throw error;

      // Notification removed - table dropped
    },
    onSuccess: () => {
      toast.success('Subscription removed');
      queryClient.invalidateQueries({ queryKey: ['landlord-welile-homes-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['landlord-welile-homes-tenants-full'] });
      queryClient.invalidateQueries({ queryKey: ['landlord-tenants-for-enrollment'] });
      queryClient.invalidateQueries({ queryKey: ['welile-homes-landlord-leaderboard'] });
      setOpen(false);
      setShowDeleteConfirm(false);
    },
    onError: (error: Error) => {
      toast.error(error.message || 'Failed to remove subscription');
    },
  });

  const handleSaveRent = () => {
    const rent = parseFloat(monthlyRent);
    if (isNaN(rent) || rent <= 0) {
      toast.error('Please enter a valid rent amount');
      return;
    }
    updateMutation.mutate({ monthly_rent: rent });
  };

  const handleToggleStatus = () => {
    const newStatus = subscription.subscription_status === 'active' ? 'paused' : 'active';
    updateMutation.mutate({ subscription_status: newStatus });
    
    // Notification removed - table dropped
  };

  const isActive = subscription.subscription_status === 'active';
  const isPaused = subscription.subscription_status === 'paused';

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {trigger || (
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-purple-600" />
              Manage Subscription
            </DialogTitle>
            <DialogDescription>
              Update {subscription.tenant_name}'s Welile Homes subscription
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Current Status */}
            <div className="p-3 rounded-lg bg-muted/50 border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Current Status</span>
                <Badge 
                  variant={isActive ? 'default' : 'secondary'}
                  className={isActive ? 'bg-emerald-100 text-emerald-700' : isPaused ? 'bg-amber-100 text-amber-700' : ''}
                >
                  {subscription.subscription_status}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Total Savings:</span>
                  <p className="font-semibold text-emerald-600">{formatUGX(subscription.total_savings)}</p>
                </div>
                <div>
                  <span className="text-muted-foreground">Months Enrolled:</span>
                  <p className="font-semibold">{subscription.months_enrolled}</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Update Monthly Rent */}
            <div className="space-y-2">
              <Label htmlFor="edit-rent">Monthly Rent (UGX)</Label>
              <div className="flex gap-2">
                <Input
                  id="edit-rent"
                  type="number"
                  value={monthlyRent}
                  onChange={(e) => setMonthlyRent(e.target.value)}
                  placeholder="e.g., 500000"
                />
                <Button 
                  onClick={handleSaveRent}
                  disabled={updateMutation.isPending || monthlyRent === subscription.monthly_rent.toString()}
                  className="gap-2"
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  Save
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Monthly contribution: {formatUGX(parseFloat(monthlyRent || '0') * 0.10)}
              </p>
            </div>

            <Separator />

            {/* Pause/Resume */}
            <div className="space-y-2">
              <Label>Subscription Status</Label>
              <Button
                variant="outline"
                className={`w-full gap-2 ${isActive ? 'border-amber-300 hover:bg-amber-50' : 'border-emerald-300 hover:bg-emerald-50'}`}
                onClick={handleToggleStatus}
                disabled={updateMutation.isPending}
              >
                {isActive ? (
                  <>
                    <Pause className="h-4 w-4 text-amber-600" />
                    <span className="text-amber-700">Pause Subscription</span>
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 text-emerald-600" />
                    <span className="text-emerald-700">Resume Subscription</span>
                  </>
                )}
              </Button>
              <p className="text-xs text-muted-foreground">
                {isActive 
                  ? 'Pausing will stop new contributions but preserve existing savings.'
                  : 'Resuming will continue monthly contributions with the next rent payment.'}
              </p>
            </div>

            <Separator />

            {/* Remove Subscription */}
            <div className="space-y-2">
              <Label className="text-destructive">Danger Zone</Label>
              <Button
                variant="outline"
                className="w-full gap-2 border-destructive/50 text-destructive hover:bg-destructive/10"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="h-4 w-4" />
                Remove from Welile Homes
              </Button>
              <p className="text-xs text-muted-foreground">
                This will end the subscription. The tenant's accumulated savings will be processed according to program terms.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Remove Tenant from Welile Homes?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                Are you sure you want to remove <strong>{subscription.tenant_name}</strong> from Welile Homes?
              </p>
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                <p className="font-medium">Current savings: {formatUGX(subscription.total_savings)}</p>
                <p className="text-xs mt-1">
                  The tenant will be notified and their savings will be processed according to program terms.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Remove Subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

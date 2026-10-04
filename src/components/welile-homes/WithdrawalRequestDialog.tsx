import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { MapPin, Home, Hammer, CreditCard, Clock, Loader2, AlertCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';

interface WithdrawalRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscriptionId: string;
  currentSavings: number;
  monthsEnrolled: number;
}

const purposes = [
  { value: 'buying_land', label: 'Buying Land', icon: MapPin, color: 'text-emerald-600' },
  { value: 'buying_home', label: 'Buying a Home', icon: Home, color: 'text-blue-600' },
  { value: 'building_house', label: 'Building a House', icon: Hammer, color: 'text-amber-600' },
  { value: 'mortgage_down_payment', label: 'Mortgage Down Payment', icon: CreditCard, color: 'text-purple-600' },
  { value: 'other_after_24_months', label: 'Other (After 24 Months)', icon: Clock, color: 'text-muted-foreground' },
];

export function WithdrawalRequestDialog({
  open,
  onOpenChange,
  subscriptionId,
  currentSavings,
  monthsEnrolled,
}: WithdrawalRequestDialogProps) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [purposeDetails, setPurposeDetails] = useState('');

  const canWithdrawForOther = monthsEnrolled >= 24;

  const submitMutation = useMutation({
    mutationFn: async () => {
      const withdrawalAmount = parseFloat(amount);
      
      if (withdrawalAmount <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      
      if (withdrawalAmount > currentSavings) {
        throw new Error('Amount exceeds available savings');
      }
      
      if (purpose === 'other_after_24_months' && !canWithdrawForOther) {
        throw new Error('You must be enrolled for at least 24 months to withdraw for non-housing purposes');
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // welile_homes_withdrawals table removed
      throw new Error('Withdrawal requests feature is currently disabled');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-homes-withdrawals'] });
      toast.success('Withdrawal request submitted! Please wait for manager approval before funds are released.');
      onOpenChange(false);
      setAmount('');
      setPurpose('');
      setPurposeDetails('');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const selectedPurpose = purposes.find((p) => p.value === purpose);
  const withdrawalAmount = parseFloat(amount) || 0;
  const isValidAmount = withdrawalAmount > 0 && withdrawalAmount <= currentSavings;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Home className="h-5 w-5 text-purple-600" />
            Request Withdrawal
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Available Balance */}
          <Card className="bg-gradient-to-br from-purple-50 to-purple-100 border-purple-200">
            <CardContent className="p-4">
              <p className="text-sm text-purple-600">Available Balance</p>
              <p className="text-2xl font-bold text-purple-700">{formatUGX(currentSavings)}</p>
              <p className="text-xs text-purple-500 mt-1">
                Enrolled for {monthsEnrolled} months
              </p>
            </CardContent>
          </Card>

          {/* Amount */}
          <div className="space-y-2">
            <Label htmlFor="amount">Withdrawal Amount (UGX)</Label>
            <Input
              id="amount"
              type="number"
              placeholder="Enter amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="text-lg"
            />
            {withdrawalAmount > currentSavings && (
              <p className="text-xs text-destructive">Amount exceeds available balance</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAmount(currentSavings.toString())}
              className="text-xs"
            >
              Withdraw Full Amount
            </Button>
          </div>

          {/* Purpose */}
          <div className="space-y-2">
            <Label>Purpose of Withdrawal</Label>
            <Select value={purpose} onValueChange={setPurpose}>
              <SelectTrigger>
                <SelectValue placeholder="Select purpose" />
              </SelectTrigger>
              <SelectContent>
                {purposes.map((p) => (
                  <SelectItem
                    key={p.value}
                    value={p.value}
                    disabled={p.value === 'other_after_24_months' && !canWithdrawForOther}
                  >
                    <div className="flex items-center gap-2">
                      <p.icon className={`h-4 w-4 ${p.color}`} />
                      <span>{p.label}</span>
                      {p.value === 'other_after_24_months' && !canWithdrawForOther && (
                        <span className="text-xs text-muted-foreground">(24+ months)</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Purpose Details */}
          <div className="space-y-2">
            <Label htmlFor="details">Additional Details (Optional)</Label>
            <Textarea
              id="details"
              placeholder="Provide more details about your withdrawal purpose..."
              value={purposeDetails}
              onChange={(e) => setPurposeDetails(e.target.value)}
              rows={3}
            />
          </div>

          {/* Warning for non-housing */}
          {purpose === 'other_after_24_months' && (
            <Card className="bg-amber-50 border-amber-200">
              <CardContent className="p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
                  <p className="text-xs text-amber-700">
                    Withdrawing for non-housing purposes may affect your future savings goals.
                    Consider keeping funds for housing purposes when possible.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary */}
          {isValidAmount && purpose && (
            <Card className="border-emerald-200 bg-emerald-50">
              <CardContent className="p-4">
                <h4 className="font-semibold text-emerald-800 text-sm mb-2">Request Summary</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-emerald-600">Amount:</span>
                    <span className="font-medium">{formatUGX(withdrawalAmount)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-emerald-600">Purpose:</span>
                    <span className="font-medium">{selectedPurpose?.label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-emerald-600">Remaining Balance:</span>
                    <span className="font-medium">{formatUGX(currentSavings - withdrawalAmount)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => submitMutation.mutate()}
            disabled={!isValidAmount || !purpose || submitMutation.isPending}
            className="bg-gradient-to-r from-purple-600 to-purple-700"
          >
            {submitMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

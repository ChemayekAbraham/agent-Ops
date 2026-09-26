import { useState } from 'react';
import StepperModal, { Step } from './StepperModal';
import PaymentMethodCard from './PaymentMethodCard';
import ConfirmSummaryCard from './ConfirmSummaryCard';
import ProcessingScreen from './ProcessingScreen';
import ReceiptCard from './ReceiptCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/paymentMethods';
import { PaymentMethod } from './PaymentMethodCard';
import { Home, Calendar, User, Wallet } from 'lucide-react';
import { RentAccessGrowthInline } from '@/components/tenant/RentAccessGrowthInline';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface PayRentFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rentDue?: number;
  dueDate?: Date;
  landlord?: string;
  property?: string;
  currency?: string;
  walletBalance?: number;
  onPaymentComplete?: () => void;
}

const STEPS: Step[] = [
  { id: 'type', title: 'Payment Type' },
  { id: 'amount', title: 'Enter Amount' },
  { id: 'confirm', title: 'Confirm' },
  { id: 'process', title: 'Processing' },
];

const WALLET_METHOD: PaymentMethod = {
  id: 'wallet',
  name: 'Wallet Balance',
  type: 'wallet',
  region: 'local',
  icon: 'Wallet',
  fee: 'Free',
  eta: 'Instant',
};

export default function PayRentFlow({
  open,
  onOpenChange,
  rentDue = 0,
  dueDate = new Date(),
  landlord = 'Landlord',
  property = 'Property',
  currency = 'UGX',
  walletBalance = 0,
  onPaymentComplete,
}: PayRentFlowProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [paymentType, setPaymentType] = useState<'full' | 'partial'>('full');
  const [amount, setAmount] = useState(rentDue);
  const [confirmed, setConfirmed] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState<'success' | 'failed'>('success');
  const [paymentResult, setPaymentResult] = useState<{
    amount_paid: number;
    remaining_balance: number;
    new_wallet_balance: number;
    reference: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const effectiveAmount = paymentType === 'full' ? rentDue : amount;

  const handleReset = () => {
    setCurrentStep(0);
    setPaymentType('full');
    setAmount(rentDue);
    setConfirmed(false);
    setIsProcessing(false);
    setIsComplete(false);
    setPaymentResult(null);
    setErrorMessage('');
  };

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(handleReset, 300);
  };

  const canProceed = () => {
    switch (currentStep) {
      case 0: return true;
      case 1: return amount > 0 && amount <= rentDue;
      case 2: return confirmed;
      default: return false;
    }
  };

  const handleNext = () => {
    if (currentStep === 0 && paymentType === 'full') {
      setAmount(rentDue);
      setCurrentStep(2); // Skip amount step for full payment
    } else if (currentStep === 2) {
      // Start actual payment
      setCurrentStep(3);
      setIsProcessing(true);
    }
  };

  const handleProcessingComplete = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('tenant-pay-rent', {
        body: { amount: effectiveAmount },
      });

      if (error) {
        throw new Error(error.message || 'Payment failed');
      }

      if (data?.error) {
        throw new Error(data.error);
      }

      setPaymentResult(data);
      setPaymentStatus('success');
      toast.success(`Rent payment of ${formatCurrency(data.amount_paid, currency)} successful!`);
      onPaymentComplete?.();
    } catch (err: any) {
      console.error('Payment error:', err);
      setPaymentStatus('failed');
      setErrorMessage(err.message || 'Payment failed. Please try again.');
      toast.error(err.message || 'Payment failed');
    } finally {
      setIsProcessing(false);
      setIsComplete(true);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return (
          <div className="space-y-4">
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <Home className="w-4 h-4 text-primary" />
                  <span className="font-medium">{property}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <User className="w-4 h-4" />
                  <span>Landlord: {landlord}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="w-4 h-4" />
                  <span>Due: {dueDate.toLocaleDateString()}</span>
                </div>
                <div className="pt-2 border-t">
                  <p className="text-xs text-muted-foreground">Rent Due</p>
                  <p className="text-2xl font-bold text-primary">{formatCurrency(rentDue, currency)}</p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Wallet className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">
                    Wallet: <span className="font-semibold text-foreground">{formatCurrency(walletBalance, currency)}</span>
                  </span>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              <Label>Select Payment Type</Label>
              <div className="grid grid-cols-2 gap-3">
                <Card
                  className={`p-4 cursor-pointer transition-all ${paymentType === 'full' ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                  onClick={() => setPaymentType('full')}
                >
                  <h4 className="font-semibold">Full Amount</h4>
                  <p className="text-sm text-muted-foreground mt-1">{formatCurrency(rentDue, currency)}</p>
                </Card>
                <Card
                  className={`p-4 cursor-pointer transition-all ${paymentType === 'partial' ? 'ring-2 ring-primary border-primary' : 'hover:border-primary/50'}`}
                  onClick={() => setPaymentType('partial')}
                >
                  <h4 className="font-semibold">Partial Amount</h4>
                  <p className="text-sm text-muted-foreground mt-1">Pay what you can</p>
                </Card>
              </div>

              {walletBalance < rentDue && paymentType === 'full' && (
                <p className="text-sm text-destructive">
                  ⚠ Your wallet balance ({formatCurrency(walletBalance, currency)}) is less than the full rent. Consider a partial payment.
                </p>
              )}
            </div>
          </div>
        );

      case 1:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount to Pay ({currency})</Label>
              <Input
                id="amount"
                type="number"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                max={Math.min(rentDue, walletBalance)}
                min={1000}
                className="text-2xl h-14 font-bold text-center"
              />
              {amount > walletBalance && (
                <p className="text-sm text-destructive">
                  Amount exceeds your wallet balance of {formatCurrency(walletBalance, currency)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {[0.25, 0.5, 0.75, 1].map((pct) => {
                const chipAmount = Math.round(Math.min(rentDue * pct, walletBalance));
                return (
                  <Button
                    key={pct}
                    variant={amount === chipAmount ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setAmount(chipAmount)}
                  >
                    {pct * 100}%
                  </Button>
                );
              })}
            </div>

            <Card className="bg-muted/30">
              <CardContent className="p-4 text-center">
                <p className="text-sm text-muted-foreground">This covers</p>
                <p className="text-lg font-semibold">
                  {Math.round((amount / rentDue) * 30)} days
                  <span className="text-sm font-normal text-muted-foreground ml-2">
                    ({Math.round((amount / rentDue) * 100)}% of month)
                  </span>
                </p>
              </CardContent>
            </Card>
          </div>
        );

      case 2:
        return (
          <ConfirmSummaryCard
            items={[
              { label: 'Amount', value: formatCurrency(effectiveAmount, currency) },
              { label: 'Recipient', value: landlord },
              { label: 'Property', value: property, secondary: true },
              { label: 'Method', value: 'Wallet Balance' },
              { label: 'Wallet Before', value: formatCurrency(walletBalance, currency), secondary: true },
              { label: 'Wallet After', value: formatCurrency(Math.max(0, walletBalance - effectiveAmount), currency), secondary: true },
            ]}
            fees={[
              { label: 'Transaction Fee', value: formatCurrency(0, currency) },
            ]}
            total={{ label: 'Total', value: formatCurrency(effectiveAmount, currency) }}
            confirmed={confirmed}
            onConfirmChange={setConfirmed}
          />
        );

      case 3:
        if (isProcessing) {
          return <ProcessingScreen onComplete={handleProcessingComplete} />;
        }
        return (
          <ReceiptCard
            status={paymentStatus}
            amount={paymentResult?.amount_paid ?? effectiveAmount}
            currency={currency}
            fees={0}
            recipient={landlord}
            reference={paymentResult?.reference ?? ''}
            method="Wallet Balance"
            date={new Date()}
            onDownload={() => {}}
            onShare={() => {}}
            onTryAgain={() => {
              setConfirmed(false);
              setCurrentStep(2);
              setIsComplete(false);
            }}
            onChangeMethod={() => {}}
            onContactSupport={() => {}}
            onClose={handleClose}
          />
        );

      default:
        return null;
    }
  };

  return (
    <StepperModal
      open={open}
      onOpenChange={handleClose}
      title="Pay Rent"
      steps={STEPS}
      currentStep={currentStep}
      onStepChange={setCurrentStep}
      canGoNext={canProceed() && effectiveAmount <= walletBalance}
      onNext={handleNext}
      showNavigation={currentStep < 3 && !isProcessing && !isComplete}
      nextLabel={currentStep === 2 ? 'Confirm Payment' : 'Continue'}
      isProcessing={isProcessing}
      isComplete={isComplete}
    >
      {currentStep < 3 && !isProcessing && !isComplete && (
        <RentAccessGrowthInline surface="pay_rent_flow" className="mb-3" />
      )}
      {renderStep()}
    </StepperModal>
  );
}

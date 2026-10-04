import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Calculator, ArrowLeft } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { RentCalculatorShareButton } from './RentCalculatorShareButton';

interface WeeklyMonthlyCalculatorProps {
  onProceed: () => void;
  onBack: () => void;
}

const PLATFORM_FEE = 10000; // UGX 10,000
const MONTHLY_COMPOUND_RATE = 0.33; // 33% per month (compounding)
const MAX_DAYS = 120;
const MIN_DAYS = 7;

// Quick select options for common periods
const quickOptions = [
  { days: 7, label: '1 Week' },
  { days: 14, label: '2 Weeks' },
  { days: 30, label: '30 Days' },
  { days: 60, label: '60 Days' },
  { days: 100, label: '100 Days' },
  { days: 120, label: '4 Months' },
];

/**
 * Calculate access fee with monthly compounding (33% per month)
 * Prorated for partial months
 */
function calculateCompoundingAccessFee(amount: number, days: number): number {
  const months = days / 30;
  // Compounding 33% per month, prorated
  const rate = Math.pow(1 + MONTHLY_COMPOUND_RATE, months) - 1;
  return Math.round(amount * rate);
}

export default function WeeklyMonthlyCalculator({ onProceed, onBack }: WeeklyMonthlyCalculatorProps) {
  const { formatAmount, currency } = useCurrency();
  const [rentAmount, setRentAmount] = useState('');
  const [paybackDays, setPaybackDays] = useState(30);
  const [repaymentDates, setRepaymentDates] = useState(4);

  // Calculate max possible repayment dates based on payback days
  const maxRepaymentDates = Math.min(paybackDays, 30);

  const calculation = useMemo(() => {
    const amount = parseInt(rentAmount.replace(/,/g, ''));
    if (!amount || amount <= 0) return null;

    // Access fee with monthly compounding
    const accessFee = calculateCompoundingAccessFee(amount, paybackDays);
    
    // Total repayment = rent + access fee + platform fee
    const totalRepayment = amount + accessFee + PLATFORM_FEE;
    
    // Per-installment amount
    const perInstallment = Math.ceil(totalRepayment / repaymentDates);
    
    // Days between each payment
    const daysBetweenPayments = Math.floor(paybackDays / repaymentDates);

    return {
      rentAmount: amount,
      days: paybackDays,
      platformFee: PLATFORM_FEE,
      accessFee,
      totalRepayment,
      repaymentDates,
      perInstallment,
      daysBetweenPayments,
    };
  }, [rentAmount, paybackDays, repaymentDates]);

  // Ensure repayment dates doesn't exceed max when payback days change
  const handlePaybackDaysChange = (days: number) => {
    setPaybackDays(days);
    const newMax = Math.min(days, 30);
    if (repaymentDates > newMax) {
      setRepaymentDates(Math.max(1, newMax));
    }
  };

  return (
    <Card className="glass-card glow-primary">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className="h-8 w-8 mr-1"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Calculator className="h-5 w-5 text-primary" />
            Repayment Calculator
          </span>
          <CurrencySwitcher variant="compact" />
        </CardTitle>
        <RentCalculatorShareButton calculatorType="weekly-monthly" className="mt-2" />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hero Inputs - Uber style */}
        <div className="space-y-3 p-4 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
          {/* Rent Amount - Primary Input */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground font-medium">How much rent?</Label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">{currency.code}</span>
              <Input
                type="text"
                value={rentAmount}
                onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="500,000"
                className="h-14 pl-16 text-xl font-bold bg-background border-2 border-primary/30 focus:border-primary rounded-xl"
              />
            </div>
          </div>

          {/* Payback Period - Secondary Input */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground font-medium">When to pay back?</Label>
            <div className="flex flex-wrap gap-2">
              {quickOptions.map((option) => (
                <Button
                  key={option.days}
                  variant={paybackDays === option.days ? "default" : "outline"}
                  size="sm"
                  onClick={() => handlePaybackDaysChange(option.days)}
                  className={`flex-1 min-w-[70px] h-11 text-sm font-semibold rounded-xl transition-all ${
                    paybackDays === option.days 
                      ? 'shadow-md scale-[1.02]' 
                      : 'hover:border-primary/50'
                  }`}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Fine-tune slider */}
          <div className="pt-2 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-xs text-muted-foreground">Fine-tune</span>
              <span className="text-sm font-bold text-primary">{paybackDays} days</span>
            </div>
            <Slider
              value={[paybackDays]}
              onValueChange={(value) => handlePaybackDaysChange(value[0])}
              min={MIN_DAYS}
              max={MAX_DAYS}
              step={1}
              className="w-full"
            />
          </div>
        </div>

        {/* Number of Repayment Dates */}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <Label>Number of Payments</Label>
            <span className="text-sm font-medium text-primary">{repaymentDates} payment{repaymentDates > 1 ? 's' : ''}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3, 4, 5, 6].filter(n => n <= maxRepaymentDates).map((num) => (
              <Button
                key={num}
                variant={repaymentDates === num ? "default" : "outline"}
                size="sm"
                onClick={() => setRepaymentDates(num)}
                className="text-xs min-w-[40px]"
              >
                {num}
              </Button>
            ))}
          </div>
          <Input
            type="number"
            value={repaymentDates}
            onChange={(e) => {
              const val = parseInt(e.target.value) || 1;
              setRepaymentDates(Math.min(Math.max(1, val), maxRepaymentDates));
            }}
            min={1}
            max={maxRepaymentDates}
            placeholder="Custom number"
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Max {maxRepaymentDates} payments for {paybackDays} days
          </p>
        </div>

        {calculation && (
          <div className="mt-4 p-4 rounded-lg bg-secondary/50 space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Rent Amount:</span>
              <span className="font-mono font-medium">{formatAmount(calculation.rentAmount)}</span>
            </div>
            
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Platform Fee:</span>
              <span className="font-mono font-medium">{formatAmount(calculation.platformFee)}</span>
            </div>
            
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Access Fee:</span>
              <span className="font-mono font-medium text-warning">{formatAmount(calculation.accessFee)}</span>
            </div>
            
            <div className="border-t border-border pt-3 space-y-3">
              {/* Per Installment Amount */}
              <div className="p-3 rounded-lg bg-accent/20 border border-accent/30">
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">
                    {calculation.repaymentDates} payment{calculation.repaymentDates > 1 ? 's' : ''} of
                  </p>
                  <p className="text-xl font-bold text-accent-foreground font-mono">
                    {formatAmount(calculation.perInstallment)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    every {calculation.daysBetweenPayments} day{calculation.daysBetweenPayments > 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              
              {/* Total */}
              <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-1">
                    Total to Pay Back in {calculation.days} days
                  </p>
                  <p className="text-2xl font-bold text-primary font-mono">
                    {formatAmount(calculation.totalRepayment)}
                  </p>
                </div>
              </div>
            </div>
            
            <Button onClick={onProceed} className="w-full mt-4">
              Proceed to Request
            </Button>
          </div>
        )}

        {!calculation && rentAmount && (
          <p className="text-center text-muted-foreground py-4">
            Enter a valid rent amount to see the repayment breakdown
          </p>
        )}
      </CardContent>
    </Card>
  );
}

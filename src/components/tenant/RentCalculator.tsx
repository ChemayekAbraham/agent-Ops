import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calculator, ArrowLeft } from 'lucide-react';
import { calculateRentRepayment, RentCalculation } from '@/lib/rentCalculations';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import IncomeTypeSelector, { IncomeType } from './IncomeTypeSelector';
import WeeklyMonthlyCalculator from './WeeklyMonthlyCalculator';
import { RentCalculatorShareButton } from './RentCalculatorShareButton';

interface RentCalculatorProps {
  onProceed: () => void;
}

export default function RentCalculator({ onProceed }: RentCalculatorProps) {
  const [incomeType, setIncomeType] = useState<IncomeType | null>(null);
  const { formatAmount, currency } = useCurrency();
  const [rentAmount, setRentAmount] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [calculation, setCalculation] = useState<RentCalculation | null>(null);

  const handleCalculate = () => {
    const amount = parseInt(rentAmount.replace(/,/g, ''));
    if (amount > 0) {
      setCalculation(calculateRentRepayment(amount, parseInt(duration) as 30 | 60 | 90));
    }
  };

  // Show income type selector first
  if (!incomeType) {
    return <IncomeTypeSelector onSelect={setIncomeType} />;
  }

  // Show weekly/monthly calculator
  if (incomeType === 'weekly-monthly') {
    return (
      <WeeklyMonthlyCalculator
        onProceed={onProceed}
        onBack={() => setIncomeType(null)}
      />
    );
  }

  // Daily income earner calculator (existing)
  return (
    <Card className="glass-card glow-primary">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIncomeType(null)}
              className="h-8 w-8 mr-1"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Calculator className="h-5 w-5 text-primary" />
            Daily Repayment Calculator
          </span>
          <CurrencySwitcher variant="compact" />
        </CardTitle>
        <RentCalculatorShareButton calculatorType="daily" className="mt-2" />
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Hero Inputs - Uber style */}
        <div className="space-y-3 p-4 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20">
          {/* Rent Amount - Primary Input */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground font-medium">How much is your rent?</Label>
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
            <div className="flex gap-2">
              {(['30', '60', '90'] as const).map((d) => (
                <Button
                  key={d}
                  variant={duration === d ? "default" : "outline"}
                  onClick={() => setDuration(d)}
                  className={`flex-1 h-12 text-base font-semibold rounded-xl transition-all ${
                    duration === d 
                      ? 'shadow-md scale-[1.02]' 
                      : 'hover:border-primary/50'
                  }`}
                >
                  {d} Days
                </Button>
              ))}
            </div>
          </div>
        </div>

        <Button onClick={handleCalculate} className="w-full h-12 text-base font-semibold rounded-xl">
          Calculate
        </Button>

        {calculation && (
          <div className="mt-4 p-4 rounded-lg bg-secondary/50 space-y-3">
            <div className="flex justify-between items-center text-sm mb-2">
              <span className="text-muted-foreground">Rent Amount:</span>
              <span className="font-mono font-medium">{formatAmount(calculation.rentAmount)}</span>
            </div>
            
            <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
              <div className="text-center">
                <p className="text-xs text-muted-foreground mb-1">Daily Payment for {calculation.durationDays} days</p>
                <p className="text-2xl font-bold text-primary font-mono">{formatAmount(calculation.dailyRepayment)}</p>
              </div>
            </div>
            
            <Button onClick={onProceed} className="w-full mt-4">
              Proceed to Request
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { useState, useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calculator, ArrowRight, Home, Wallet, Calendar, Users } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { useNavigate, useSearchParams } from 'react-router-dom';

const PLATFORM_FEE = 10000;
const MONTHLY_COMPOUND_RATE = 0.33;

function calculateCompoundingAccessFee(amount: number, days: number): number {
  const months = days / 30;
  const rate = Math.pow(1 + MONTHLY_COMPOUND_RATE, months) - 1;
  return Math.round(amount * rate);
}

const quickOptions = [
  { days: 7, label: '1 Week' },
  { days: 14, label: '2 Weeks' },
  { days: 30, label: '30 Days' },
  { days: 60, label: '60 Days' },
  { days: 90, label: '90 Days' },
  { days: 120, label: '4 Months' },
];

export default function PublicRentCalculator() {
  const { formatAmount, currency } = useCurrency();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refId = searchParams.get('ref');
  const initialType = searchParams.get('type') || 'weekly-monthly';
  
  const [activeTab, setActiveTab] = useState(initialType);
  
  // Daily calculator state
  const [dailyRentAmount, setDailyRentAmount] = useState('');
  const [dailyDuration, setDailyDuration] = useState<'30' | '60' | '90'>('30');
  
  // Weekly/Monthly calculator state
  const [rentAmount, setRentAmount] = useState('');
  const [paybackDays, setPaybackDays] = useState(30);
  const [repaymentDates, setRepaymentDates] = useState(4);

  const maxRepaymentDates = Math.min(paybackDays, 30);

  // Daily calculation
  const dailyCalculation = useMemo(() => {
    const amount = parseInt(dailyRentAmount.replace(/,/g, ''));
    if (!amount || amount <= 0) return null;
    return calculateRentRepayment(amount, parseInt(dailyDuration) as 30 | 60 | 90);
  }, [dailyRentAmount, dailyDuration]);

  // Weekly/Monthly calculation
  const weeklyCalculation = useMemo(() => {
    const amount = parseInt(rentAmount.replace(/,/g, ''));
    if (!amount || amount <= 0) return null;

    const accessFee = calculateCompoundingAccessFee(amount, paybackDays);
    const totalRepayment = amount + accessFee + PLATFORM_FEE;
    const perInstallment = Math.ceil(totalRepayment / repaymentDates);
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

  const handlePaybackDaysChange = (days: number) => {
    setPaybackDays(days);
    const newMax = Math.min(days, 30);
    if (repaymentDates > newMax) {
      setRepaymentDates(Math.max(1, newMax));
    }
  };

  const handleSignUp = () => {
    const params = new URLSearchParams();
    params.set('role', 'tenant');
    if (refId) params.set('ref', refId);
    navigate(`/auth?${params.toString()}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-secondary/20">
      <Helmet>
        <title>Rent Calculator — Estimate Repayments | Welile</title>
        <meta
          name="description"
          content="Use Welile's free rent calculator to estimate your rent advance repayments, daily amounts, and access fees before you apply. Plan with confidence in Uganda."
        />
        <link rel="canonical" href="https://welileapp.com/rent-calculator" />
        <meta property="og:title" content="Welile Rent Calculator — Estimate Repayments" />
        <meta
          property="og:description"
          content="Estimate your rent advance repayments and daily amounts before you apply, free with Welile."
        />
        <meta property="og:url" content="https://welileapp.com/rent-calculator" />
      </Helmet>
      {/* Header */}
      <div className="bg-primary text-primary-foreground py-6 px-4">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center justify-between mb-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
              className="h-10 w-10 text-primary-foreground hover:bg-primary-foreground/20"
            >
              <Home className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">Welile Rent Calculator</h1>
            <div className="w-10" />
          </div>
          <p className="text-sm text-primary-foreground/80 text-center">
            Calculate your rent repayment plan - No signup required!
          </p>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Sign In / Sign Up CTA — top priority */}
        <div className="space-y-2">
          <button
            onClick={handleSignUp}
            className="w-full flex items-center justify-center gap-2 h-14 rounded-2xl bg-primary text-primary-foreground font-bold text-base shadow-md hover:shadow-lg hover:brightness-110 active:scale-[0.97] transition-all touch-manipulation"
          >
            Sign Up & Get Rent Paid
            <ArrowRight className="h-5 w-5" />
          </button>
          <button
            onClick={() => navigate('/auth')}
            className="w-full flex items-center justify-center gap-2 h-12 rounded-2xl border-2 border-primary text-primary font-semibold text-sm hover:bg-primary/5 active:scale-[0.97] transition-all touch-manipulation"
          >
            Already have an account? Log in
          </button>
        </div>

        {/* Benefits */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-3 rounded-xl bg-card border">
            <Wallet className="h-5 w-5 mx-auto mb-1 text-primary" />
            <p className="text-xs font-medium">Get Rent Paid</p>
          </div>
          <div className="text-center p-3 rounded-xl bg-card border">
            <Calendar className="h-5 w-5 mx-auto mb-1 text-primary" />
            <p className="text-xs font-medium">Flexible Terms</p>
          </div>
          <div className="text-center p-3 rounded-xl bg-card border">
            <Users className="h-5 w-5 mx-auto mb-1 text-primary" />
            <p className="text-xs font-medium">Easy Repayment</p>
          </div>
        </div>

        {/* Currency Switcher */}
        <div className="flex justify-end">
          <CurrencySwitcher variant="compact" />
        </div>

        {/* Calculator Tabs */}
        <h2 className="text-base font-semibold text-foreground">Choose your repayment plan</h2>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="daily">Daily Earners</TabsTrigger>
            <TabsTrigger value="weekly-monthly">Weekly/Monthly</TabsTrigger>
          </TabsList>

          {/* Daily Calculator */}
          <TabsContent value="daily">
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Calculator className="h-5 w-5 text-primary" />
                  Daily Repayment Calculator
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Rent Amount ({currency.code})</Label>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={dailyRentAmount}
                      onChange={(e) => setDailyRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="e.g., 500000"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Duration</Label>
                    <Select value={dailyDuration} onValueChange={(v) => setDailyDuration(v as '30' | '60' | '90')}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30">30 Days</SelectItem>
                        <SelectItem value="60">60 Days</SelectItem>
                        <SelectItem value="90">90 Days</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {dailyCalculation && (
                  <div className="mt-4 p-4 rounded-lg bg-secondary/50 space-y-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Rent Amount:</span>
                      <span className="font-mono font-medium">{formatAmount(dailyCalculation.rentAmount)}</span>
                    </div>
                    
                    <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">Daily Payment for {dailyCalculation.durationDays} days</p>
                        <p className="text-2xl font-bold text-primary font-mono">{formatAmount(dailyCalculation.dailyRepayment)}</p>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Weekly/Monthly Calculator */}
          <TabsContent value="weekly-monthly">
            <Card className="glass-card">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Calculator className="h-5 w-5 text-primary" />
                  Flexible Repayment Calculator
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Rent Amount ({currency.code})</Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={rentAmount}
                    onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="e.g., 500000"
                  />
                </div>

                {/* Quick Select */}
                <div className="space-y-2">
                  <Label>Quick Select</Label>
                  <div className="flex flex-wrap gap-2">
                    {quickOptions.map((option) => (
                      <Button
                        key={option.days}
                        variant={paybackDays === option.days ? "default" : "outline"}
                        size="sm"
                        onClick={() => handlePaybackDaysChange(option.days)}
                        className="text-xs"
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Slider */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label>Payback Period</Label>
                    <span className="text-sm font-medium text-primary">{paybackDays} days</span>
                  </div>
                  <Slider
                    value={[paybackDays]}
                    onValueChange={(value) => handlePaybackDaysChange(value[0])}
                    min={7}
                    max={120}
                    step={1}
                  />
                </div>

                {/* Payments */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <Label>Number of Payments</Label>
                    <span className="text-sm font-medium text-primary">{repaymentDates}</span>
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
                </div>

                {weeklyCalculation && (
                  <div className="mt-4 p-4 rounded-lg bg-secondary/50 space-y-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Rent Amount:</span>
                      <span className="font-mono font-medium">{formatAmount(weeklyCalculation.rentAmount)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Platform Fee:</span>
                      <span className="font-mono font-medium">{formatAmount(weeklyCalculation.platformFee)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                      <span className="text-muted-foreground">Access Fee:</span>
                      <span className="font-mono font-medium text-warning">{formatAmount(weeklyCalculation.accessFee)}</span>
                    </div>
                    
                    <div className="border-t pt-3 space-y-3">
                      <div className="p-3 rounded-lg bg-accent/20 border border-accent/30">
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground mb-1">
                            {weeklyCalculation.repaymentDates} payment{weeklyCalculation.repaymentDates > 1 ? 's' : ''} of
                          </p>
                          <p className="text-xl font-bold font-mono">
                            {formatAmount(weeklyCalculation.perInstallment)}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">
                            every {weeklyCalculation.daysBetweenPayments} day{weeklyCalculation.daysBetweenPayments > 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                      
                      <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                        <div className="text-center">
                          <p className="text-xs text-muted-foreground mb-1">
                            Total to Pay in {weeklyCalculation.days} days
                          </p>
                          <p className="text-2xl font-bold text-primary font-mono">
                            {formatAmount(weeklyCalculation.totalRepayment)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>


        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground pb-4">
          This calculator works offline • No signup required
        </p>
      </div>
    </div>
  );
}

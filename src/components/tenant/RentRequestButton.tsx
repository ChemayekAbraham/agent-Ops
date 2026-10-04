import { useState, useEffect, useMemo } from 'react';
import { Lc1VillagePicker } from '@/components/location/Lc1VillagePicker';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { 
  HandCoins, 
  Calculator, 
  MapPin, 
  User, 
  Building2,
  CheckCircle2,
  ArrowRight,
  Loader2,
  Info
} from 'lucide-react';
import { calculateRentRepayment, RentCalculation } from '@/lib/rentCalculations';
import { supabase } from '@/integrations/supabase/client';
import { validateFormPayload, RENT_REQUEST_CONTRACT } from '@/lib/formContracts';
import { useToast } from '@/hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { useCurrency } from '@/hooks/useCurrency';
import { CurrencySwitcher } from '@/components/CurrencySwitcher';

// Weekly/Monthly calculator constants
const PLATFORM_FEE = 10000;
const DAILY_ACCESS_FEE_RATE = 0.011;

type RepaymentPeriod = '7' | '14' | '30' | '60' | '90' | '120';

const repaymentOptions: { value: RepaymentPeriod; label: string; days: number }[] = [
  { value: '7', label: 'Weekly (7 days)', days: 7 },
  { value: '14', label: 'After 2 Weeks (14 days)', days: 14 },
  { value: '30', label: 'After 30 Days (1 month)', days: 30 },
  { value: '60', label: 'After 60 Days (2 months)', days: 60 },
  { value: '90', label: 'After 90 Days (3 months)', days: 90 },
  { value: '120', label: 'After 4 Months (120 days)', days: 120 },
];

interface ExtendedCalculation extends RentCalculation {
  periodLabel: string;
  accessFeePerDay: number;
}

interface WeeklyMonthlyCalculatorInlineProps {
  onProceed: (calc: RentCalculation) => void;
  onBack: () => void;
  currency: { code: string };
  formatAmount: (amount: number) => string;
}

function WeeklyMonthlyCalculatorInline({ onProceed, onBack, currency, formatAmount }: WeeklyMonthlyCalculatorInlineProps) {
  const [rentAmount, setRentAmount] = useState('');
  const [repaymentPeriod, setRepaymentPeriod] = useState<RepaymentPeriod>('7');

  const calculation: ExtendedCalculation | null = useMemo(() => {
    const amount = parseInt(rentAmount.replace(/,/g, ''));
    if (!amount || amount < 50000) return null;

    const selectedOption = repaymentOptions.find(o => o.value === repaymentPeriod);
    if (!selectedOption) return null;

    const days = selectedOption.days;
    const accessFee = Math.round(amount * DAILY_ACCESS_FEE_RATE * days);
    const totalRepayment = amount + accessFee + PLATFORM_FEE;

    return {
      rentAmount: amount,
      durationDays: days as 30 | 60 | 90,
      accessFee,
      requestFee: PLATFORM_FEE,
      totalRepayment,
      dailyRepayment: Math.ceil(totalRepayment / days),
      accessFeeRate: DAILY_ACCESS_FEE_RATE * days * 100,
      periodLabel: selectedOption.label,
      accessFeePerDay: Math.round(amount * DAILY_ACCESS_FEE_RATE),
    };
  }, [rentAmount, repaymentPeriod]);

  const formatDisplayAmount = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num)) return '';
    return num.toLocaleString();
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Calculator className="h-4 w-4" />
            Rent Amount ({currency.code})
          </Label>
          <Input
            type="text"
            value={formatDisplayAmount(rentAmount)}
            onChange={(e) => setRentAmount(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="e.g., 500,000"
            className="text-lg font-mono"
          />
          {parseInt(rentAmount) > 0 && parseInt(rentAmount) < 50000 && (
            <p className="text-xs text-destructive">Minimum rent amount is UGX 50,000</p>
          )}
        </div>

        <div className="space-y-2">
          <Label>When to Pay Back</Label>
          <Select value={repaymentPeriod} onValueChange={(v) => setRepaymentPeriod(v as RepaymentPeriod)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repaymentOptions.map(option => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {calculation && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-xl bg-gradient-to-br from-secondary/50 to-secondary/30 space-y-3"
        >
          <div className="flex items-center gap-2 mb-3">
            <Info className="h-4 w-4 text-amber-600" />
            <span className="font-semibold text-sm">Your Repayment Plan</span>
          </div>

          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Rent Amount:</span>
            <span className="font-mono font-medium">{formatAmount(calculation.rentAmount)}</span>
          </div>

          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">Platform Fee:</span>
            <span className="font-mono font-medium">{formatAmount(calculation.requestFee)}</span>
          </div>

          <div className="flex justify-between items-center text-sm">
            <span className="text-muted-foreground">
              Access Fee ({calculation.durationDays} days × 1.1%/day):
            </span>
            <span className="font-mono font-medium text-amber-600">{formatAmount(calculation.accessFee)}</span>
          </div>

          <div className="text-xs text-muted-foreground pl-2 border-l-2 border-muted">
            Daily rate: {formatAmount(calculation.accessFeePerDay)}/day
          </div>

          <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total to Pay Back</p>
                <p className="text-2xl font-bold text-amber-600 font-mono">{formatAmount(calculation.totalRepayment)}</p>
              </div>
              <Badge variant="secondary" className="text-sm bg-amber-500/20 text-amber-700">
                {calculation.periodLabel}
              </Badge>
            </div>
          </div>
        </motion.div>
      )}

      <div className="flex gap-3">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button 
          onClick={() => calculation && onProceed(calculation)} 
          disabled={!calculation}
          className="flex-1"
          size="lg"
        >
          Continue
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}

interface RentRequestButtonProps {
  userId: string;
  onSuccess: () => void;
}

export function RentRequestButton({ userId, onSuccess }: RentRequestButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<'select-type' | 'calculate' | 'details' | 'confirm'>('select-type');
  const [incomeType, setIncomeType] = useState<'daily' | 'weekly-monthly' | null>(null);
  const { toast } = useToast();
  const { formatAmount, currency } = useCurrency();
  
  // Calculator state
  const [rentAmount, setRentAmount] = useState('');
  const [duration, setDuration] = useState<'30' | '60' | '90'>('30');
  const [calculation, setCalculation] = useState<RentCalculation | null>(null);
  
  // Location and details state
  const [tenantLocation, setTenantLocation] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  
  // Landlord state
  const [landlordName, setLandlordName] = useState('');
  const [landlordPhone, setLandlordPhone] = useState('');
  const [landlordMobileMoney, setLandlordMobileMoney] = useState('');
  const [landlordBankName, setLandlordBankName] = useState('');
  const [landlordAccountNumber, setLandlordAccountNumber] = useState('');
  
  // LC1 state
  const [lc1Name, setLc1Name] = useState('');
  const [lc1Phone, setLc1Phone] = useState('');
  const [lc1Village, setLc1Village] = useState('');
  
  const [loading, setLoading] = useState(false);

  // Auto-calculate when rent amount or duration changes
  useEffect(() => {
    const amount = parseInt(rentAmount.replace(/,/g, ''));
    if (amount > 0) {
      setCalculation(calculateRentRepayment(amount, parseInt(duration) as 30 | 60 | 90));
    } else {
      setCalculation(null);
    }
  }, [rentAmount, duration]);

  const handleRentAmountChange = (value: string) => {
    const numericValue = value.replace(/[^0-9]/g, '');
    setRentAmount(numericValue);
  };

  const formatDisplayAmount = (value: string) => {
    const num = parseInt(value);
    if (isNaN(num)) return '';
    return num.toLocaleString();
  };

  const handleSubmit = async () => {
    if (!calculation) return;
    setLoading(true);

    try {
      // Verify session is still valid before submitting
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) {
        // Try refreshing the session
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) {
          toast({
            title: 'Session Expired',
            description: 'Please log in again to submit your request.',
            variant: 'destructive',
          });
          setLoading(false);
          return;
        }
      }

      // Create landlord with payment details
      const { data: landlord, error: landlordError } = await supabase
        .from('landlords')
        .insert({ 
          name: landlordName, 
          phone: landlordPhone, 
          property_address: propertyAddress,
          mobile_money_number: landlordMobileMoney || null,
          bank_name: landlordBankName || null,
          account_number: landlordAccountNumber || null,
          monthly_rent: calculation.rentAmount,
          registered_by: userId,
          tenant_id: userId
        })
        .select('id')
        .single();

      if (landlordError) throw landlordError;

      // Create LC1
      const { data: lc1, error: lc1Error } = await supabase
        .from('lc1_chairpersons')
        .insert({ name: lc1Name, phone: lc1Phone, village: lc1Village || tenantLocation })
        .select('id')
        .single();

      if (lc1Error) throw lc1Error;

      // Get referral agent ID from localStorage
      const agentId = localStorage.getItem('referral_agent_id');

      // Capture GPS location (non-blocking — don't let this fail the submission)
      let requestLat: number | null = null;
      let requestLon: number | null = null;
      let requestCity: string | null = null;
      let requestCountry: string | null = null;
      
      try {
        const position = await Promise.race([
          new Promise<GeolocationPosition>((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: false,
              timeout: 3000,
              maximumAge: 300000,
            });
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('GPS timeout')), 3000))
        ]);
        requestLat = position.coords.latitude;
        requestLon = position.coords.longitude;
        if (requestLat >= -1.5 && requestLat <= 4.2 && requestLon >= 29.5 && requestLon <= 35.0) {
          requestCountry = 'Uganda';
        }
      } catch {
        // GPS failed — proceed without location
      }

      // Build rent request payload with validated types
      const rentPayload = {
        tenant_id: userId,
        agent_id: agentId || null,
        landlord_id: landlord.id,
        lc1_id: lc1.id,
        rent_amount: calculation.rentAmount,
        duration_days: calculation.durationDays,
        access_fee: calculation.accessFee,
        request_fee: calculation.requestFee,
        total_repayment: calculation.totalRepayment,
        daily_repayment: calculation.dailyRepayment,
        request_latitude: requestLat,
        request_longitude: requestLon,
        request_city: requestCity,
        request_country: requestCountry,
      };

      // Contract-driven pre-submit validation
      const validation = validateFormPayload(RENT_REQUEST_CONTRACT, rentPayload as Record<string, unknown>);
      if (!validation.valid) {
        const msg = validation.errors.map(e => e.message).join('; ');
        throw new Error(`Validation: ${msg}`);
      }

      // Create rent request
      const { error: requestError } = await supabase.from('rent_requests').insert({
        ...rentPayload,
        status: 'pending'
      } as any);

      if (requestError) throw requestError;

      toast({
        title: '✅ Request Submitted!',
        description: 'Your rent request has been sent for verification by the agent and manager.',
      });

      // Reset form
      setRentAmount('');
      setDuration('30');
      setCalculation(null);
      setTenantLocation('');
      setPropertyAddress('');
      setLandlordName('');
      setLandlordPhone('');
      setLandlordMobileMoney('');
      setLandlordBankName('');
      setLandlordAccountNumber('');
      setLc1Name('');
      setLc1Phone('');
      setLc1Village('');
      setStep('select-type');
      setIncomeType(null);
      setIsOpen(false);
      onSuccess();

    } catch (error: any) {
      const msg = error.message || 'Failed to submit request';
      if (msg.includes('row-level security') || msg.includes('RLS')) {
        toast({
          title: 'Session Expired',
          description: 'Your session has expired. Please log out and log in again.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Error',
          description: msg,
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const canProceedToDetails = calculation && parseInt(rentAmount) >= 50000;
  const canProceedToConfirm = landlordName && landlordPhone && propertyAddress && lc1Name && lc1Phone;

  return (
    <>
      {/* Prominent Request Rent Button */}
      <Card className="overflow-hidden border-2 border-primary/30 bg-gradient-to-br from-primary/5 via-background to-primary/10 shadow-lg hover:shadow-xl transition-all duration-300">
        <CardContent className="p-0">
          <button
            onClick={() => setIsOpen(true)}
            className="w-full p-4 flex items-center gap-4 hover:bg-primary/5 transition-colors group"
          >
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center shadow-lg group-hover:scale-105 transition-transform">
              <HandCoins className="h-7 w-7 text-primary-foreground" />
            </div>
            <div className="flex-1 text-left">
              <h3 className="text-lg font-bold text-foreground">Request Rent Assistance</h3>
              <p className="text-sm text-muted-foreground">
                Calculate and request rent support from Welile
              </p>
            </div>
            <ArrowRight className="h-6 w-6 text-primary group-hover:translate-x-1 transition-transform" />
          </button>
        </CardContent>
      </Card>

      {/* Request Dialog */}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <HandCoins className="h-5 w-5 text-primary" />
                Request Rent Assistance
              </span>
              {step !== 'select-type' && <CurrencySwitcher variant="compact" />}
            </DialogTitle>
            <DialogDescription>
              {step === 'select-type' && 'Choose your income type to get the right repayment plan'}
              {step === 'calculate' && 'Enter your rent amount to see the repayment breakdown'}
              {step === 'details' && 'Provide your location and landlord details'}
              {step === 'confirm' && 'Review and confirm your request'}
            </DialogDescription>
          </DialogHeader>

          {/* Step Indicator - Only show after type selection */}
          {step !== 'select-type' && (
            <div className="flex items-center gap-2 mb-4">
              {['calculate', 'details', 'confirm'].map((s, i) => (
                <div key={s} className="flex items-center">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                    step === s ? 'bg-primary text-primary-foreground' : 
                    ['calculate', 'details', 'confirm'].indexOf(step) > i ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                  }`}>
                    {i + 1}
                  </div>
                  {i < 2 && <div className={`w-8 h-0.5 ${['calculate', 'details', 'confirm'].indexOf(step) > i ? 'bg-primary' : 'bg-muted'}`} />}
                </div>
              ))}
            </div>
          )}

          <AnimatePresence mode="wait">
            {/* Step 0: Income Type Selection */}
            {step === 'select-type' && (
              <motion.div
                key="select-type"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-4"
              >
                <div className="text-center mb-2">
                  <p className="text-sm text-muted-foreground">
                    Select your income type to see the right repayment plan for you
                  </p>
                </div>

                <div className="grid gap-3">
                  {/* Daily Income Earner */}
                  <button
                    onClick={() => {
                      setIncomeType('daily');
                      setStep('calculate');
                    }}
                    className="w-full p-4 rounded-xl border-2 border-primary/30 bg-gradient-to-br from-primary/5 to-primary/10 hover:border-primary hover:bg-primary/15 transition-all group text-left"
                  >
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 rounded-xl bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors">
                        <Calculator className="h-6 w-6 text-primary" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-foreground">I'm a Daily Income Earner</h4>
                        <p className="text-sm text-muted-foreground">
                          Pay back daily over 30, 60, or 90 days
                        </p>
                      </div>
                      <ArrowRight className="h-5 w-5 text-primary opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                    </div>
                  </button>

                  {/* Weekly/Monthly Income Earner */}
                  <button
                    onClick={() => {
                      setIncomeType('weekly-monthly');
                      setStep('calculate');
                    }}
                    className="w-full p-4 rounded-xl border-2 border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-amber-500/10 hover:border-amber-500 hover:bg-amber-500/15 transition-all group text-left"
                  >
                    <div className="flex items-center gap-4">
                      <div className="h-12 w-12 rounded-xl bg-amber-500/20 flex items-center justify-center group-hover:bg-amber-500/30 transition-colors">
                        <Calculator className="h-6 w-6 text-amber-600" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-semibold text-foreground">I'm a Weekly or Monthly Earner</h4>
                        <p className="text-sm text-muted-foreground">
                          Pay back weekly or after 2-4 weeks
                        </p>
                      </div>
                      <ArrowRight className="h-5 w-5 text-amber-600 opacity-0 group-hover:opacity-100 group-hover:translate-x-1 transition-all" />
                    </div>
                  </button>
                </div>

                <p className="text-xs text-center text-muted-foreground mt-4">
                  Choose the option that matches your income pattern for the best repayment experience
                </p>
              </motion.div>
            )}

            {/* Step 1: Calculator (Daily) */}
            {step === 'calculate' && incomeType === 'daily' && (
              <motion.div
                key="calculate"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label className="flex items-center gap-2">
                      <Calculator className="h-4 w-4" />
                      Rent Amount ({currency.code})
                    </Label>
                    <Input
                      type="text"
                      value={formatDisplayAmount(rentAmount)}
                      onChange={(e) => handleRentAmountChange(e.target.value)}
                      placeholder="e.g., 500,000"
                      className="text-lg font-mono"
                    />
                    {parseInt(rentAmount) > 0 && parseInt(rentAmount) < 50000 && (
                      <p className="text-xs text-destructive">Minimum rent amount is UGX 50,000</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label>Repayment Duration</Label>
                    <Select value={duration} onValueChange={(v) => setDuration(v as '30' | '60' | '90')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30">30 Days (1 Month)</SelectItem>
                        <SelectItem value="60">60 Days (2 Months)</SelectItem>
                        <SelectItem value="90">90 Days (3 Months)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Auto-calculated Breakdown */}
                {calculation && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 rounded-xl bg-gradient-to-br from-secondary/50 to-secondary/30"
                  >
                    <div className="flex items-center gap-2 mb-3">
                      <Info className="h-4 w-4 text-primary" />
                      <span className="font-semibold text-sm">Your Repayment Plan</span>
                    </div>
                    
                    <div className="flex justify-between items-center text-sm mb-3">
                      <span className="text-muted-foreground">Rent Amount:</span>
                      <span className="font-mono font-medium">{formatAmount(calculation.rentAmount)}</span>
                    </div>

                    {/* Daily Repayment Highlight - Main Focus */}
                    <div className="p-4 rounded-lg bg-primary/10 border border-primary/20">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs text-muted-foreground">Daily Payment</p>
                          <p className="text-2xl font-bold text-primary font-mono">{formatAmount(calculation.dailyRepayment)}</p>
                        </div>
                        <Badge variant="secondary" className="text-sm">
                          For {calculation.durationDays} days
                        </Badge>
                      </div>
                    </div>
                  </motion.div>
                )}

                <div className="flex gap-3">
                  <Button 
                    variant="outline"
                    onClick={() => {
                      setStep('select-type');
                      setIncomeType(null);
                    }}
                  >
                    Back
                  </Button>
                  <Button 
                    onClick={() => setStep('details')} 
                    disabled={!canProceedToDetails}
                    className="flex-1"
                    size="lg"
                  >
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </motion.div>
            )}

            {/* Step 1: Calculator (Weekly/Monthly) */}
            {step === 'calculate' && incomeType === 'weekly-monthly' && (
              <motion.div
                key="calculate-weekly"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <WeeklyMonthlyCalculatorInline 
                  onProceed={(calc) => {
                    setCalculation(calc);
                    setStep('details');
                  }}
                  onBack={() => {
                    setStep('select-type');
                    setIncomeType(null);
                  }}
                  currency={currency}
                  formatAmount={formatAmount}
                />
              </motion.div>
            )}

            {/* Step 2: Location & Details */}
            {step === 'details' && (
              <motion.div
                key="details"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                {/* Tenant Location */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    Your Location (Village/Area)
                  </Label>
                  <Input
                    value={tenantLocation}
                    onChange={(e) => setTenantLocation(e.target.value)}
                    placeholder="e.g., Nakawa, Kampala"
                  />
                </div>

                <Separator />

                {/* Landlord Details */}
                <div className="space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    Landlord Details
                  </h4>
                  <div className="grid gap-3">
                    <Input
                      placeholder="Landlord Full Name *"
                      value={landlordName}
                      onChange={(e) => setLandlordName(e.target.value)}
                      required
                    />
                    <Input
                      placeholder="Landlord Phone *"
                      value={landlordPhone}
                      onChange={(e) => setLandlordPhone(e.target.value)}
                      required
                    />
                    <Input
                      placeholder="Property Address *"
                      value={propertyAddress}
                      onChange={(e) => setPropertyAddress(e.target.value)}
                      required
                    />
                  </div>
                  
                  <p className="text-xs text-muted-foreground">Payment Details (for direct payment by supporter)</p>
                  <div className="grid gap-3">
                    <Input
                      placeholder="Mobile Money Number (optional)"
                      value={landlordMobileMoney}
                      onChange={(e) => setLandlordMobileMoney(e.target.value)}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder="Bank Name"
                        value={landlordBankName}
                        onChange={(e) => setLandlordBankName(e.target.value)}
                      />
                      <Input
                        placeholder="Account Number"
                        value={landlordAccountNumber}
                        onChange={(e) => setLandlordAccountNumber(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <Separator />

                {/* LC1 Details */}
                <div className="space-y-3">
                  <h4 className="font-medium flex items-center gap-2">
                    <User className="h-4 w-4" />
                    LC1 Chairperson (Reference)
                  </h4>
                  <div className="grid gap-3">
                    <Input
                      placeholder="LC1 Name *"
                      value={lc1Name}
                      onChange={(e) => setLc1Name(e.target.value)}
                      required
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        placeholder="LC1 Phone *"
                        value={lc1Phone}
                        onChange={(e) => setLc1Phone(e.target.value)}
                        required
                      />
                      <Lc1VillagePicker
                        label="Village"
                        value={lc1Village}
                        onChange={(name) => setLc1Village(name)}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <Button variant="outline" onClick={() => setStep('calculate')}>
                    Back
                  </Button>
                  <Button 
                    onClick={() => setStep('confirm')} 
                    disabled={!canProceedToConfirm}
                    className="flex-1"
                  >
                    Review Request
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Confirm */}
            {step === 'confirm' && calculation && (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="space-y-4"
              >
                <div className="p-4 rounded-xl bg-gradient-to-br from-primary/5 to-secondary/30 space-y-4">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                    Request Summary
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rent Amount:</span>
                      <span className="font-mono font-semibold">{formatAmount(calculation.rentAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Duration:</span>
                      <span className="font-medium">{calculation.durationDays} Days</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Total Repayment:</span>
                      <span className="font-mono font-semibold">{formatAmount(calculation.totalRepayment)}</span>
                    </div>
                    <div className="flex justify-between text-primary">
                      <span className="font-medium">Daily Payment:</span>
                      <span className="font-mono font-bold">{formatAmount(calculation.dailyRepayment)}</span>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-1 text-sm">
                    <p><span className="text-muted-foreground">Landlord:</span> {landlordName}</p>
                    <p><span className="text-muted-foreground">Property:</span> {propertyAddress}</p>
                    <p><span className="text-muted-foreground">LC1:</span> {lc1Name} ({lc1Village || tenantLocation})</p>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm">
                  <p className="text-warning-foreground">
                    <strong>Next Steps:</strong> Your request will be reviewed by an Agent and Manager. Once verified, a Supporter will pay your landlord directly.
                  </p>
                </div>

                <div className="flex gap-3 pt-2">
                  <Button variant="outline" onClick={() => setStep('details')}>
                    Back
                  </Button>
                  <Button 
                    onClick={handleSubmit} 
                    disabled={loading}
                    className="flex-1"
                    size="lg"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        Submit Request
                      </>
                    )}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </DialogContent>
      </Dialog>
    </>
  );
}

import { useState, useMemo } from 'react';
import { roleToSlug } from '@/lib/roleRoutes';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, Calculator, CheckCircle2, Banknote, TrendingUp, Building2, MapPin, Hammer, CreditCard, Clock, Share2, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';

const MONTHLY_GROWTH_RATE = 0.05; // 5% monthly compound
const LANDLORD_FEE_RATE = 0.10; // 10% from landlord

const durationOptions = [
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months (1 year)' },
  { value: '24', label: '24 months (2 years)' },
  { value: '36', label: '36 months (3 years)' },
  { value: '60', label: '60 months (5 years)' },
];

const usageRules = [
  { icon: MapPin, text: 'Buying land', color: 'text-emerald-600' },
  { icon: Home, text: 'Buying a home', color: 'text-blue-600' },
  { icon: Hammer, text: 'Building a house', color: 'text-amber-600' },
  { icon: CreditCard, text: 'Mortgage down payment', color: 'text-purple-600' },
];

const howItWorks = [
  { step: 1, text: 'Tenant pays rent via Welile Wallet', icon: Banknote },
  { step: 2, text: 'Landlord pays 10% Welile fee', icon: Building2 },
  { step: 3, text: 'That 10% goes into tenant Welile Homes Savings', icon: Home },
  { step: 4, text: 'Savings grow 5% every month', icon: TrendingUp },
];

export default function WelileHomes() {
  const navigate = useNavigate();
  const [monthlyRent, setMonthlyRent] = useState<string>('');
  const [duration, setDuration] = useState<string>('60');
  const [showResult, setShowResult] = useState(false);

  const calculatedFund = useMemo(() => {
    const rent = parseFloat(monthlyRent) || 0;
    const months = parseInt(duration) || 12;
    
    if (rent <= 0) return 0;
    
    let balance = 0;
    const monthlyContribution = rent * LANDLORD_FEE_RATE;
    
    for (let i = 0; i < months; i++) {
      balance = (balance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
    }
    
    return Math.round(balance);
  }, [monthlyRent, duration]);

  const handleCalculate = () => {
    if (parseFloat(monthlyRent) > 0) {
      setShowResult(true);
    }
  };

  const handleInviteLandlord = () => {
    const message = `Hello! I'm using Welile to pay my rent and build my future home savings. When landlords receive rent through Welile Wallet, 10% of the platform fee goes into a tenant's Welile Homes Savings Account — which grows at 5% monthly compound interest.

I'd love for you to join Welile so I can start building my housing fund while paying rent to you!

🏠 Benefits for landlords:
✅ Receive rent 1 month upfront
✅ Only 10% platform fee
✅ Welile manages tenant coordination
✅ Reduced vacancy risk

Join here: https://welile2.lovable.app/join

Let's build a better future together! 🏡`;

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-background to-purple-50/30">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/dashboard/tenant')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
              <Home className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg">Welile Homes</h1>
              <p className="text-xs text-muted-foreground">Your future home fund</p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 pb-24 space-y-6 max-w-lg mx-auto">
        {/* SECTION 1 — HERO MESSAGE */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-4 py-6"
        >
          <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100">
            🏠 Housing Savings Program
          </Badge>
          <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-purple-800 bg-clip-text text-transparent">
            Turn Your Rent Into Your Future Home
          </h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            When tenants pay rent through Welile Wallet, the landlord pays a 10% Welile fee. 
            That 10% is saved in the tenant's <strong>Welile Homes Savings Account</strong>, not as spending money, 
            but as a <strong>housing fund</strong>. These savings grow at <strong>5% compound interest every month</strong>.
          </p>
        </motion.div>

        {/* SECTION 2 — FUTURE HOME FUND CALCULATOR */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="border-purple-200 shadow-lg overflow-hidden">
            <CardHeader className="bg-gradient-to-r from-purple-500 to-purple-700 text-white">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Calculator className="h-5 w-5" />
                Future Home Fund Calculator
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="rent">Monthly Rent (UGX)</Label>
                <Input
                  id="rent"
                  type="number"
                  placeholder="e.g. 500000"
                  value={monthlyRent}
                  onChange={(e) => {
                    setMonthlyRent(e.target.value);
                    setShowResult(false);
                  }}
                  className="text-lg"
                />
              </div>

              <div className="space-y-2">
                <Label>How many months will you stay?</Label>
                <Select value={duration} onValueChange={(v) => { setDuration(v); setShowResult(false); }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {durationOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button 
                onClick={handleCalculate} 
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800"
                disabled={!monthlyRent || parseFloat(monthlyRent) <= 0}
              >
                <Calculator className="h-4 w-4 mr-2" />
                Calculate My Savings
              </Button>

              {showResult && calculatedFund > 0 && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-4 p-4 bg-gradient-to-br from-purple-50 to-purple-100 rounded-xl text-center space-y-3"
                >
                  <p className="text-sm text-purple-600 font-medium">Your Future Home Fund</p>
                  <p className="text-3xl font-bold text-purple-700">{formatUGX(calculatedFund)}</p>
                  <p className="text-xs text-muted-foreground">
                    This is money built from rent you already pay.
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <TrendingUp className="h-4 w-4 text-emerald-500" />
                    <span className="text-xs text-emerald-600">Growing at 5% monthly compound</span>
                  </div>
                  
                  <Separator className="my-3" />
                  
                  <Button 
                    onClick={() => navigate('/welile-homes-dashboard')}
                    className="w-full bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700"
                  >
                    <Home className="h-4 w-4 mr-2" />
                    Subscribe & Start Saving
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    View your dashboard and learn how to start
                  </p>
                </motion.div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* SECTION 3 — HOW IT WORKS */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-purple-600" />
                How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {howItWorks.map((item, index) => (
                <div key={item.step} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 font-bold text-sm">
                    {item.step}
                  </div>
                  <item.icon className="h-4 w-4 text-purple-500" />
                  <span className="text-sm flex-1">{item.text}</span>
                  {index < howItWorks.length - 1 && (
                    <div className="absolute left-[19px] mt-8 h-3 w-0.5 bg-purple-200" />
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>

        {/* SECTION 4 — USAGE RULES */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="border-purple-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                Where This Money Can Be Used
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                This fund can <strong>ONLY</strong> be used for:
              </p>
              <div className="grid grid-cols-2 gap-2">
                {usageRules.map((rule) => (
                  <div key={rule.text} className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
                    <rule.icon className={`h-4 w-4 ${rule.color}`} />
                    <span className="text-sm font-medium">{rule.text}</span>
                  </div>
                ))}
              </div>
              <Separator className="my-3" />
              <div className="flex items-start gap-2 p-3 bg-amber-50 rounded-lg border border-amber-200">
                <Clock className="h-4 w-4 text-amber-600 mt-0.5" />
                <p className="text-xs text-amber-700">
                  If not used for housing, withdrawal is allowed after <strong>24 months</strong>.
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* SECTION 5 — LANDLORD REGISTRATION PUSH */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <Card className="bg-gradient-to-br from-purple-600 to-purple-800 text-white border-0">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
                  <Building2 className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">Activate Your Home Savings</h3>
                  <p className="text-sm text-purple-100">
                    This benefit only works if your landlord receives rent through Welile Wallet. 
                    Ask your landlord to join Welile so your home savings can start growing.
                  </p>
                </div>
              </div>
              <Button 
                onClick={handleInviteLandlord}
                className="w-full bg-card text-purple-700 hover:bg-purple-50"
              >
                <MessageCircle className="h-4 w-4 mr-2" />
                Invite My Landlord
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* SECTION 6 — MOTIVATION */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          className="text-center py-8"
        >
          <h2 className="text-2xl font-bold bg-gradient-to-r from-purple-600 via-purple-700 to-purple-800 bg-clip-text text-transparent">
            Rent today. Own tomorrow.
          </h2>
          <p className="text-sm text-muted-foreground mt-2">
            Your journey to homeownership starts with every rent payment.
          </p>
          <div className="flex justify-center gap-2 mt-4">
            <div className="w-2 h-2 rounded-full bg-purple-300" />
            <div className="w-2 h-2 rounded-full bg-purple-500" />
            <div className="w-2 h-2 rounded-full bg-purple-700" />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

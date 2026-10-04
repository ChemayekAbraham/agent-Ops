import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, TrendingUp, Calendar, Wallet, CheckCircle2, Clock, Target, ChevronRight, Sparkles, Info, CreditCard, Building2, MessageCircle, PartyPopper, AlertCircle, History, Plus, Percent, Banknote, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { formatUGX } from '@/lib/rentCalculations';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import confetti from 'canvas-confetti';
import { WithdrawalRequestDialog } from '@/components/welile-homes/WithdrawalRequestDialog';
import { TenantSavingsGrowthChart } from '@/components/welile-homes/TenantSavingsGrowthChart';
import { ContributionHistoryTimeline } from '@/components/welile-homes/ContributionHistoryTimeline';
import { SavingsStatementPDF } from '@/components/welile-homes/SavingsStatementPDF';
import { InviteFriendWelileHomes } from '@/components/welile-homes/InviteFriendWelileHomes';

const MONTHLY_GROWTH_RATE = 0.05;
const LANDLORD_FEE_RATE = 0.10;

// Calculate projected savings with compound growth
function calculateProjectedSavings(monthlyRent: number, months: number): number[] {
  const projections: number[] = [];
  let balance = 0;
  const monthlyContribution = monthlyRent * LANDLORD_FEE_RATE;
  
  for (let i = 0; i < months; i++) {
    balance = (balance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
    projections.push(Math.round(balance));
  }
  
  return projections;
}

export default function WelileHomesDashboard() {
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const queryClient = useQueryClient();
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [showWithdrawalDialog, setShowWithdrawalDialog] = useState(false);
  
  // Fetch user profile for rent amount
  const { data: profile } = useQuery({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('profiles')
        .select('monthly_rent, full_name')
        .eq('id', user.id)
        .single();
      return data;
    },
    enabled: !!user?.id
  });

  // Check if user has existing subscription
  const { data: subscription, isLoading: loadingSubscription } = useQuery({
    queryKey: ['welile-homes-subscription', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from('welile_homes_subscriptions')
        .select('*')
        .eq('tenant_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id
  });

  // Fetch contribution history
  const { data: contributions = [] } = useQuery({
    queryKey: ['welile-homes-contributions', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      // welile_homes_contributions table removed - return empty
      return [];
    },
    enabled: !!user?.id
  });

  // Fetch pending withdrawals
  const { data: pendingWithdrawals = [] } = useQuery({
    queryKey: ['welile-homes-withdrawals', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];
      // welile_homes_withdrawals table removed - return empty
      return [];
    },
    enabled: !!user?.id
  });

  // Subscribe mutation
  const subscribeMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('welile_homes_subscriptions')
        .insert({
          tenant_id: user.id,
          monthly_rent: profile?.monthly_rent || 500000,
          subscription_status: 'active',
          landlord_registered: false,
          total_savings: 0,
          months_enrolled: 0,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['welile-homes-subscription', user?.id] });
      setShowSuccessModal(true);
      // Trigger confetti
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    },
    onError: (error) => {
      toast.error('Failed to subscribe: ' + error.message);
    }
  });

  const monthlyRent = subscription?.monthly_rent || profile?.monthly_rent || 500000;
  const enrolledMonths = subscription?.months_enrolled || 0;
  const targetMonths = 60; // 5 year goal
  const isSubscribed = !!subscription;
  const landlordRegistered = subscription?.landlord_registered || false;
  
  // Calculate current savings (with compound interest)
  const currentSavings = useMemo(() => {
    if (subscription?.total_savings) return subscription.total_savings;
    const projections = calculateProjectedSavings(monthlyRent, enrolledMonths);
    return projections[projections.length - 1] || 0;
  }, [monthlyRent, enrolledMonths, subscription?.total_savings]);
  
  // Calculate target savings (at 60 months)
  const targetSavings = useMemo(() => {
    const projections = calculateProjectedSavings(monthlyRent, targetMonths);
    return projections[projections.length - 1] || 0;
  }, [monthlyRent, targetMonths]);
  
  // Calculate milestones
  const milestones = useMemo(() => {
    return [
      { months: 12, label: '1 Year', amount: calculateProjectedSavings(monthlyRent, 12).pop() || 0 },
      { months: 24, label: '2 Years', amount: calculateProjectedSavings(monthlyRent, 24).pop() || 0 },
      { months: 36, label: '3 Years', amount: calculateProjectedSavings(monthlyRent, 36).pop() || 0 },
      { months: 60, label: '5 Years', amount: calculateProjectedSavings(monthlyRent, 60).pop() || 0 },
    ];
  }, [monthlyRent]);

  const progressPercent = Math.min((enrolledMonths / targetMonths) * 100, 100);

  const paymentSteps = [
    { step: 1, title: 'Pay Rent via Rent Money', description: 'Make your monthly rent payment through the Rent Money system.' },
    { step: 2, title: 'Landlord Receives Rent', description: 'Your landlord receives the rent payment (minus 10% Welile fee).' },
    { step: 3, title: '10% Added to Home Savings', description: 'The 10% fee is deposited into your Welile Homes Savings Account.' },
    { step: 4, title: 'Savings Grow Monthly', description: 'Your savings earn 5% compound interest every month automatically.' },
  ];

  const handleSubscribe = () => {
    subscribeMutation.mutate();
  };

  const handleInviteLandlord = () => {
    const message = `Hello! I'm a tenant using Welile to build my future home savings. When you receive rent through Rent Money, 10% of the platform fee goes into my Welile Homes Savings Account which grows at 5% monthly compound interest.

🏠 Benefits for landlords:
✅ Receive rent 1 month upfront
✅ Only 10% platform fee
✅ Welile manages tenant coordination
✅ Reduced vacancy risk

Please join Welile so I can start building my housing fund! Join here: https://welile2.lovable.app/join

Let's build a better future together! 🏡`;

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-background to-purple-50/30">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(roleToSlug(role))}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2 flex-1">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center">
              <Home className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg">Welile Homes</h1>
              <p className="text-xs text-muted-foreground">Your savings dashboard</p>
            </div>
          </div>
          {isSubscribed ? (
            <Badge className="bg-emerald-100 text-emerald-700">Subscribed</Badge>
          ) : (
            <Badge variant="secondary">Not Subscribed</Badge>
          )}
        </div>
      </div>

      <div className="p-4 pb-24 space-y-6 max-w-lg mx-auto">
        {/* Subscribe Section (if not subscribed) */}
        {!isSubscribed && !loadingSubscription && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="border-purple-300 bg-gradient-to-br from-purple-50 to-white">
              <CardContent className="p-5 space-y-4 text-center">
                <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center mx-auto">
                  <Home className="h-8 w-8 text-purple-600" />
                </div>
                <h2 className="text-xl font-bold">Start Your Home Savings Journey</h2>
                <p className="text-sm text-muted-foreground">
                  Subscribe to Welile Homes and start building your future home fund with every rent payment.
                </p>
                
                {/* Summary Card */}
                <Card className="bg-card border-purple-200">
                  <CardContent className="p-4 space-y-3">
                    <h3 className="font-semibold text-sm">What You'll Get:</h3>
                    <div className="space-y-2 text-left">
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
                        <span className="text-sm">10% of landlord fee saved for you</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
                        <span className="text-sm">5% monthly compound interest growth</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
                        <span className="text-sm">Projected {formatUGX(targetSavings)} in 5 years</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5" />
                        <span className="text-sm">Use funds for land, home, or mortgage</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Button 
                  onClick={handleSubscribe}
                  className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 h-12"
                  disabled={subscribeMutation.isPending}
                >
                  {subscribeMutation.isPending ? 'Subscribing...' : 'Subscribe Now - It\'s Free!'}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Success Modal */}
        <AnimatePresence>
          {showSuccessModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
              onClick={() => setShowSuccessModal(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                onClick={(e) => e.stopPropagation()}
              >
                <Card className="max-w-sm">
                  <CardContent className="p-6 space-y-4 text-center">
                    <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center mx-auto">
                      <PartyPopper className="h-10 w-10 text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-bold text-emerald-700">Successfully Subscribed!</h2>
                    <p className="text-muted-foreground">
                      Welcome to Welile Homes! You're now on your journey to homeownership.
                    </p>
                    
                    <Separator />
                    
                    <div className="space-y-3 text-left">
                      <h3 className="font-semibold">Here's what to expect:</h3>
                      <div className="space-y-2">
                        <div className="flex items-start gap-2">
                          <Wallet className="h-4 w-4 text-purple-600 mt-0.5" />
                          <span className="text-sm">Pay rent through <strong>Rent Money</strong> to build savings</span>
                        </div>
                        <div className="flex items-start gap-2">
                          <TrendingUp className="h-4 w-4 text-emerald-600 mt-0.5" />
                          <span className="text-sm">Watch your fund grow at <strong>5% monthly</strong></span>
                        </div>
                        <div className="flex items-start gap-2">
                          <Home className="h-4 w-4 text-blue-600 mt-0.5" />
                          <span className="text-sm">Use savings for land, home, or mortgage</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
                        <p className="text-xs text-amber-700">
                          <strong>Important:</strong> Your savings only grow when your landlord is registered on Welile and you pay rent via Rent Money.
                        </p>
                      </div>
                    </div>
                    
                    <Button 
                      onClick={() => setShowSuccessModal(false)}
                      className="w-full bg-gradient-to-r from-purple-600 to-purple-700"
                    >
                      Got It!
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Landlord Not Registered Alert */}
        {isSubscribed && !landlordRegistered && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="border-amber-300 bg-gradient-to-br from-amber-50 to-amber-100">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-amber-200 flex items-center justify-center flex-shrink-0">
                    <Building2 className="h-5 w-5 text-amber-700" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-amber-800">Landlord Not Yet Registered</h3>
                    <p className="text-sm text-amber-700 mt-1">
                      Your savings will only start growing when your landlord joins Welile. Invite them now!
                    </p>
                  </div>
                </div>
                <Button 
                  onClick={handleInviteLandlord}
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white h-12"
                >
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Invite My Landlord via WhatsApp
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Pay with Wallet Encouragement */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="border-emerald-200 bg-gradient-to-br from-emerald-50 to-white">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                    <Wallet className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-emerald-800">Pay Rent with Rent Money</h3>
                    <p className="text-sm text-emerald-700 mt-1">
                      Every rent payment through Rent Money adds to your home savings. Start building your future today!
                    </p>
                  </div>
                </div>
                <Button 
                  onClick={() => navigate(roleToSlug(role))}
                  variant="outline"
                  className="w-full border-emerald-300 text-emerald-700 hover:bg-emerald-50 h-12"
                >
                  <Wallet className="h-4 w-4 mr-2" />
                  Go to Rent Money
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Current Savings Card (only show if subscribed) */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <Card className="overflow-hidden border-purple-200">
              <div className="bg-gradient-to-br from-purple-600 to-purple-800 p-5 text-white">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-purple-200 text-sm">Your Home Savings</p>
                    <p className="text-3xl font-bold mt-1">{formatUGX(currentSavings)}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <TrendingUp className="h-4 w-4 text-emerald-300" />
                      <span className="text-sm text-emerald-300">+5% monthly compound</span>
                    </div>
                  </div>
                  <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center">
                    <Home className="h-7 w-7" />
                  </div>
                </div>
              </div>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Progress to 5-Year Goal</span>
                    <span className="font-medium">{enrolledMonths} of {targetMonths} months</span>
                  </div>
                  <Progress value={progressPercent} className="h-2" />
                </div>
                <div className="flex items-center justify-between p-3 bg-purple-50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-purple-600" />
                    <span className="text-sm">5-Year Target</span>
                  </div>
                  <span className="font-bold text-purple-700">{formatUGX(targetSavings)}</span>
                </div>
                
                {/* Withdrawal Button */}
                {currentSavings > 0 && (
                  <Button
                    onClick={() => setShowWithdrawalDialog(true)}
                    variant="outline"
                    className="w-full border-purple-300 text-purple-700 hover:bg-purple-50 h-12"
                  >
                    <Banknote className="h-4 w-4 mr-2" />
                    Request Withdrawal
                  </Button>
                )}
                
                {/* Download Statement Button */}
                <SavingsStatementPDF
                  userName={profile?.full_name || 'Tenant'}
                  monthlyRent={monthlyRent}
                  totalSavings={currentSavings}
                  monthsEnrolled={enrolledMonths}
                  subscriptionStatus={subscription?.subscription_status || 'active'}
                  createdAt={subscription?.created_at || new Date().toISOString()}
                  contributions={contributions}
                  trigger={
                    <Button
                      variant="outline"
                      className="w-full border-purple-300 text-purple-700 hover:bg-purple-50 h-12"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Download Statement
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Invite Friends to Welile Homes */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.21 }}
          >
            <InviteFriendWelileHomes 
              currentSavings={currentSavings} 
              monthlyRent={monthlyRent} 
            />
          </motion.div>
        )}

        {/* Savings Growth Chart */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.22 }}
          >
            <TenantSavingsGrowthChart
              monthlyRent={monthlyRent}
              monthsEnrolled={enrolledMonths}
              totalSavings={currentSavings}
              contributions={contributions}
            />
          </motion.div>
        )}

        {/* Contribution History Timeline */}
        {isSubscribed && user?.id && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.24 }}
          >
            <ContributionHistoryTimeline userId={user.id} limit={5} />
          </motion.div>
        )}

        {/* Pending Withdrawals */}
        {isSubscribed && pendingWithdrawals.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Banknote className="h-5 w-5 text-purple-600" />
                  Your Withdrawal Requests
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendingWithdrawals.slice(0, 3).map((withdrawal: any) => (
                  <div 
                    key={withdrawal.id}
                    className={`flex items-center justify-between p-3 rounded-lg border ${
                      withdrawal.status === 'pending' 
                        ? 'bg-amber-50 border-amber-200'
                        : withdrawal.status === 'approved'
                        ? 'bg-emerald-50 border-emerald-200'
                        : withdrawal.status === 'rejected'
                        ? 'bg-red-50 border-red-200'
                        : 'bg-blue-50 border-blue-200'
                    }`}
                  >
                    <div>
                      <p className="text-sm font-medium">{formatUGX(withdrawal.amount)}</p>
                      <p className="text-xs text-muted-foreground">
                        {withdrawal.purpose.replace(/_/g, ' ')}
                      </p>
                    </div>
                    <Badge 
                      variant={
                        withdrawal.status === 'approved' ? 'default' :
                        withdrawal.status === 'rejected' ? 'destructive' :
                        withdrawal.status === 'disbursed' ? 'default' : 'secondary'
                      }
                      className={
                        withdrawal.status === 'approved' ? 'bg-emerald-100 text-emerald-700' :
                        withdrawal.status === 'disbursed' ? 'bg-blue-100 text-blue-700' :
                        withdrawal.status === 'pending' ? 'bg-amber-100 text-amber-700' : ''
                      }
                    >
                      {withdrawal.status}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Monthly Contribution */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                      <Wallet className="h-5 w-5 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Monthly Contribution</p>
                      <p className="font-bold">{formatUGX(monthlyRent * LANDLORD_FEE_RATE)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">From rent of</p>
                    <p className="text-sm font-medium">{formatUGX(monthlyRent)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Milestones */}
        {isSubscribed && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
          >
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-purple-600" />
                  Savings Milestones
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {milestones.map((milestone, index) => {
                  const isReached = enrolledMonths >= milestone.months;
                  const isNext = !isReached && (index === 0 || enrolledMonths >= milestones[index - 1].months);
                  
                  return (
                    <div 
                      key={milestone.months}
                      className={`flex items-center justify-between p-3 rounded-lg border ${
                        isReached 
                          ? 'bg-emerald-50 border-emerald-200' 
                          : isNext 
                            ? 'bg-purple-50 border-purple-200' 
                            : 'bg-muted/30 border-border'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {isReached ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                        ) : (
                          <div className={`w-5 h-5 rounded-full border-2 ${isNext ? 'border-purple-400' : 'border-muted-foreground/30'}`} />
                        )}
                        <span className={`font-medium ${isReached ? 'text-emerald-700' : ''}`}>
                          {milestone.label}
                        </span>
                      </div>
                      <span className={`font-bold ${isReached ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                        {formatUGX(milestone.amount)}
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Contribution History */}
        {isSubscribed && contributions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45 }}
          >
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <History className="h-5 w-5 text-purple-600" />
                  Recent Contributions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {contributions.map((contribution: any) => (
                  <div 
                    key={contribution.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border"
                  >
                    <div className="flex items-center gap-3">
                      {contribution.contribution_type === 'repayment' ? (
                        <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                          <Plus className="h-4 w-4 text-emerald-600" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center">
                          <Percent className="h-4 w-4 text-purple-600" />
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">
                          {contribution.contribution_type === 'repayment' ? 'Rent Payment' : 'Interest'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(contribution.created_at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-emerald-600">
                        +{formatUGX(contribution.amount)}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* How to Pay Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
        >
          <Card className="border-purple-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Info className="h-5 w-5 text-purple-600" />
                How Payments Work
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {paymentSteps.map((step, index) => (
                <div key={step.step} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 font-bold text-sm">
                      {step.step}
                    </div>
                    {index < paymentSteps.length - 1 && (
                      <div className="w-0.5 h-full min-h-[24px] bg-purple-200 mt-2" />
                    )}
                  </div>
                  <div className="flex-1 pb-4">
                    <p className="font-medium text-sm">{step.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">{step.description}</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </motion.div>

        {/* Usage Rules Reminder */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6 }}
        >
          <Card className="bg-gradient-to-br from-amber-50 to-amber-100 border-amber-200">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-200 flex items-center justify-center flex-shrink-0">
                  <Clock className="h-5 w-5 text-amber-700" />
                </div>
                <div>
                  <h3 className="font-semibold text-amber-800">Fund Usage Rules</h3>
                  <p className="text-sm text-amber-700 mt-1">
                    This fund can only be used for: buying land, buying a home, building a house, or mortgage down payment.
                  </p>
                  <p className="text-xs text-amber-600 mt-2">
                    Non-housing withdrawal allowed after 24 months.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* CTA to Calculator */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
        >
          <Button 
            onClick={() => navigate('/welile-homes')}
            variant="outline"
            className="w-full border-purple-200 text-purple-700 hover:bg-purple-50"
          >
            <TrendingUp className="h-4 w-4 mr-2" />
            View Savings Calculator
            <ChevronRight className="h-4 w-4 ml-auto" />
          </Button>
        </motion.div>

        {/* Motivation */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="text-center py-6"
        >
          <h2 className="text-xl font-bold bg-gradient-to-r from-purple-600 to-purple-800 bg-clip-text text-transparent">
            Every rent payment brings you closer to home ownership
          </h2>
        </motion.div>
      </div>

      {/* Withdrawal Request Dialog */}
      {subscription && (
        <WithdrawalRequestDialog
          open={showWithdrawalDialog}
          onOpenChange={setShowWithdrawalDialog}
          subscriptionId={subscription.id}
          currentSavings={currentSavings}
          monthsEnrolled={enrolledMonths}
        />
      )}
    </div>
  );
}

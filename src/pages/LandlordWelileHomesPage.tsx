import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  ArrowLeft, 
  Home, 
  Users, 
  TrendingUp, 
  Sparkles,
  Heart,
  Loader2,
  Calendar,
  MessageCircleHeart,
  Settings
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';
import { format } from 'date-fns';
import EncouragementMessageDialog from '@/components/landlord/EncouragementMessageDialog';
import { WelileHomesLandlordLeaderboard } from '@/components/landlord/WelileHomesLandlordLeaderboard';
import { ManageTenantSubscriptionDialog } from '@/components/landlord/ManageTenantSubscriptionDialog';
import { WelileHomesLandlordBadge } from '@/components/landlord/WelileHomesLandlordBadge';
import { SavingsGrowthChart } from '@/components/welile-homes/SavingsGrowthChart';
import ScreenLoader from '@/components/common/ScreenLoader';

interface TenantWithSavings {
  tenant_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  subscription_id: string;
  monthly_rent: number;
  total_savings: number;
  months_enrolled: number;
  subscription_status: string;
  landlord_registered: boolean;
  created_at: string;
}

const MONTHLY_GROWTH_RATE = 0.05;
const LANDLORD_FEE_RATE = 0.10;

function calculate5YearProjection(monthlyRent: number): number {
  let balance = 0;
  const monthlyContribution = monthlyRent * LANDLORD_FEE_RATE;
  for (let i = 0; i < 60; i++) {
    balance = (balance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
  }
  return Math.round(balance);
}

export default function LandlordWelileHomesPage() {
  const navigate = useNavigate();
  const { user, role } = useAuth();

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ['landlord-welile-homes-tenants-full', user?.id],
    queryFn: async () => {
      if (!user?.id) return [];

      const { data: rentRequests } = await supabase
        .from('rent_requests')
        .select('tenant_id')
        .eq('landlord_id', user.id);

      if (!rentRequests || rentRequests.length === 0) return [];

      const tenantIds = [...new Set(rentRequests.map((rr) => rr.tenant_id))];

      const { data: subscriptions } = await supabase
        .from('welile_homes_subscriptions')
        .select('*')
        .in('tenant_id', tenantIds)
        .order('created_at', { ascending: false });

      if (!subscriptions || subscriptions.length === 0) return [];

      const subscribedTenantIds = subscriptions.map((s) => s.tenant_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', subscribedTenantIds);

      return subscriptions.map((sub) => {
        const profile = profiles?.find((p) => p.id === sub.tenant_id);
        return {
          tenant_id: sub.tenant_id,
          tenant_name: profile?.full_name || 'Unknown',
          tenant_phone: profile?.phone || null,
          subscription_id: sub.id,
          monthly_rent: sub.monthly_rent,
          total_savings: sub.total_savings,
          months_enrolled: sub.months_enrolled,
          subscription_status: sub.subscription_status,
          landlord_registered: sub.landlord_registered,
          created_at: sub.created_at,
        };
      }) as TenantWithSavings[];
    },
    enabled: !!user?.id,
  });

  const totalSavings = tenants.reduce((sum, t) => sum + t.total_savings, 0);
  const activeTenants = tenants.filter((t) => t.subscription_status === 'active').length;
  const avgMonthsEnrolled = tenants.length > 0 
    ? Math.round(tenants.reduce((sum, t) => sum + t.months_enrolled, 0) / tenants.length)
    : 0;

  if (isLoading) {
    return (
      <ScreenLoader />
    );
  }

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
              <h1 className="font-bold text-lg">Welile Homes Impact</h1>
              <p className="text-xs text-muted-foreground">Your tenants' savings journey</p>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 pb-24 space-y-6 max-w-lg mx-auto">
        {/* Landlord Badge */}
        {user?.id && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <WelileHomesLandlordBadge userId={user.id} variant="full" showProgress />
          </motion.div>
        )}

        {/* Stats Overview */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="overflow-hidden border-purple-200">
            <div className="bg-gradient-to-br from-purple-600 to-purple-800 p-5 text-white">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-purple-200 text-sm">Total Savings Generated</p>
                  <p className="text-3xl font-bold">{formatUGX(totalSavings)}</p>
                </div>
                <div className="w-14 h-14 rounded-full bg-white/20 flex items-center justify-center">
                  <Heart className="h-7 w-7" />
                </div>
              </div>
              <p className="text-sm text-purple-200">
                You're helping {activeTenants} {activeTenants === 1 ? 'tenant' : 'tenants'} build towards homeownership
              </p>
            </div>
            <CardContent className="p-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-2 bg-purple-50 rounded-lg">
                  <Users className="h-5 w-5 text-purple-600 mx-auto mb-1" />
                  <p className="text-lg font-bold">{tenants.length}</p>
                  <p className="text-xs text-muted-foreground">Enrolled</p>
                </div>
                <div className="text-center p-2 bg-emerald-50 rounded-lg">
                  <TrendingUp className="h-5 w-5 text-emerald-600 mx-auto mb-1" />
                  <p className="text-lg font-bold">{activeTenants}</p>
                  <p className="text-xs text-muted-foreground">Active</p>
                </div>
                <div className="text-center p-2 bg-amber-50 rounded-lg">
                  <Calendar className="h-5 w-5 text-amber-600 mx-auto mb-1" />
                  <p className="text-lg font-bold">{avgMonthsEnrolled}</p>
                  <p className="text-xs text-muted-foreground">Avg Months</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Tenant List */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-purple-600" />
                Enrolled Tenants ({tenants.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {tenants.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Home className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p>No tenants enrolled in Welile Homes yet</p>
                </div>
              ) : (
                tenants.map((tenant, index) => {
                  const projection = calculate5YearProjection(tenant.monthly_rent);
                  const progressPercent = Math.min((tenant.total_savings / projection) * 100, 100);
                  const monthlyContribution = tenant.monthly_rent * LANDLORD_FEE_RATE;

                  return (
                    <motion.div
                      key={tenant.subscription_id}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="p-4 rounded-xl border bg-gradient-to-br from-white to-purple-50/30"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div>
                          <p className="font-semibold">{tenant.tenant_name}</p>
                          <p className="text-xs text-muted-foreground">
                            Enrolled {format(new Date(tenant.created_at), 'MMM d, yyyy')}
                          </p>
                        </div>
                        <div className="flex items-center gap-1">
                          <EncouragementMessageDialog 
                            tenant={{
                              tenant_id: tenant.tenant_id,
                              tenant_name: tenant.tenant_name,
                              total_savings: tenant.total_savings,
                              months_enrolled: tenant.months_enrolled
                            }}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-purple-600 hover:text-purple-700 hover:bg-purple-50">
                                <MessageCircleHeart className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <ManageTenantSubscriptionDialog
                            subscription={{
                              subscription_id: tenant.subscription_id,
                              tenant_id: tenant.tenant_id,
                              tenant_name: tenant.tenant_name,
                              monthly_rent: tenant.monthly_rent,
                              total_savings: tenant.total_savings,
                              months_enrolled: tenant.months_enrolled,
                              subscription_status: tenant.subscription_status,
                            }}
                            trigger={
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                                <Settings className="h-4 w-4" />
                              </Button>
                            }
                          />
                          <Badge 
                            variant={tenant.subscription_status === 'active' ? 'default' : 'secondary'}
                            className={
                              tenant.subscription_status === 'active' 
                                ? 'bg-emerald-100 text-emerald-700' 
                                : tenant.subscription_status === 'paused'
                                ? 'bg-amber-100 text-amber-700'
                                : ''
                            }
                          >
                            {tenant.subscription_status}
                          </Badge>
                        </div>
                      </div>

                      {/* Savings Display */}
                      <div className="grid grid-cols-2 gap-3 mb-3">
                        <div className="p-2 bg-card rounded-lg border">
                          <p className="text-xs text-muted-foreground">Current Savings</p>
                          <p className="font-bold text-emerald-600">{formatUGX(tenant.total_savings)}</p>
                        </div>
                        <div className="p-2 bg-card rounded-lg border">
                          <p className="text-xs text-muted-foreground">Monthly Contribution</p>
                          <p className="font-bold text-purple-600">{formatUGX(monthlyContribution)}</p>
                        </div>
                      </div>

                      {/* Progress */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Progress to 5-Year Goal</span>
                          <span className="font-medium">{tenant.months_enrolled}/60 months</span>
                        </div>
                        <Progress value={progressPercent} className="h-2" />
                        <div className="flex justify-between text-xs">
                          <span className="text-purple-600 font-medium">Goal: {formatUGX(projection)}</span>
                          <span className="text-emerald-600">+5% monthly</span>
                        </div>
                      </div>

                      {/* Savings Growth Chart */}
                      {tenant.months_enrolled > 0 && (
                        <div className="mt-3">
                          <SavingsGrowthChart 
                            monthlyRent={tenant.monthly_rent}
                            monthsEnrolled={tenant.months_enrolled}
                            totalSavings={tenant.total_savings}
                          />
                        </div>
                      )}
                    </motion.div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Landlord Leaderboard */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <WelileHomesLandlordLeaderboard limit={10} />
        </motion.div>

        {/* How It Works */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="bg-gradient-to-br from-purple-50 to-amber-50 border-purple-200">
            <CardContent className="p-4">
              <h3 className="font-semibold text-purple-800 mb-2 flex items-center gap-2">
                <Heart className="h-4 w-4" />
                How You're Making a Difference
              </h3>
              <div className="space-y-2 text-sm text-purple-700">
                <p>
                  • When tenants pay rent through Welile Wallet, 10% of your platform fee 
                  goes into their Welile Homes Savings Account.
                </p>
                <p>
                  • These savings grow at 5% compound interest every month.
                </p>
                <p>
                  • Tenants can use their savings for buying land, a home, building, 
                  or mortgage down payments.
                </p>
                <p className="font-medium text-purple-800 mt-3">
                  By receiving rent through Welile, you're helping your tenants build 
                  towards their dream of homeownership!
                </p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}

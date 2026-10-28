import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  ArrowLeft, 
  Percent, 
  TrendingUp, 
  Calendar, 
  Home, 
  Receipt, 
  Sparkles, 
  Loader2,
  ChevronRight,
  ArrowUpRight,
  CheckCircle,
  Clock
} from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import ScreenLoader from '@/components/common/ScreenLoader';

interface MonthlyDiscount {
  month: string;
  year: number;
  totalReceipts: number;
  receiptCount: number;
  discountEarned: number;
  discountUsed: number;
}

interface RentPayment {
  id: string;
  amount: number;
  discount_applied: number;
  landlord_name: string;
  created_at: string;
  description: string;
}

export default function RentDiscountHistory() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [monthlyDiscounts, setMonthlyDiscounts] = useState<MonthlyDiscount[]>([]);
  const [rentPayments, setRentPayments] = useState<RentPayment[]>([]);
  const [totalSavings, setTotalSavings] = useState(0);
  const [totalReceipts, setTotalReceipts] = useState(0);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    } else if (user) {
      fetchData();
    }
  }, [user, authLoading, navigate]);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    // Fetch all verified receipts grouped by month
    const { data: receipts } = await supabase
      .from('user_receipts')
      .select('claimed_amount, verified_at')
      .eq('user_id', user.id)
      .eq('verified', true)
      .not('verified_at', 'is', null)
      .order('verified_at', { ascending: false });

    // platform_transactions table removed - use empty array
    const payments: any[] = [];

    // Also check wallet transactions for rent payments
    const { data: walletPayments } = await supabase
      .from('wallet_transactions')
      .select('id, amount, description, created_at, recipient_id')
      .eq('sender_id', user.id)
      .ilike('description', '%rent%')
      .order('created_at', { ascending: false });

    // Group receipts by month
    const monthlyMap = new Map<string, MonthlyDiscount>();
    
    receipts?.forEach(receipt => {
      if (!receipt.verified_at) return;
      
      const date = new Date(receipt.verified_at);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const monthName = date.toLocaleDateString('en-UG', { month: 'long' });
      
      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, {
          month: monthName,
          year: date.getFullYear(),
          totalReceipts: 0,
          receiptCount: 0,
          discountEarned: 0,
          discountUsed: 0
        });
      }
      
      const entry = monthlyMap.get(monthKey)!;
      entry.totalReceipts += Number(receipt.claimed_amount);
      entry.receiptCount += 1;
      entry.discountEarned = Math.round(entry.totalReceipts * 0.01);
    });

    // Convert to array and sort by date
    const monthlyArray = Array.from(monthlyMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([_, value]) => value);

    // Parse rent payments with discount info
    const parsedPayments: RentPayment[] = [];
    
    payments?.forEach(payment => {
      const discountMatch = payment.description?.match(/Discount: UGX\s*([\d,]+)/);
      const discount = discountMatch ? parseInt(discountMatch[1].replace(/,/g, '')) : 0;
      const landlordMatch = payment.description?.match(/to\s+([^(]+)/);
      
      parsedPayments.push({
        id: payment.id,
        amount: payment.amount,
        discount_applied: discount,
        landlord_name: landlordMatch ? landlordMatch[1].trim() : 'Landlord',
        created_at: payment.created_at,
        description: payment.description || ''
      });
    });

    walletPayments?.forEach(payment => {
      const discountMatch = payment.description?.match(/Discount: UGX\s*([\d,]+)/);
      const discount = discountMatch ? parseInt(discountMatch[1].replace(/,/g, '')) : 0;
      
      parsedPayments.push({
        id: payment.id,
        amount: payment.amount,
        discount_applied: discount,
        landlord_name: 'Landlord',
        created_at: payment.created_at,
        description: payment.description || ''
      });
    });

    // Calculate totals
    const totalDiscountUsed = parsedPayments.reduce((sum, p) => sum + p.discount_applied, 0);
    const totalReceiptAmount = receipts?.reduce((sum, r) => sum + Number(r.claimed_amount), 0) || 0;

    setMonthlyDiscounts(monthlyArray);
    setRentPayments(parsedPayments.sort((a, b) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    ));
    setTotalSavings(totalDiscountUsed);
    setTotalReceipts(totalReceiptAmount);
    setLoading(false);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-UG', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  if (authLoading || loading) {
    return (
      <ScreenLoader />
    );
  }

  const currentMonthDiscount = monthlyDiscounts[0];
  const totalPotentialSavings = Math.round(totalReceipts * 0.01);

  return (
    <div className="min-h-screen bg-background pb-20">
      <header className="sticky top-0 z-50 glass-card border-b border-border/50">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="flex items-center gap-2">
                <Percent className="h-5 w-5 text-success" />
                <h1 className="text-lg font-semibold">Discount History</h1>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Lifetime Summary Cards */}
        <div className="grid grid-cols-2 gap-4">
          <Card className="elevated-card bg-gradient-to-br from-success/10 to-success/5 border-success/20">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-success mb-2">
                <Sparkles className="h-4 w-4" />
                <span className="text-sm font-medium">Total Saved</span>
              </div>
              <p className="text-2xl font-bold text-success">{formatUGX(totalSavings)}</p>
              <p className="text-xs text-muted-foreground mt-1">from rent discounts</p>
            </CardContent>
          </Card>

          <Card className="elevated-card bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
            <CardContent className="pt-6">
              <div className="flex items-center gap-2 text-primary mb-2">
                <Receipt className="h-4 w-4" />
                <span className="text-sm font-medium">Total Shopping</span>
              </div>
              <p className="text-2xl font-bold">{formatUGX(totalReceipts)}</p>
              <p className="text-xs text-muted-foreground mt-1">verified receipts</p>
            </CardContent>
          </Card>
        </div>

        {/* Monthly Summary Card - Enhanced */}
        {currentMonthDiscount && (
          <Card className="elevated-card overflow-hidden border-success/30">
            <CardHeader className="pb-2 bg-gradient-to-r from-success/10 to-transparent">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-success" />
                  Monthly Summary
                </CardTitle>
                <Badge variant="success">
                  {currentMonthDiscount.month} {currentMonthDiscount.year}
                </Badge>
              </div>
              <CardDescription>Your rent discount progress this month</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {/* Main Discount Display */}
              <div className="text-center py-4 bg-gradient-to-br from-success/5 to-transparent rounded-xl">
                <p className="text-sm text-muted-foreground mb-1">Discount Earned</p>
                <p className="text-4xl font-bold text-success">
                  {formatUGX(currentMonthDiscount.discountEarned)}
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  from {formatUGX(currentMonthDiscount.totalReceipts)} shopping
                </p>
              </div>

              {/* Monthly Stats Grid */}
              <div className="grid grid-cols-3 gap-3">
                <div className="text-center p-3 rounded-xl bg-secondary/50">
                  <Receipt className="h-5 w-5 mx-auto mb-1 text-muted-foreground" />
                  <p className="text-lg font-bold">{currentMonthDiscount.receiptCount}</p>
                  <p className="text-xs text-muted-foreground">Receipts</p>
                </div>
                <div className="text-center p-3 rounded-xl bg-secondary/50">
                  <Percent className="h-5 w-5 mx-auto mb-1 text-success" />
                  <p className="text-lg font-bold">1%</p>
                  <p className="text-xs text-muted-foreground">Rate</p>
                </div>
                <div className="text-center p-3 rounded-xl bg-secondary/50">
                  <TrendingUp className="h-5 w-5 mx-auto mb-1 text-primary" />
                  <p className="text-lg font-bold">{formatUGX(currentMonthDiscount.discountUsed)}</p>
                  <p className="text-xs text-muted-foreground">Used</p>
                </div>
              </div>

              {/* Progress Info */}
              <div className="p-3 rounded-xl bg-primary/5 border border-primary/10">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Month Progress</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date().getDate()} of {new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()} days
                  </span>
                </div>
                <Progress value={(new Date().getDate() / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()) * 100} className="h-2" />
                <p className="text-xs text-muted-foreground mt-2">
                  Keep shopping to maximize your discount before month end!
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Previous Months Summary */}
        {monthlyDiscounts.length > 1 && (
          <Card className="elevated-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Previous Months
              </CardTitle>
              <CardDescription>Your historical savings breakdown</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {monthlyDiscounts.slice(1, 4).map((month, index) => (
                <div 
                  key={`summary-${month.year}-${month.month}`}
                  className="flex items-center justify-between p-3 rounded-xl bg-secondary/30 hover:bg-secondary/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-background">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{month.month} {month.year}</p>
                      <p className="text-xs text-muted-foreground">
                        {month.receiptCount} receipts • {formatUGX(month.totalReceipts)} spent
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-success">{formatUGX(month.discountEarned)}</p>
                    <p className="text-xs text-muted-foreground">saved</p>
                  </div>
                </div>
              ))}
              {monthlyDiscounts.length > 4 && (
                <p className="text-xs text-center text-muted-foreground pt-2">
                  + {monthlyDiscounts.length - 4} more months in history
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tabs for History */}
        <Tabs defaultValue="monthly" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="monthly" className="gap-2">
              <Calendar className="h-4 w-4" />
              Monthly
            </TabsTrigger>
            <TabsTrigger value="payments" className="gap-2">
              <Home className="h-4 w-4" />
              Payments
            </TabsTrigger>
          </TabsList>

          <TabsContent value="monthly" className="mt-4 space-y-3">
            {monthlyDiscounts.length === 0 ? (
              <Card className="elevated-card">
                <CardContent className="py-12 text-center">
                  <Receipt className="h-12 w-12 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-muted-foreground">No discount history yet</p>
                  <p className="text-sm text-muted-foreground/70 mt-1">
                    Start submitting receipts to earn discounts
                  </p>
                  <Button 
                    className="mt-4 gap-2" 
                    onClick={() => navigate('/my-receipts')}
                  >
                    <Receipt className="h-4 w-4" />
                    Add Receipt
                  </Button>
                </CardContent>
              </Card>
            ) : (
              monthlyDiscounts.map((month, index) => (
                <Card 
                  key={`${month.year}-${month.month}`} 
                  className={`elevated-card transition-all ${index === 0 ? 'border-success/30' : ''}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-xl ${index === 0 ? 'bg-success/10' : 'bg-secondary'}`}>
                          <Calendar className={`h-5 w-5 ${index === 0 ? 'text-success' : 'text-muted-foreground'}`} />
                        </div>
                        <div>
                          <p className="font-semibold">{month.month} {month.year}</p>
                          <p className="text-sm text-muted-foreground">
                            {month.receiptCount} receipt{month.receiptCount !== 1 ? 's' : ''} • {formatUGX(month.totalReceipts)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-lg font-bold ${index === 0 ? 'text-success' : ''}`}>
                          {formatUGX(month.discountEarned)}
                        </p>
                        <p className="text-xs text-muted-foreground">earned</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="payments" className="mt-4 space-y-3">
            {rentPayments.length === 0 ? (
              <Card className="elevated-card">
                <CardContent className="py-12 text-center">
                  <Home className="h-12 w-12 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-muted-foreground">No rent payments yet</p>
                  <p className="text-sm text-muted-foreground/70 mt-1">
                    Pay your landlord through Welile to use your discounts
                  </p>
                  <Button 
                    className="mt-4 gap-2 bg-success hover:bg-success/90" 
                    onClick={() => navigate('/pay-landlord')}
                  >
                    <Home className="h-4 w-4" />
                    Pay Rent
                  </Button>
                </CardContent>
              </Card>
            ) : (
              rentPayments.map((payment) => (
                <Card key={payment.id} className="elevated-card">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-success/10">
                          <CheckCircle className="h-5 w-5 text-success" />
                        </div>
                        <div>
                          <p className="font-semibold">Rent Payment</p>
                          <p className="text-sm text-muted-foreground">
                            {formatDate(payment.created_at)}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold">{formatUGX(payment.amount)}</p>
                        {payment.discount_applied > 0 && (
                          <Badge variant="success" className="text-xs gap-1 mt-1">
                            <Sparkles className="h-3 w-3" />
                            Saved {formatUGX(payment.discount_applied)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>

        {/* How it works */}
        <Card className="elevated-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              How Rent Discounts Work
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                <Receipt className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">Shop & Submit Receipts</p>
                <p className="text-xs text-muted-foreground">
                  Shop at Welile partner stores and submit your receipt numbers
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-success/10 shrink-0">
                <Percent className="h-4 w-4 text-success" />
              </div>
              <div>
                <p className="font-medium text-sm">Earn 1% Discount</p>
                <p className="text-xs text-muted-foreground">
                  For every UGX 100,000 spent, earn UGX 1,000 in rent discount
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-warning/10 shrink-0">
                <Home className="h-4 w-4 text-warning" />
              </div>
              <div>
                <p className="font-medium text-sm">Pay Rent & Save</p>
                <p className="text-xs text-muted-foreground">
                  Pay your landlord through Welile and get up to 70% off rent
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-3">
          <Button 
            variant="outline" 
            className="gap-2"
            onClick={() => navigate('/my-receipts')}
          >
            <Receipt className="h-4 w-4" />
            Add Receipts
          </Button>
          <Button 
            className="gap-2 bg-success hover:bg-success/90"
            onClick={() => navigate('/pay-landlord')}
          >
            <Home className="h-4 w-4" />
            Pay Rent
          </Button>
        </div>
      </main>
    </div>
  );
}
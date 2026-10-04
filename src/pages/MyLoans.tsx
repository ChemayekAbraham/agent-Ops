import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { ArrowLeft, Wallet, Clock, CheckCircle, AlertCircle, History, Loader2, Banknote, Calendar } from 'lucide-react';
import { motion } from 'framer-motion';
import { LoansSkeleton } from '@/components/skeletons/DashboardSkeletons';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface Loan {
  id: string;
  lender_id: string;
  amount: number;
  interest_rate: number;
  total_repayment: number;
  paid_amount: number;
  due_date: string;
  status: string;
  created_at: string;
  repaid_at: string | null;
  lender?: {
    full_name: string;
  };
  late_fees?: number;
}

interface Repayment {
  id: string;
  loan_id: string;
  amount: number;
  payment_method: string;
  created_at: string;
}

interface LateFee {
  id: string;
  loan_id: string;
  fee_amount: number;
  days_overdue: number;
  applied_at: string;
  paid: boolean;
}

export default function MyLoans() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [loans, setLoans] = useState<Loan[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [lateFees, setLateFees] = useState<LateFee[]>([]);
  const [walletBalance, setWalletBalance] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedLoan, setSelectedLoan] = useState<Loan | null>(null);
  const [repayAmount, setRepayAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    } else if (user) {
      fetchData();
    }
  }, [user, authLoading]);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    // Authoritative wallet RPC — avoids the heavy `wallets` view.
    try {
      const w = await fetchOpsWallet(user.id);
      setWalletBalance(w ? w.withdrawable + w.float + w.advance : 0);
    } catch {
      setWalletBalance(0);
    }
    setLoans([]);
    setRepayments([]);
    setLateFees([]);
    setLoading(false);
  };

  const handleRepay = async () => {
    if (!selectedLoan || !user) return;

    const amount = parseFloat(repayAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    const remaining = selectedLoan.total_repayment - selectedLoan.paid_amount;
    if (amount > remaining) {
      toast.error(`Amount exceeds remaining balance of ${formatUGX(remaining)}`);
      return;
    }

    if (amount > walletBalance) {
      toast.error('Insufficient wallet balance');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase
      .from('user_loan_repayments')
      .insert({
        loan_id: selectedLoan.id,
        borrower_id: user.id,
        amount,
        payment_method: 'wallet'
      });

    if (error) {
      console.error('Repayment error:', error);
      toast.error(error.message || 'Failed to process repayment');
    } else {
      toast.success(`Repayment of ${formatUGX(amount)} processed successfully!`);
      setSelectedLoan(null);
      setRepayAmount('');
      fetchData();
    }
    setSubmitting(false);
  };

  const activeLoans = loans.filter(l => l.status === 'active');
  const repaidLoans = loans.filter(l => l.status === 'repaid');
  const totalOwed = activeLoans.reduce((sum, l) => sum + (l.total_repayment - l.paid_amount), 0);
  const totalLateFees = lateFees.filter(f => !f.paid).reduce((sum, f) => sum + Number(f.fee_amount), 0);

  if (authLoading || loading) {
    return <LoansSkeleton />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">My Loans</h1>
              <p className="text-sm text-muted-foreground">Track and repay your loans</p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => navigate('/payment-schedule')}>
            <Calendar className="h-4 w-4" />
            <span className="hidden sm:inline">Payment Schedule</span>
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-destructive/10">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Total Owed</p>
                  <p className="text-lg font-bold">{formatUGX(totalOwed)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Wallet className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Wallet Balance</p>
                  <p className="text-lg font-bold">{formatUGX(walletBalance)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          {totalLateFees > 0 && (
            <Card className="border-amber-500/50 bg-amber-500/5">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-amber-500/10">
                    <AlertCircle className="h-5 w-5 text-amber-500" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Late Fees</p>
                    <p className="text-lg font-bold text-amber-600">{formatUGX(totalLateFees)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <Tabs defaultValue="active" className="space-y-4">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="active" className="gap-1">
              <Clock className="h-4 w-4" />
              Active ({activeLoans.length})
            </TabsTrigger>
            <TabsTrigger value="repaid" className="gap-1">
              <CheckCircle className="h-4 w-4" />
              Repaid ({repaidLoans.length})
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1">
              <History className="h-4 w-4" />
              History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="space-y-4">
            {activeLoans.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Banknote className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No active loans</p>
                </CardContent>
              </Card>
            ) : (
              activeLoans.map((loan) => {
                const remaining = loan.total_repayment - loan.paid_amount;
                const progress = (loan.paid_amount / loan.total_repayment) * 100;
                const isOverdue = new Date(loan.due_date) < new Date();

                return (
                  <motion.div
                    key={loan.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                  >
                    <Card className={isOverdue ? 'border-destructive' : ''}>
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-lg">
                            {formatUGX(loan.amount)} Loan
                          </CardTitle>
                          {isOverdue ? (
                            <Badge variant="destructive">Overdue</Badge>
                          ) : (
                            <Badge variant="outline">Active</Badge>
                          )}
                        </div>
                        <CardDescription>
                          From: {loan.lender?.full_name || 'Lender'} • {loan.interest_rate}% interest
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="space-y-2">
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Repayment Progress</span>
                            <span className="font-medium">{progress.toFixed(0)}%</span>
                          </div>
                          <Progress value={progress} className="h-2" />
                          <div className="flex justify-between text-sm">
                            <span>Paid: {formatUGX(loan.paid_amount)}</span>
                            <span>Remaining: {formatUGX(remaining)}</span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">Due Date</span>
                          <span className={isOverdue ? 'text-destructive font-medium' : ''}>
                            {new Date(loan.due_date).toLocaleDateString()}
                          </span>
                        </div>

                        {loan.late_fees && loan.late_fees > 0 && (
                          <div className="flex items-center justify-between text-sm p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                            <span className="text-amber-600 font-medium">Late Fees Applied</span>
                            <span className="font-bold text-amber-600">{formatUGX(loan.late_fees)}</span>
                          </div>
                        )}

                        <Button
                          className="w-full"
                          onClick={() => {
                            setSelectedLoan(loan);
                            setRepayAmount('');
                          }}
                        >
                          Make Repayment
                        </Button>
                      </CardContent>
                    </Card>
                  </motion.div>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="repaid" className="space-y-4">
            {repaidLoans.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <CheckCircle className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No repaid loans yet</p>
                </CardContent>
              </Card>
            ) : (
              repaidLoans.map((loan) => (
                <Card key={loan.id} className="bg-green-500/5 border-green-500/20">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">{formatUGX(loan.amount)} Loan</p>
                        <p className="text-sm text-muted-foreground">
                          Repaid on {new Date(loan.repaid_at!).toLocaleDateString()}
                        </p>
                      </div>
                      <Badge variant="success" className="gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Repaid
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Payment History</CardTitle>
                <CardDescription>All your loan repayments</CardDescription>
              </CardHeader>
              <CardContent>
                {repayments.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No repayments made yet
                  </p>
                ) : (
                  <div className="space-y-3">
                    {repayments.map((repayment) => (
                      <div
                        key={repayment.id}
                        className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border"
                      >
                        <div>
                          <p className="font-medium">{formatUGX(repayment.amount)}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(repayment.created_at).toLocaleString()}
                          </p>
                        </div>
                        <Badge variant="outline">{repayment.payment_method}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      {/* Repayment Dialog */}
      <Dialog open={!!selectedLoan} onOpenChange={() => setSelectedLoan(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Make Repayment</DialogTitle>
            <DialogDescription>
              {selectedLoan && (
                <>
                  Remaining: {formatUGX(selectedLoan.total_repayment - selectedLoan.paid_amount)}
                  <br />
                  Wallet Balance: {formatUGX(walletBalance)}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Amount (UGX)</label>
              <Input
                type="number"
                placeholder="Enter amount"
                value={repayAmount}
                onChange={(e) => setRepayAmount(e.target.value)}
              />
            </div>

            {selectedLoan && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRepayAmount(String(Math.min(walletBalance, selectedLoan.total_repayment - selectedLoan.paid_amount)))}
                >
                  Pay Full
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRepayAmount(String(Math.min(walletBalance, (selectedLoan.total_repayment - selectedLoan.paid_amount) / 2)))}
                >
                  Pay Half
                </Button>
              </div>
            )}

            <Button
              className="w-full"
              onClick={handleRepay}
              disabled={submitting || !repayAmount}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Confirm Repayment
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

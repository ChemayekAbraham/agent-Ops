import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  Receipt, CreditCard, CheckCircle, XCircle, ArrowLeft, TrendingUp, 
  Loader2, ShoppingBag, FileText, Plus, Percent, Home, Sparkles, 
  Camera, ChevronDown, ChevronUp, Wallet, ScanLine, Clock, 
  CircleDollarSign, Gift, Zap
} from 'lucide-react';
import { ReceiptStatusTimeline } from '@/components/receipts/ReceiptStatusTimeline';
import { ThemeToggle } from '@/components/ThemeToggle';
import { QRScanner } from '@/components/receipts/QRScanner';
import { useConfetti } from '@/components/Confetti';
import { motion, AnimatePresence } from 'framer-motion';
import { ReceiptsSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { saveViewCache, loadViewCache } from '@/lib/offlineViewCache';
import { useOffline } from '@/contexts/OfflineContext';
import { WifiOff } from 'lucide-react';
import { format } from 'date-fns';

interface UserReceipt {
  id: string;
  receipt_number_id: string;
  items_description: string;
  claimed_amount: number;
  verified: boolean;
  verified_at: string | null;
  rejection_reason: string | null;
  loan_contribution: number | null;
  created_at: string;
  receipt_numbers?: {
    receipt_code: string;
    vendor_marked_at: string | null;
    vendors?: {
      name: string;
    };
  };
}

interface LoanLimit {
  total_verified_amount: number;
  available_limit: number;
  used_limit: number;
}

interface UserLoan {
  id: string;
  amount: number;
  interest_rate: number;
  total_repayment: number;
  status: string;
  due_date: string;
  created_at: string;
  lender?: {
    full_name: string;
  };
}

export default function MyReceipts() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { fireSuccess: fireConfetti } = useConfetti();
  const { isOnline } = useOffline();
  
  const [receipts, setReceipts] = useState<UserReceipt[]>([]);
  const [loanLimit, setLoanLimit] = useState<LoanLimit | null>(null);
  const [loans, setLoans] = useState<UserLoan[]>([]);
  const [loading, setLoading] = useState(true);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedReceipt, setExpandedReceipt] = useState<string | null>(null);
  
  // Rent discount state
  const [monthlyReceipts, setMonthlyReceipts] = useState(0);
  const [rentDiscount, setRentDiscount] = useState(0);
  const [monthlyReceiptCount, setMonthlyReceiptCount] = useState(0);
  
  // Form state
  const [receiptCode, setReceiptCode] = useState('');
  const [itemsDescription, setItemsDescription] = useState('');
  const [claimedAmount, setClaimedAmount] = useState('');

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    } else if (user) {
      fetchData();
    }
  }, [user, authLoading, navigate]);

  // Realtime subscription removed - receipts deprioritized to reduce DB connections

  const fetchData = async () => {
    if (!user) return;

    // Hydrate from cache first for instant paint / offline support.
    const cached = loadViewCache<{
      receipts: UserReceipt[];
      loanLimit: LoanLimit | null;
      loans: UserLoan[];
      monthlyReceipts: number;
      rentDiscount: number;
      monthlyReceiptCount: number;
    }>('my_receipts', user.id);
    if (cached) {
      setReceipts(cached.data.receipts);
      setLoanLimit(cached.data.loanLimit);
      setLoans(cached.data.loans);
      setMonthlyReceipts(cached.data.monthlyReceipts);
      setRentDiscount(cached.data.rentDiscount);
      setMonthlyReceiptCount(cached.data.monthlyReceiptCount);
      setCachedAt(cached.ts);
      setLoading(false);
    } else {
      setLoading(true);
    }

    // Skip network entirely when offline — cache (or empty state) is what we show.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLoading(false);
      return;
    }

    // Get current month boundaries
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    // Stub all non-wallet DB calls - receipts/loans use empty data to reduce DB load
    const receiptsRes = { data: [] as any[], error: null };
    const loanLimitRes = { data: null, error: null };
    const monthlyReceiptsRes = { data: [] as any[], error: null };
    const loansWithLenders: any[] = [];

    // Calculate monthly rent discount (1% of verified receipts)
    const monthlyTotal = monthlyReceiptsRes.data?.reduce((sum, r) => sum + Number(r.claimed_amount), 0) || 0;
    setMonthlyReceipts(monthlyTotal);
    setRentDiscount(Math.round(monthlyTotal * 0.01));
    setMonthlyReceiptCount(monthlyReceiptsRes.data?.length || 0);

    setReceipts(receiptsRes.data || []);
    setLoanLimit(loanLimitRes.data);
    setLoans(loansWithLenders);
    setLoading(false);

    // Persist for offline view-only access.
    saveViewCache('my_receipts', user.id, {
      receipts: receiptsRes.data || [],
      loanLimit: loanLimitRes.data,
      loans: loansWithLenders,
      monthlyReceipts: monthlyTotal,
      rentDiscount: Math.round(monthlyTotal * 0.01),
      monthlyReceiptCount: monthlyReceiptsRes.data?.length || 0,
    });
    setCachedAt(Date.now());
  };

  const handleSubmitReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    setSubmitting(true);

    // Receipts feature deprioritized - DB calls removed
    toast({
      title: 'Feature Unavailable',
      description: 'Receipt submission is temporarily unavailable.',
      variant: 'destructive'
    });
    setSubmitting(false);
    return;
    // eslint-disable-next-line no-unreachable
    const receiptNumber: any = null;
    const findError: any = null;

    if (findError || !receiptNumber) {
      toast({
        title: 'Invalid Receipt',
        description: 'This receipt number does not exist in our system',
        variant: 'destructive'
      });
      setSubmitting(false);
      return;
    }

    if (receiptNumber.status === 'used') {
      toast({
        title: 'Receipt Already Used',
        description: 'This receipt has already been submitted by another user',
        variant: 'destructive'
      });
      setSubmitting(false);
      return;
    }

    // Submit the receipt
    const { error: submitError } = await supabase
      .from('user_receipts')
      .insert({
        user_id: user.id,
        receipt_number_id: receiptNumber.id,
        items_description: itemsDescription.trim(),
        claimed_amount: parseFloat(claimedAmount)
      });

    if (submitError) {
      // Check for unique constraint violation
      if (submitError.code === '23505' || submitError.message.includes('unique') || submitError.message.includes('duplicate')) {
        toast({
          title: 'Receipt Already Submitted',
          description: 'This receipt code has already been claimed. Each receipt can only be used once.',
          variant: 'destructive'
        });
      } else {
        toast({
          title: 'Error',
          description: submitError.message,
          variant: 'destructive'
        });
      }
    } else {
      // Fire confetti celebration!
      fireConfetti();
      
      toast({
        title: '🎉 Receipt Submitted!',
        description: 'Your receipt has been submitted for verification'
      });
      setReceiptCode('');
      setItemsDescription('');
      setClaimedAmount('');
      fetchData();
    }

    setSubmitting(false);
  };

  if (authLoading || (loading && receipts.length === 0 && !cachedAt)) {
    return <ReceiptsSkeleton />;
  }

  const verifiedReceipts = receipts.filter(r => r.verified);
  const pendingReceipts = receipts.filter(r => !r.verified && !r.rejection_reason);
  const rejectedReceipts = receipts.filter(r => !r.verified && r.rejection_reason);
  const activeLoans = loans.filter(l => l.status === 'active');

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-muted/30">
      {/* Modern Header with gradient */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/80 border-b border-border/40">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => navigate(-1)}
                className="rounded-xl hover:bg-muted"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold tracking-tight">My Receipts</h1>
                <p className="text-xs text-muted-foreground">Track your shopping & grow your limit</p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 pb-24 space-y-6">
        {!isOnline && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-warning/10 border border-warning/20 text-xs text-warning">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
              You're offline — showing last saved receipts
              {cachedAt ? ` from ${format(new Date(cachedAt), 'MMM dd, HH:mm')}` : ''}. Submitting a new receipt requires connection.
            </span>
          </div>
        )}
        {/* Stats Overview - Horizontal scroll on mobile */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="p-4 rounded-2xl bg-gradient-to-br from-success/10 via-success/5 to-transparent border border-success/20"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-success/20">
                <Percent className="h-4 w-4 text-success" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Rent Discount</span>
            </div>
            <p className="text-2xl font-bold text-success">{formatUGX(rentDiscount)}</p>
            <p className="text-xs text-muted-foreground mt-1">{monthlyReceiptCount} receipts this month</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="p-4 rounded-2xl bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-primary/20">
                <Wallet className="h-4 w-4 text-primary" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Rent Fee Available</span>
            </div>
            <p className="text-2xl font-bold text-primary">{formatUGX(loanLimit?.available_limit || 0)}</p>
            <p className="text-xs text-muted-foreground mt-1">Available for rent access</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="p-4 rounded-2xl bg-card border border-border/50"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-muted">
                <CheckCircle className="h-4 w-4 text-foreground" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Verified</span>
            </div>
            <p className="text-2xl font-bold">{verifiedReceipts.length}</p>
            <p className="text-xs text-muted-foreground mt-1">{formatUGX(loanLimit?.total_verified_amount || 0)} total</p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
            className="p-4 rounded-2xl bg-card border border-border/50"
          >
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 rounded-lg bg-warning/20">
                <Clock className="h-4 w-4 text-warning" />
              </div>
              <span className="text-xs font-medium text-muted-foreground">Pending</span>
            </div>
            <p className="text-2xl font-bold">{pendingReceipts.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Awaiting verification</p>
          </motion.div>
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="submit" className="space-y-6">
          <TabsList className="grid w-full grid-cols-2 h-12 p-1 bg-muted/50 rounded-2xl">
            <TabsTrigger 
              value="submit" 
              className="rounded-xl data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
            >
              <Plus className="h-4 w-4" />
              Submit Receipt
            </TabsTrigger>
            <TabsTrigger 
              value="history" 
              className="rounded-xl data-[state=active]:bg-background data-[state=active]:shadow-sm gap-2"
            >
              <ShoppingBag className="h-4 w-4" />
              History
              {receipts.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-xs">
                  {receipts.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          {/* Submit Receipt Tab */}
          <TabsContent value="submit" className="space-y-6 mt-0">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="border-2 border-dashed border-primary/30 bg-gradient-to-br from-primary/5 via-transparent to-transparent overflow-hidden">
                <CardHeader className="pb-4">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-primary/10 ring-4 ring-primary/5">
                      <ScanLine className="h-6 w-6 text-primary" />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-xl">Submit Shopping Receipt</CardTitle>
                      <CardDescription className="text-sm mt-1">
                        Enter your Welile receipt code to grow your rent access limit
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  <form onSubmit={handleSubmitReceipt} className="space-y-5">
                    {/* Receipt Code Input */}
                    <div className="space-y-3">
                      <Label htmlFor="receiptCode" className="text-sm font-semibold flex items-center gap-2">
                        <Receipt className="h-4 w-4 text-muted-foreground" />
                        Receipt Code
                      </Label>
                      <div className="relative">
                        <Input
                          id="receiptCode"
                          placeholder="WL-001234"
                          value={receiptCode}
                          onChange={(e) => setReceiptCode(e.target.value.toUpperCase())}
                          required
                          className="font-mono text-lg uppercase h-14 pl-4 pr-14 rounded-xl bg-background border-2 focus:border-primary transition-colors"
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                          <QRScanner 
                            onScan={(code) => setReceiptCode(code.toUpperCase())}
                            buttonVariant="ghost"
                            buttonClassName="h-10 w-10 rounded-lg bg-muted hover:bg-muted/80"
                          />
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground flex items-center gap-2">
                        <Camera className="h-3 w-3" />
                        Tap the camera icon to scan QR code from receipt
                      </p>
                    </div>

                    {/* Items Description */}
                    <div className="space-y-3">
                      <Label htmlFor="items" className="text-sm font-semibold flex items-center gap-2">
                        <ShoppingBag className="h-4 w-4 text-muted-foreground" />
                        Items Purchased
                      </Label>
                      <Textarea
                        id="items"
                        placeholder="e.g., Rice, Sugar, Cooking Oil, Vegetables..."
                        value={itemsDescription}
                        onChange={(e) => setItemsDescription(e.target.value)}
                        required
                        rows={3}
                        className="rounded-xl bg-background border-2 focus:border-primary transition-colors resize-none"
                      />
                    </div>

                    {/* Amount Input */}
                    <div className="space-y-3">
                      <Label htmlFor="amount" className="text-sm font-semibold flex items-center gap-2">
                        <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
                        Total Amount
                      </Label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground font-medium">
                          UGX
                        </span>
                        <Input
                          id="amount"
                          type="number"
                          placeholder="50,000"
                          value={claimedAmount}
                          onChange={(e) => setClaimedAmount(e.target.value)}
                          required
                          min="1000"
                          className="font-mono text-lg h-14 pl-14 rounded-xl bg-background border-2 focus:border-primary transition-colors"
                        />
                      </div>
                    </div>

                    {/* Benefits Preview */}
                    <div className="p-4 rounded-xl bg-muted/30 border border-border/50 space-y-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">What you'll earn</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex items-center gap-2">
                          <div className="p-1.5 rounded-lg bg-success/10">
                            <Percent className="h-3.5 w-3.5 text-success" />
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Rent Discount</p>
                            <p className="text-sm font-semibold text-success">
                              {claimedAmount ? formatUGX(Math.round(parseFloat(claimedAmount) * 0.01)) : 'UGX 0'}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="p-1.5 rounded-lg bg-primary/10">
                            <TrendingUp className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Rent Access</p>
                            <p className="text-sm font-semibold text-primary">
                              +{claimedAmount ? formatUGX(Math.round(parseFloat(claimedAmount) * 0.2)) : 'UGX 0'}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <Button 
                      type="submit" 
                      className="w-full h-14 text-base font-semibold rounded-xl gap-2 bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-lg shadow-primary/20" 
                      disabled={submitting}
                    >
                      {submitting ? (
                        <>
                          <Loader2 className="h-5 w-5 animate-spin" />
                          Submitting...
                        </>
                      ) : (
                        <>
                          <Zap className="h-5 w-5" />
                          Submit Receipt
                        </>
                      )}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </motion.div>

            {/* Quick Tips */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="p-4 rounded-2xl bg-muted/30 border border-border/50"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-primary/10 shrink-0">
                  <Gift className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-sm">How it works</p>
                  <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">1</span>
                      Shop at any Welile partner store
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">2</span>
                      Submit your receipt code here
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">3</span>
                      Earn 1% rent discount + grow rent access
                    </li>
                  </ul>
                </div>
              </div>
            </motion.div>
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history" className="mt-0">
            <div className="min-h-[200px] -mx-4 px-4">
              <div className="space-y-4 pt-2">
                {receipts.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="py-16 text-center"
                  >
                    <div className="w-20 h-20 rounded-3xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                      <Receipt className="h-10 w-10 text-muted-foreground/40" />
                    </div>
                    <p className="text-lg font-medium text-muted-foreground">No receipts yet</p>
                    <p className="text-sm text-muted-foreground/70 mt-1 max-w-xs mx-auto">
                      Submit your first shopping receipt to start earning rewards
                    </p>
                  </motion.div>
                ) : (
                  <div className="space-y-3">
                    <AnimatePresence>
                      {receipts.map((receipt, index) => {
                        const isExpanded = expandedReceipt === receipt.id;
                        return (
                          <motion.div
                            key={receipt.id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            className={`p-4 rounded-2xl border-2 transition-all ${
                              receipt.verified 
                                ? 'bg-success/5 border-success/20 hover:border-success/40' 
                                : receipt.rejection_reason 
                                  ? 'bg-destructive/5 border-destructive/20 hover:border-destructive/40'
                                  : 'bg-card border-border/50 hover:border-border'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-2 flex-wrap">
                                  <code className="text-sm font-mono bg-muted px-2.5 py-1 rounded-lg font-semibold">
                                    {receipt.receipt_numbers?.receipt_code || 'N/A'}
                                  </code>
                                  {receipt.verified ? (
                                    <Badge className="gap-1 bg-success/10 text-success border-success/20 hover:bg-success/20">
                                      <CheckCircle className="h-3 w-3" />
                                      Verified
                                    </Badge>
                                  ) : receipt.rejection_reason ? (
                                    <Badge className="gap-1 bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20">
                                      <XCircle className="h-3 w-3" />
                                      Rejected
                                    </Badge>
                                  ) : (
                                    <Badge className="gap-1 bg-warning/10 text-warning border-warning/20 hover:bg-warning/20">
                                      <Clock className="h-3 w-3" />
                                      Pending
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground">
                                  {receipt.receipt_numbers?.vendors?.name || 'Unknown Vendor'}
                                </p>
                                <p className="text-sm mt-1.5 line-clamp-2 text-foreground/80">{receipt.items_description}</p>
                                {receipt.rejection_reason && (
                                  <p className="text-sm text-destructive mt-2 p-2 rounded-lg bg-destructive/5">
                                    {receipt.rejection_reason}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="text-lg font-bold">{formatUGX(receipt.claimed_amount)}</p>
                                {receipt.loan_contribution && (
                                  <p className="text-xs font-medium text-success mt-0.5">
                                    +{formatUGX(receipt.loan_contribution)} limit
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground mt-1">
                                  {new Date(receipt.created_at).toLocaleDateString('en-GB', {
                                    day: 'numeric',
                                    month: 'short',
                                    year: '2-digit'
                                  })}
                                </p>
                              </div>
                            </div>
                            
                            {/* Timeline Toggle */}
                            <button
                              onClick={() => setExpandedReceipt(isExpanded ? null : receipt.id)}
                              className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors w-full justify-center py-2 rounded-lg hover:bg-muted/50"
                            >
                              {isExpanded ? (
                                <>
                                  <ChevronUp className="h-3.5 w-3.5" />
                                  Hide timeline
                                </>
                              ) : (
                                <>
                                  <ChevronDown className="h-3.5 w-3.5" />
                                  View timeline
                                </>
                              )}
                            </button>
                            
                            {/* Status Timeline */}
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: 'auto' }}
                                  exit={{ opacity: 0, height: 0 }}
                                  transition={{ duration: 0.2 }}
                                >
                                  <ReceiptStatusTimeline
                                    submittedAt={receipt.created_at}
                                    vendorVerifiedAt={receipt.receipt_numbers?.vendor_marked_at || null}
                                    approvedAt={receipt.verified_at}
                                    rejectedReason={receipt.rejection_reason}
                                  />
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Active Loans Section */}
        {activeLoans.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className="border-warning/30 bg-gradient-to-br from-warning/5 to-transparent">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-warning/10">
                    <CreditCard className="h-5 w-5 text-warning" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Active Rent Plans</CardTitle>
                    <CardDescription>Your current outstanding rent facilitations</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {activeLoans.map((loan) => (
                  <div 
                    key={loan.id} 
                    className="p-4 rounded-xl bg-background border border-warning/20 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xl font-bold">{formatUGX(loan.amount)}</span>
                      <Badge className="bg-warning/10 text-warning border-warning/20">
                        Due: {new Date(loan.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </Badge>
                    </div>
                    <div className="flex justify-between text-sm text-muted-foreground">
                      <span>Repay: {formatUGX(loan.total_repayment)}</span>
                      <span>Supported by: {loan.lender?.full_name || 'Unknown'}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Pay Rent CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Button 
            onClick={() => navigate('/pay-landlord')} 
            variant="outline"
            className="w-full h-14 rounded-2xl gap-3 border-2 border-success/30 text-success hover:bg-success/10 hover:border-success/50"
          >
            <Home className="h-5 w-5" />
            <span className="font-semibold">Pay Rent with {formatUGX(rentDiscount)} Discount</span>
            <Sparkles className="h-4 w-4" />
          </Button>
        </motion.div>
      </main>
    </div>
  );
}

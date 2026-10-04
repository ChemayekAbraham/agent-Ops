import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Loader2, Banknote, User, Calendar, CheckCircle2 } from 'lucide-react';
import { hapticTap } from '@/lib/haptics';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

interface CreditRequest {
  id: string;
  amount: number;
  total_repayment: number;
  created_at: string;
  due_date: string;
  status: string;
  agent_verified: boolean;
  borrower_id: string;
  lender_id: string;
  borrower?: { full_name: string; phone: string; city: string } | null;
  lender?: { full_name: string } | null;
}

export function CreditVerificationButton() {
  const { user } = useAuth();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<CreditRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);

  useEffect(() => {
    fetchCount();
  }, [open]);

  const fetchCount = async () => {
    const { count } = await supabase
      .from('user_loans')
      .select('*', { count: 'exact', head: true })
      .eq('agent_verified', false)
      .eq('status', 'active');
    setCount(count || 0);
  };

  const fetchRequests = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('user_loans')
      .select('id, amount, total_repayment, created_at, due_date, status, agent_verified, borrower_id, lender_id')
      .eq('agent_verified', false)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (data) {
      // Fetch profiles for borrowers and lenders
      const borrowerIds = [...new Set(data.map(d => d.borrower_id))];
      const lenderIds = [...new Set(data.map(d => d.lender_id))];
      const allIds = [...new Set([...borrowerIds, ...lenderIds])];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone, city')
        .in('id', allIds);

      const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);

      setRequests(data.map(d => ({
        ...d,
        borrower: profileMap.get(d.borrower_id) as any || null,
        lender: profileMap.get(d.lender_id) as any || null,
      })));
    }
    setLoading(false);
  };

  const handleVerify = async (loanId: string) => {
    if (!user) return;
    setVerifying(loanId);
    
    const { error } = await supabase
      .from('user_loans')
      .update({
        agent_verified: true,
        agent_verified_by: user.id,
        agent_verified_at: new Date().toISOString(),
      })
      .eq('id', loanId);

    if (error) {
      toast.error('Verification failed');
    } else {
      toast.success('Borrower verified! You will earn 5% on repayment collection.');
      fetchCount();
      fetchRequests();
    }
    setVerifying(null);
  };

  const handleOpen = () => {
    hapticTap();
    setOpen(true);
    fetchRequests();
  };

  if (count === 0) return null;

  return (
    <>
      <button
        onClick={handleOpen}
        className="fixed bottom-36 sm:bottom-40 right-4 z-40 flex items-center gap-1.5 px-3 py-2 rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/25 touch-manipulation text-xs transition-transform active:scale-95"
      >
        <Banknote className="h-3.5 w-3.5" />
        <span className="font-bold">Credit Verify</span>
        <Badge variant="outline" className="bg-white/20 border-white/30 text-white text-[10px] px-1 py-0">
          {count}
        </Badge>
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl p-0">
          <SheetHeader className="p-4 pb-2">
            <SheetTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              Credit Verification Requests
            </SheetTitle>
            <p className="text-sm text-muted-foreground">
              Verify borrowers to earn <span className="font-bold text-success">5%</span> on every repayment collected
            </p>
          </SheetHeader>

          <ScrollArea className="flex-1 h-[calc(85vh-100px)] px-4 pb-4">
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <Skeleton key={i} className="h-36 w-full rounded-xl" />)}
              </div>
            ) : requests.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No credit requests to verify right now</p>
            ) : (
              <div className="space-y-3">
                {requests.map(req => (
                  <Card key={req.id} className="border-border/60">
                    <CardContent className="p-4 space-y-3">
                      <div className="flex justify-between items-start">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <User className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-semibold text-sm">{req.borrower?.full_name || 'Unknown'}</p>
                            <p className="text-[10px] text-muted-foreground">{req.borrower?.phone || ''} · {req.borrower?.city || ''}</p>
                          </div>
                        </div>
                        <p className="font-bold text-primary">{formatUGX(req.amount)}</p>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="p-2 rounded-lg bg-muted/50">
                          <p className="text-muted-foreground">Funded by</p>
                          <p className="font-medium">{req.lender?.full_name || 'Unknown'}</p>
                        </div>
                        <div className="p-2 rounded-lg bg-muted/50">
                          <p className="text-muted-foreground">Due date</p>
                          <p className="font-medium flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {new Date(req.due_date).toLocaleDateString()}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                        <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                        <p className="text-[10px] text-emerald-700 dark:text-emerald-400">
                          <strong>Welile AI Insurance</strong> — Capital protected. Verify to earn 5% commission.
                        </p>
                      </div>

                      <Button
                        onClick={() => handleVerify(req.id)}
                        disabled={verifying === req.id}
                        className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                        size="sm"
                      >
                        {verifying === req.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        Verify Borrower
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}

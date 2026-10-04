import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Sparkles, Clock, CheckCircle2, XCircle, ChevronDown } from 'lucide-react';
import { useCurrency } from '@/hooks/useCurrency';

import { formatDistanceToNow } from 'date-fns';

interface CreditRequest {
  id: string;
  amount: number;
  status: string;
  borrower_id: string;
  borrower_name: string;
  borrower_phone: string;
  created_at: string;
  due_date: string;
  total_repayment: number;
  interest_rate: number;
}

interface CreditRequestsFeedProps {
  onFundRequest?: (request: CreditRequest) => void;
  isLocked?: boolean;
  onLockedClick?: () => void;
}

const CACHE_KEY = 'welile_credit_requests';
const CACHE_TTL = 2 * 60 * 1000;

export function CreditRequestsFeed({ onFundRequest, isLocked, onLockedClick }: CreditRequestsFeedProps) {
  const { formatAmount } = useCurrency();
  const [requests, setRequests] = useState<CreditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  const fetchRequests = useCallback(async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL && data?.length >= 0) {
          setRequests(data);
          setLoading(false);
          return;
        }
      }
    } catch {}

    setLoading(true);

    const { data, error } = await supabase
      .from('user_loans')
      .select('id, amount, status, borrower_id, created_at, due_date, total_repayment, interest_rate')
      .in('status', ['pending', 'active', 'approved'])
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error('[CreditRequestsFeed] Error:', error);
      setLoading(false);
      return;
    }

    const borrowerIds = [...new Set((data || []).map(d => d.borrower_id))];
    let profileMap: Record<string, { full_name: string; phone: string }> = {};

    if (borrowerIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', borrowerIds);

      if (profiles) {
        profiles.forEach(p => {
          profileMap[p.id] = { full_name: p.full_name, phone: p.phone };
        });
      }
    }

    const enriched: CreditRequest[] = (data || []).map(r => ({
      id: r.id,
      amount: Number(r.amount),
      status: r.status,
      borrower_id: r.borrower_id,
      borrower_name: profileMap[r.borrower_id]?.full_name || 'Unknown',
      borrower_phone: profileMap[r.borrower_id]?.phone || '',
      created_at: r.created_at,
      due_date: r.due_date,
      total_repayment: Number(r.total_repayment),
      interest_rate: Number(r.interest_rate),
    }));

    setRequests(enriched);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data: enriched, timestamp: Date.now() }));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Calculate total return available
  const totalReturn = requests.reduce((sum, r) => sum + Math.max(0, r.total_repayment - r.amount), 0);
  const totalRequested = requests.reduce((sum, r) => sum + r.amount, 0);

  if (loading) {
    return (
      <div className="h-20 rounded-2xl bg-muted/50 animate-pulse" />
    );
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'approved': return { icon: <CheckCircle2 className="h-4 w-4" />, label: '✅ Approved', cls: 'bg-success/15 text-success border-success/30' };
      case 'rejected': return { icon: <XCircle className="h-4 w-4" />, label: '❌ Rejected', cls: 'bg-destructive/15 text-destructive border-destructive/30' };
      default: return { icon: <Clock className="h-4 w-4" />, label: '⏳ Pending', cls: 'bg-amber-500/15 text-amber-600 border-amber-500/30' };
    }
  };

  return (
    <div className="rounded-2xl border-2 border-border/60 bg-card overflow-hidden">
      {/* Collapsible Header */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex flex-wrap items-center gap-3 p-4 text-left touch-manipulation active:bg-muted/30 transition-colors"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="p-2.5 rounded-xl bg-accent/50">
          <Sparkles className="h-5 w-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-black text-foreground text-sm">Welile AI Credit Requests</h3>
          <p className="text-xs text-muted-foreground font-medium">
            {requests.length} active · {formatAmount(totalRequested)} requested
          </p>
        </div>

        {/* Desktop: inline badge then chevron */}
        <div className="hidden sm:block shrink-0 text-right px-3 py-1.5 rounded-xl bg-success/10 border border-success/20">
          <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">Total Return</p>
          <p className="text-sm font-black text-success">+{formatAmount(totalReturn)}</p>
        </div>

        <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 ml-auto sm:ml-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />

        {/* Mobile: full-width row below */}
        <div className="w-full sm:hidden">
          <div className="flex items-center justify-between px-4 py-2 rounded-xl bg-success/10 border border-success/20">
            <p className="text-[9px] text-muted-foreground font-semibold uppercase tracking-wider">Total Return</p>
            <p className="text-sm font-black text-success">+{formatAmount(totalReturn)}</p>
          </div>
        </div>
      </button>


      {isOpen && (
          <div className="overflow-hidden">
            <div className="px-4 pb-4 space-y-3">
              {requests.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground rounded-xl border-2 border-dashed border-border/60 font-medium">
                  No credit requests at the moment
                </div>
              ) : (
                requests.map((req, i) => {
                  const statusBadge = getStatusBadge(req.status);
                  return (
                    <button
                      key={req.id}
                      onClick={() => {
                        if (isLocked) { onLockedClick?.(); return; }
                        onFundRequest?.(req);
                      }}
                      className="w-full flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-background hover:bg-accent/30 hover:border-primary/30 shadow-sm transition-all text-left touch-manipulation active:scale-[0.97]"
                    >
                      <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-2xl shrink-0">
                        💳
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-foreground truncate">{req.borrower_name}</p>
                        <p className="text-sm font-bold text-foreground mt-0.5">{formatAmount(req.amount)}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className={`text-[10px] font-bold px-1.5 py-0 border ${statusBadge.cls}`}>
                            {statusBadge.label}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground">
                            {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 text-right px-2.5 py-1.5 rounded-lg bg-success/10 border border-success/20">
                        <p className="text-[9px] text-muted-foreground font-semibold">Return</p>
                        <p className="text-sm font-black text-success">
                          +{formatAmount(req.total_repayment - req.amount)}
                        </p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
    </div>
  );
}

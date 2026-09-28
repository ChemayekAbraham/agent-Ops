import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  CheckCircle2, 
  Phone,
  User,
  Loader2,
  Search,
  Receipt,
  Calendar,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { format } from 'date-fns';
import { hapticTap } from '@/lib/haptics';

interface PaidPayout {
  id: string;
  agent_id: string;
  amount: number;
  mobile_money_number: string;
  mobile_money_provider: string;
  transaction_id: string;
  processed_at: string;
  requested_at: string;
  agent_name?: string;
  agent_phone?: string;
}

export function PaidAgentsHistory() {
  const [payouts, setPayouts] = useState<PaidPayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPayout, setSelectedPayout] = useState<PaidPayout | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Loads on mount (historical log). The old Realtime listener was on
    // agent_commission_payouts, which is not in the publication, so it never
    // fired (doc 147).
    fetchPaidPayouts();
  }, []);

  const fetchPaidPayouts = async () => {
    try {
      const { data, error } = await supabase
        .from('agent_commission_payouts')
        .select('*')
        .eq('status', 'approved')
        .order('processed_at', { ascending: false })
        .limit(100);

      if (error) throw error;

      // Fetch agent details
      const payoutsWithAgents = await Promise.all(
        (data || []).map(async (payout) => {
          const { data: profile } = await supabase
            .from('profiles')
            .select('full_name, phone')
            .eq('id', payout.agent_id)
            .single();
          return {
            ...payout,
            agent_name: profile?.full_name,
            agent_phone: profile?.phone
          };
        })
      );

      setPayouts(payoutsWithAgents);
    } catch (error) {
      console.error('Error fetching paid payouts:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter payouts by search query
  const filteredPayouts = payouts.filter(payout => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      payout.agent_name?.toLowerCase().includes(query) ||
      payout.agent_phone?.includes(query) ||
      payout.transaction_id?.toLowerCase().includes(query) ||
      payout.mobile_money_number?.includes(query)
    );
  });

  // Calculate total paid
  const totalPaid = payouts.reduce((sum, p) => sum + p.amount, 0);
  const displayPayouts = expanded ? filteredPayouts : filteredPayouts.slice(0, 5);

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (payouts.length === 0) {
    return null;
  }

  return (
    <>
      <Card className="border-success/30 bg-success/5">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              Paid Agents
              <Badge variant="secondary" className="ml-2">{payouts.length}</Badge>
            </CardTitle>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Total Paid</p>
              <p className="font-bold text-success">{formatUGX(totalPaid)}</p>
            </div>
          </div>
          
          {/* Search */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, phone, or transaction ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-10"
            />
          </div>
        </CardHeader>
        
        <CardContent className="space-y-2">
          {displayPayouts.length === 0 ? (
            <p className="text-center text-muted-foreground py-4 text-sm">
              No matching records found
            </p>
          ) : (
            displayPayouts.map((payout) => (
              <button
                key={payout.id}
                type="button"
                onClick={() => {
                  hapticTap();
                  setSelectedPayout(payout);
                  setDetailsOpen(true);
                }}
                className="w-full p-3 rounded-xl bg-background border border-border/50 hover:border-success/50 transition-all text-left active:scale-[0.99]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-full bg-success/10">
                    <User className="h-4 w-4 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{payout.agent_name || 'Agent'}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className={`font-medium ${payout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`}>
                        {payout.mobile_money_provider}
                      </span>
                      <span>{payout.mobile_money_number}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-success">{formatUGX(payout.amount)}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(payout.processed_at), 'MMM d')}
                    </p>
                  </div>
                </div>
              </button>
            ))
          )}

          {/* Expand/Collapse toggle */}
          {filteredPayouts.length > 5 && (
            <Button
              variant="ghost"
              onClick={() => {
                hapticTap();
                setExpanded(!expanded);
              }}
              className="w-full h-10 text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <>
                  <ChevronUp className="h-4 w-4 mr-2" />
                  Show Less
                </>
              ) : (
                <>
                  <ChevronDown className="h-4 w-4 mr-2" />
                  Show All ({filteredPayouts.length - 5} more)
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Payout Details Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="h-5 w-5 text-success" />
              Payment Details
            </DialogTitle>
          </DialogHeader>

          {selectedPayout && (
            <div className="space-y-4">
              {/* Agent Info */}
              <div className="p-4 rounded-xl bg-muted/50">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-full bg-success/10">
                    <User className="h-5 w-5 text-success" />
                  </div>
                  <div>
                    <p className="font-semibold text-lg">{selectedPayout.agent_name}</p>
                    <p className="text-sm text-muted-foreground">{selectedPayout.agent_phone}</p>
                  </div>
                </div>
              </div>

              {/* Amount */}
              <div className="text-center py-3">
                <p className="text-3xl font-bold text-success">{formatUGX(selectedPayout.amount)}</p>
                <Badge className="mt-2 bg-success/10 text-success border-success/30">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Paid Successfully
                </Badge>
              </div>

              {/* Details */}
              <div className="space-y-3">
                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Phone className="h-4 w-4" />
                    Mobile Money
                  </span>
                  <span className={`font-medium ${selectedPayout.mobile_money_provider === 'MTN' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {selectedPayout.mobile_money_provider} {selectedPayout.mobile_money_number}
                  </span>
                </div>

                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Receipt className="h-4 w-4" />
                    Transaction ID
                  </span>
                  <span className="font-mono font-medium text-sm">{selectedPayout.transaction_id}</span>
                </div>

                <div className="flex justify-between items-center py-2 border-b border-border/50">
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Requested
                  </span>
                  <span className="text-sm">{format(new Date(selectedPayout.requested_at), 'MMM d, yyyy h:mm a')}</span>
                </div>

                <div className="flex justify-between items-center py-2">
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" />
                    Paid
                  </span>
                  <span className="text-sm font-medium text-success">
                    {format(new Date(selectedPayout.processed_at), 'MMM d, yyyy h:mm a')}
                  </span>
                </div>
              </div>

              <Button
                variant="outline"
                onClick={() => setDetailsOpen(false)}
                className="w-full h-12"
              >
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

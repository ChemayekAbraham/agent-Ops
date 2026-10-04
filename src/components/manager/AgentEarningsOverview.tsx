import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import {
  TrendingUp,
  Search,
  User,
  Loader2,
  ChevronDown,
  ChevronUp,
  Percent,
  Gift,
  Award,
  Wallet,
} from 'lucide-react';
import { format } from 'date-fns';
import { hapticTap } from '@/lib/haptics';
import { motion } from 'framer-motion';

interface AgentEarningSummary {
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  total_earnings: number;
  commission_total: number;
  bonus_total: number;
  other_total: number;
  earning_count: number;
  wallet_balance: number;
  total_paid_out: number;
}

interface EarningDetail {
  id: string;
  amount: number;
  earning_type: string;
  description: string | null;
  created_at: string;
  source_user_id: string | null;
  source_name?: string;
}

export function AgentEarningsOverview() {
  const [agents, setAgents] = useState<AgentEarningSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<AgentEarningSummary | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [agentEarnings, setAgentEarnings] = useState<EarningDetail[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetchAgentEarnings();
  }, []);

  const fetchAgentEarnings = async () => {
    try {
      // Get all agent earnings
      const { data: earnings, error } = await supabase
        .from('agent_earnings')
        .select('agent_id, amount, earning_type')
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Group by agent
      const agentMap = new Map<string, {
        total: number;
        commission: number;
        bonus: number;
        other: number;
        count: number;
      }>();

      (earnings || []).forEach(e => {
        const existing = agentMap.get(e.agent_id) || { total: 0, commission: 0, bonus: 0, other: 0, count: 0 };
        const amount = Number(e.amount);
        existing.total += amount;
        existing.count++;
        if (['commission', 'rent_commission', 'investment_commission', 'subagent_commission', 'subagent_override'].includes(e.earning_type)) {
          existing.commission += amount;
        } else if (['approval_bonus', 'verification_bonus', 'rent_funded_bonus', 'facilitation_bonus', 'listing_bonus', 'registration', 'registration_bonus', 'referral_bonus', 'referral'].includes(e.earning_type)) {
          existing.bonus += amount;
        } else {
          existing.other += amount;
        }
        agentMap.set(e.agent_id, existing);
      });

      const agentIds = Array.from(agentMap.keys());
      if (agentIds.length === 0) {
        setAgents([]);
        setLoading(false);
        return;
      }

      // Fetch profiles and wallets in parallel
      const [profilesRes, walletsRes, payoutsRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', agentIds),
        supabase.from('wallets').select('user_id, balance').in('user_id', agentIds),
        supabase.from('agent_commission_payouts').select('agent_id, amount, status')
          .in('agent_id', agentIds)
          .in('status', ['approved']),
      ]);

      const profileMap = new Map((profilesRes.data || []).map(p => [p.id, p]));
      const walletMap = new Map((walletsRes.data || []).map(w => [w.user_id, Number(w.balance)]));
      
      // Sum payouts per agent
      const payoutMap = new Map<string, number>();
      (payoutsRes.data || []).forEach(p => {
        payoutMap.set(p.agent_id, (payoutMap.get(p.agent_id) || 0) + Number(p.amount));
      });

      const result: AgentEarningSummary[] = agentIds.map(id => {
        const stats = agentMap.get(id)!;
        const profile = profileMap.get(id);
        return {
          agent_id: id,
          agent_name: profile?.full_name || 'Unknown Agent',
          agent_phone: profile?.phone || '',
          total_earnings: stats.total,
          commission_total: stats.commission,
          bonus_total: stats.bonus,
          other_total: stats.other,
          earning_count: stats.count,
          wallet_balance: walletMap.get(id) || 0,
          total_paid_out: payoutMap.get(id) || 0,
        };
      });

      // Sort by total earnings desc
      result.sort((a, b) => b.total_earnings - a.total_earnings);
      setAgents(result);
    } catch (error) {
      console.error('Error fetching agent earnings:', error);
    } finally {
      setLoading(false);
    }
  };

  const openAgentDetails = async (agent: AgentEarningSummary) => {
    hapticTap();
    setSelectedAgent(agent);
    setDetailsOpen(true);
    setDetailsLoading(true);

    try {
      const { data, error } = await supabase
        .from('agent_earnings')
        .select('*')
        .eq('agent_id', agent.agent_id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // Fetch source user names
      const sourceIds = [...new Set((data || []).filter(e => e.source_user_id).map(e => e.source_user_id!))];
      let sourceMap = new Map<string, string>();
      if (sourceIds.length > 0) {
        const { data: sources } = await supabase.from('profiles').select('id, full_name').in('id', sourceIds);
        sourceMap = new Map((sources || []).map(s => [s.id, s.full_name]));
      }

      setAgentEarnings((data || []).map(e => ({
        ...e,
        source_name: e.source_user_id ? sourceMap.get(e.source_user_id) : undefined,
      })));
    } catch (error) {
      console.error('Error fetching agent details:', error);
    } finally {
      setDetailsLoading(false);
    }
  };

  const getEarningTypeIcon = (type: string) => {
    switch (type) {
      case 'commission': return <Percent className="h-3.5 w-3.5 text-primary" />;
      case 'approval_bonus': return <Gift className="h-3.5 w-3.5 text-amber-500" />;
      default: return <Award className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const getEarningTypeLabel = (type: string) => {
    switch (type) {
      case 'commission': case 'rent_commission': return 'Rent Commission';
      case 'investment_commission': return 'Investment Commission';
      case 'subagent_commission': case 'subagent_override': return 'Sub-Agent Override';
      case 'registration': case 'registration_bonus': return 'Registration Bonus';
      case 'verification_bonus': return 'Verification Bonus';
      case 'rent_funded_bonus': case 'facilitation_bonus': return 'Facilitation Bonus';
      case 'listing_bonus': return 'Listing Bonus';
      case 'approval_bonus': return 'Approval Bonus';
      case 'referral_bonus': case 'referral': return 'Referral Bonus';
      default: return type.replace(/_/g, ' ');
    }
  };

  // Filter
  const filtered = agents.filter(a => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return a.agent_name.toLowerCase().includes(q) || a.agent_phone.includes(q);
  });

  const totalAllEarnings = agents.reduce((s, a) => s + a.total_earnings, 0);
  const totalCommissions = agents.reduce((s, a) => s + a.commission_total, 0);
  const totalBonuses = agents.reduce((s, a) => s + a.bonus_total, 0);
  const displayAgents = expanded ? filtered : filtered.slice(0, 10);

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Agent Earnings Overview
              <Badge variant="secondary" className="ml-1">{agents.length}</Badge>
            </CardTitle>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-2 mt-3">
            <div className="rounded-xl bg-background border border-border/50 p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground font-medium">Total Earned</p>
              <p className="text-sm font-bold text-primary">{formatUGX(totalAllEarnings)}</p>
            </div>
            <div className="rounded-xl bg-background border border-border/50 p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground font-medium">Commissions</p>
              <p className="text-sm font-bold text-emerald-600">{formatUGX(totalCommissions)}</p>
            </div>
            <div className="rounded-xl bg-background border border-border/50 p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground font-medium">Bonuses</p>
              <p className="text-sm font-bold text-amber-600">{formatUGX(totalBonuses)}</p>
            </div>
          </div>

          {/* Search */}
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agent by name or phone..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-10"
            />
          </div>
        </CardHeader>

        <CardContent className="space-y-2">
          {displayAgents.length === 0 ? (
            <p className="text-center text-muted-foreground py-4 text-sm">
              {agents.length === 0 ? 'No agent earnings recorded yet' : 'No matching agents found'}
            </p>
          ) : (
            displayAgents.map((agent, i) => (
              <motion.button
                key={agent.agent_id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
                type="button"
                onClick={() => openAgentDetails(agent)}
                className="w-full p-3 rounded-xl bg-background border border-border/50 hover:border-primary/40 transition-all text-left active:scale-[0.99]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-full bg-primary/10">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{agent.agent_name}</p>
                    <p className="text-xs text-muted-foreground">{agent.agent_phone}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-bold text-primary">{formatUGX(agent.total_earnings)}</p>
                    <div className="flex items-center gap-1.5 justify-end">
                      <span className="text-[10px] text-emerald-600">{formatUGX(agent.commission_total)}</span>
                      <span className="text-[10px] text-muted-foreground">·</span>
                      <span className="text-[10px] text-amber-600">{formatUGX(agent.bonus_total)}</span>
                    </div>
                  </div>
                </div>
              </motion.button>
            ))
          )}

          {filtered.length > 10 && (
            <Button
              variant="ghost"
              onClick={() => { hapticTap(); setExpanded(!expanded); }}
              className="w-full h-10 text-muted-foreground hover:text-foreground"
            >
              {expanded ? (
                <><ChevronUp className="h-4 w-4 mr-2" /> Show Less</>
              ) : (
                <><ChevronDown className="h-4 w-4 mr-2" /> Show All ({filtered.length - 10} more)</>
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Agent Earnings Detail Dialog */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="sm:max-w-md max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              {selectedAgent?.agent_name}
            </DialogTitle>
          </DialogHeader>

          {selectedAgent && (
            <div className="space-y-4">
              {/* Agent summary */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl bg-muted/50 p-3 text-center">
                  <p className="text-[10px] text-muted-foreground font-medium">Total Earned</p>
                  <p className="text-lg font-bold text-primary">{formatUGX(selectedAgent.total_earnings)}</p>
                </div>
                <div className="rounded-xl bg-muted/50 p-3 text-center">
                  <p className="text-[10px] text-muted-foreground font-medium">Wallet Balance</p>
                  <p className="text-lg font-bold">{formatUGX(selectedAgent.wallet_balance)}</p>
                </div>
              </div>

              {/* Breakdown */}
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <span className="text-sm flex items-center gap-2">
                    <Percent className="h-4 w-4 text-emerald-600" />
                    Commissions (5% on repayments)
                  </span>
                  <span className="font-bold text-emerald-600">{formatUGX(selectedAgent.commission_total)}</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <span className="text-sm flex items-center gap-2">
                    <Gift className="h-4 w-4 text-amber-600" />
                    Bonuses (verification/approval)
                  </span>
                  <span className="font-bold text-amber-600">{formatUGX(selectedAgent.bonus_total)}</span>
                </div>
                {selectedAgent.other_total > 0 && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted/50 border border-border/50">
                    <span className="text-sm flex items-center gap-2">
                      <Award className="h-4 w-4 text-muted-foreground" />
                      Other Earnings
                    </span>
                    <span className="font-bold">{formatUGX(selectedAgent.other_total)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-destructive/10 border border-destructive/20">
                  <span className="text-sm flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-destructive" />
                    Total Paid Out
                  </span>
                  <span className="font-bold text-destructive">{formatUGX(selectedAgent.total_paid_out)}</span>
                </div>
              </div>

              {/* Transaction list */}
              <div>
                <p className="text-sm font-semibold mb-2">Recent Transactions ({agentEarnings.length})</p>
                {detailsLoading ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <ScrollArea className="h-[200px]">
                    <div className="space-y-1.5 pr-3">
                      {agentEarnings.map(e => (
                        <div key={e.id} className="flex items-center gap-2 p-2 rounded-lg bg-muted/30 text-sm">
                          {getEarningTypeIcon(e.earning_type)}
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate text-xs">{getEarningTypeLabel(e.earning_type)}</p>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {e.source_name ? `From: ${e.source_name}` : e.description || '—'}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-xs text-primary">+{formatUGX(e.amount)}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {format(new Date(e.created_at), 'MMM d')}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>

              <Button variant="outline" onClick={() => setDetailsOpen(false)} className="w-full h-11">
                Close
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

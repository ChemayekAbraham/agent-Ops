import { useState, useEffect } from 'react';
import { useShortLink } from '@/hooks/useShortLink';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  Trophy, 
  Users, 
  Coins, 
  Gift, 
  Bike, 
  Wallet, 
  TrendingUp, 
  UserPlus, 
  CheckCircle2, 
  ChevronRight,
  Crown,
  Star,
  Target,
  Banknote,
  ArrowUpCircle,
  Zap,
  Share2
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { fetchAgentLedgerEarnings, type AgentLedgerEarning } from '@/lib/agentLedgerEarnings';
import { formatUGX } from '@/lib/rentCalculations';
import { motion } from 'framer-motion';

interface EarningsRankSystemSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AgentStats {
  tenantsRegistered: number;
  activeRepayingTenants: number;
  subAgentCount: number;
  directRecruits: number;
  totalEarnings: number;
  rank: 'field_agent' | 'team_leader' | 'regional_leader';
  canRecruitSubAgents: boolean;
  advanceEligible: boolean;
}

const rankConfig = {
  field_agent: {
    label: 'Field Agent',
    icon: Users,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
  },
  team_leader: {
    label: 'Team Leader',
    icon: Star,
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
  },
  regional_leader: {
    label: 'Regional Leader',
    icon: Crown,
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/20',
  },
};

export function EarningsRankSystemSheet({ open, onOpenChange }: EarningsRankSystemSheetProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<AgentStats>({
    tenantsRegistered: 0,
    activeRepayingTenants: 0,
    subAgentCount: 0,
    directRecruits: 0,
    totalEarnings: 0,
    rank: 'field_agent',
    canRecruitSubAgents: false,
    advanceEligible: false,
  });
  const [loading, setLoading] = useState(true);

  const { shortUrl: shareLink } = useShortLink({
    targetPath: '/auth',
    targetParams: { role: 'agent', ref: user?.id || '' },
    enabled: open && !!user,
  });

  const handleShare = async () => {
    const shareMessage = `🚀 Join Welile as an Agent and start earning!

💰 Earn UGX 500 per registration
✅ UGX 5,000 per approved rent request
📈 Up to 10% commission on every repayment
🎁 Recruit 2 agents → Unlock advances (300k-30M)
🏍️ Get 50 repaying tenants → Win Electric Bike!

Start your journey: ${shareLink}`;

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Become a Welile Agent',
          text: shareMessage,
          url: shareLink,
        });
        return;
      } catch {
        // Fall through to WhatsApp
      }
    }

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    window.open(whatsappUrl, '_blank');
    
    toast({
      title: '📤 Share Link Ready!',
      description: 'Invite friends to become Welile Agents',
    });
  };

  useEffect(() => {
    if (!user || !open) return;

    const fetchStats = async () => {
      setLoading(true);
      
      // Earnings come from the ledger — agent_earnings stopped being written in
      // July, so this total showed zero. Referrals/subagents remain stubbed.
      const earnings: AgentLedgerEarning[] = await fetchAgentLedgerEarnings(user.id).catch(err => {
        console.error('[EarningsRankSystemSheet] ledger earnings failed:', err);
        return [];
      });

      const tenantsCount = 0; // Stubbed - referrals query removed
      const subAgentCount = 0; // Stubbed - agent_subagents query removed
      const totalEarnings = earnings.reduce((sum, e) => sum + e.amount, 0);
      const activeRepayingTenants = 0; // Stubbed - complex join removed

      // Determine rank based on sub-agents
      let rank: AgentStats['rank'] = 'field_agent';
      if (subAgentCount >= 10) {
        rank = 'regional_leader';
      } else if (subAgentCount >= 2) {
        rank = 'team_leader';
      }

      // Check if can recruit sub-agents (verified 10 agents OR is already team leader)
      const canRecruitSubAgents = tenantsCount >= 10 || subAgentCount >= 2;
      
      // Advance eligibility (2+ direct recruits)
      const advanceEligible = subAgentCount >= 2;

      setStats({
        tenantsRegistered: tenantsCount,
        activeRepayingTenants,
        subAgentCount,
        directRecruits: subAgentCount,
        totalEarnings,
        rank,
        canRecruitSubAgents,
        advanceEligible,
      });
      
      setLoading(false);
    };

    fetchStats();
  }, [user, open]);

  const RankConfig = rankConfig[stats.rank];
  const bikeProgress = Math.min((stats.activeRepayingTenants / 50) * 100, 100);
  const teamLeaderProgress = Math.min((stats.subAgentCount / 2) * 100, 100);
  const regionalLeaderProgress = Math.min((stats.subAgentCount / 10) * 100, 100);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[95vh] rounded-t-3xl p-0">
        <ScrollArea className="h-full">
          <div className="p-6 space-y-6">
            {/* Header */}
            <SheetHeader className="text-left">
              <div className="flex items-center justify-between">
                <SheetTitle className="flex items-center gap-3 text-2xl">
                  <div className="p-2 rounded-xl bg-primary/10">
                    <Trophy className="h-6 w-6 text-primary" />
                  </div>
                  Earnings & Rank System
                </SheetTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleShare}
                  className="gap-2 bg-success/10 border-success/30 text-success hover:bg-success/20"
                >
                  <Share2 className="h-4 w-4" />
                  Share
                </Button>
              </div>
              <p className="text-muted-foreground text-sm">
                See how you earn and level up as a Welile Agent
              </p>
            </SheetHeader>

            {/* Current Rank Card */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className={`border-2 ${RankConfig.borderColor} ${RankConfig.bgColor}`}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-xl ${RankConfig.bgColor}`}>
                      <RankConfig.icon className={`h-8 w-8 ${RankConfig.color}`} />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-muted-foreground">Your Current Rank</p>
                      <h2 className={`text-xl font-bold ${RankConfig.color}`}>{RankConfig.label}</h2>
                    </div>
                    <Badge variant="outline" className={RankConfig.color}>
                      {stats.subAgentCount} Sub-Agents
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* SECTION 1: How Agents Earn */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Coins className="h-5 w-5 text-success" />
                    How You Earn
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <UserPlus className="h-4 w-4 text-primary" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">User Registration</p>
                        <p className="text-xs text-muted-foreground">Per new user registered</p>
                      </div>
                    </div>
                    <Badge className="bg-success/10 text-success hover:bg-success/20">
                      UGX 500
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-amber-500/10">
                        <CheckCircle2 className="h-4 w-4 text-amber-500" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">Rent Request Approved</p>
                        <p className="text-xs text-muted-foreground">When manager approves</p>
                      </div>
                    </div>
                    <Badge className="bg-success/10 text-success hover:bg-success/20">
                      UGX 5,000
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-xl bg-muted/50">
                    <div className="flex items-center gap-3">
                      <div className="p-2 rounded-lg bg-success/10">
                        <TrendingUp className="h-4 w-4 text-success" />
                      </div>
                      <div>
                        <p className="font-medium text-sm">Tenant Rent Repayment</p>
                        <p className="text-xs text-muted-foreground">From each repayment</p>
                      </div>
                    </div>
                    <Badge className="bg-success/10 text-success hover:bg-success/20">
                      Up to 5%
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* SECTION 2: Commission Breakdown */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-5 w-5 text-amber-500" />
                    Commission Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="p-4 rounded-xl bg-gradient-to-br from-success/10 to-success/5 border border-success/20">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="h-4 w-4 text-success" />
                      <p className="font-semibold text-success">If you have NO upline</p>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      You earn the full <span className="font-bold text-success">10%</span> of every tenant repayment.
                    </p>
                  </div>

                  <div className="p-4 rounded-xl bg-gradient-to-br from-amber-500/10 to-amber-500/5 border border-amber-500/20">
                    <div className="flex items-center gap-2 mb-3">
                      <Crown className="h-4 w-4 text-amber-500" />
                      <p className="font-semibold text-amber-600 dark:text-amber-400">If you have an upline (Sub-Agent)</p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-sm">You (Sub-Agent) earn</span>
                        <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">8%</Badge>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm">Your Upline earns</span>
                        <Badge className="bg-primary/10 text-primary">2%</Badge>
                      </div>
                      <Separator className="my-2" />
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium">Total System Payout</span>
                        <Badge variant="outline">10% (Fixed)</Badge>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-muted/50 border">
                    <div className="flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-primary" />
                      <p className="text-sm font-medium">Automatic Wallet Payout</p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      All commissions are calculated and paid instantly to your Welile Wallet after each tenant repayment.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* SECTION 3: Level Up System */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <ArrowUpCircle className="h-5 w-5 text-primary" />
                    Level Up Progress
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Team Leader Progress */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Star className="h-4 w-4 text-amber-500" />
                        <span className="font-medium text-sm">Team Leader</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {stats.subAgentCount}/2 Sub-Agents
                      </span>
                    </div>
                    <Progress value={teamLeaderProgress} variant="warning" size="sm" />
                    {stats.subAgentCount >= 2 ? (
                      <div className="flex items-center gap-2 text-xs text-success">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>Unlocked! You can now access advances (UGX 300k–30M)</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Recruit {2 - stats.subAgentCount} more sub-agents to unlock cash advances
                      </p>
                    )}
                  </div>

                  {/* Regional Leader Progress */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Crown className="h-4 w-4 text-purple-500" />
                        <span className="font-medium text-sm">Regional Leader</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {stats.subAgentCount}/10 Sub-Agents
                      </span>
                    </div>
                    <Progress value={regionalLeaderProgress} className="[&>div]:bg-purple-500" size="sm" />
                    {stats.subAgentCount >= 10 ? (
                      <div className="flex items-center gap-2 text-xs text-purple-500">
                        <CheckCircle2 className="h-3 w-3" />
                        <span>You're a Regional Leader! Lead your area team</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Train {10 - stats.subAgentCount} more sub-agents to become Regional Leader
                      </p>
                    )}
                  </div>

                  {/* Electric Bike Progress */}
                  <Separator />
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Bike className="h-4 w-4 text-success" />
                        <span className="font-medium text-sm">Electric Bike Reward</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {stats.activeRepayingTenants}/50 Repaying Tenants
                      </span>
                    </div>
                    <Progress value={bikeProgress} variant="success" size="lg" />
                    {stats.activeRepayingTenants >= 50 ? (
                      <div className="flex items-center gap-2 text-sm text-success font-medium">
                        <Gift className="h-4 w-4" />
                        <span>🎉 Congratulations! You've earned an Electric Bike!</span>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Get {50 - stats.activeRepayingTenants} more tenants repaying to earn your Electric Bike!
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* SECTION 4: Team Structure */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.5 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="h-5 w-5 text-primary" />
                    Your Team Structure
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col items-center py-4">
                    {/* You */}
                    <div className={`p-3 rounded-xl ${RankConfig.bgColor} ${RankConfig.borderColor} border-2 mb-2`}>
                      <div className="flex items-center gap-2">
                        <RankConfig.icon className={`h-5 w-5 ${RankConfig.color}`} />
                        <span className="font-bold">YOU</span>
                      </div>
                    </div>
                    
                    {/* Connection line */}
                    <div className="w-0.5 h-4 bg-border" />
                    
                    {/* Sub-Agents */}
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-muted/50 border">
                      <Users className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{stats.subAgentCount} Sub-Agents</span>
                    </div>
                    
                    {/* Connection line */}
                    <div className="w-0.5 h-4 bg-border" />
                    
                    {/* Tenants */}
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-success/10 border border-success/20">
                      <TrendingUp className="h-4 w-4 text-success" />
                      <span className="font-medium text-success">{stats.tenantsRegistered} Tenants</span>
                    </div>
                  </div>

                  {/* Stats Summary */}
                  <div className="grid grid-cols-2 gap-2 mt-4">
                    <div className="p-3 rounded-lg bg-muted/50 text-center">
                      <p className="font-bold text-lg">{formatUGX(stats.totalEarnings)}</p>
                      <p className="text-xs text-muted-foreground">Total Earnings</p>
                    </div>
                    <div className="p-3 rounded-lg bg-muted/50 text-center">
                      <p className="font-bold text-lg">{stats.activeRepayingTenants}</p>
                      <p className="text-xs text-muted-foreground">Repaying Tenants</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* SECTION 5: Unlock Abilities */}
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
            >
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Target className="h-5 w-5 text-primary" />
                    Unlock Special Abilities
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Advance Eligibility */}
                  <div className={`p-3 rounded-xl border ${stats.advanceEligible ? 'bg-success/10 border-success/20' : 'bg-muted/50 border-border'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Banknote className={`h-5 w-5 ${stats.advanceEligible ? 'text-success' : 'text-muted-foreground'}`} />
                        <div>
                          <p className="font-medium text-sm">Cash Advances</p>
                          <p className="text-xs text-muted-foreground">UGX 300,000 – 30,000,000</p>
                        </div>
                      </div>
                      {stats.advanceEligible ? (
                        <Badge className="bg-success text-white">Unlocked</Badge>
                      ) : (
                        <Badge variant="outline">2 Sub-Agents</Badge>
                      )}
                    </div>
                  </div>

                  {/* Sub-Agent Recruitment Ability */}
                  <div className={`p-3 rounded-xl border ${stats.canRecruitSubAgents ? 'bg-success/10 border-success/20' : 'bg-muted/50 border-border'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <UserPlus className={`h-5 w-5 ${stats.canRecruitSubAgents ? 'text-success' : 'text-muted-foreground'}`} />
                        <div>
                          <p className="font-medium text-sm">Recruit Sub-Agents</p>
                          <p className="text-xs text-muted-foreground">Build your team</p>
                        </div>
                      </div>
                      {stats.canRecruitSubAgents ? (
                        <Badge className="bg-success text-white">Unlocked</Badge>
                      ) : (
                        <Badge variant="outline">10 Tenants</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Close Button */}
            <Button 
              onClick={() => onOpenChange(false)} 
              className="w-full h-12"
              variant="outline"
            >
              Close
            </Button>

            {/* Bottom padding for safe area */}
            <div className="h-6" />
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

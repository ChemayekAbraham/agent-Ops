import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { AgentProxyWithdrawalDialog } from './AgentProxyWithdrawalDialog';
import { ProxyPartnerDepositDialog } from './ProxyPartnerDepositDialog';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { useFunderAccountsRealtime } from '@/hooks/useFunderAccountsRealtime';
import {
  ArrowLeft, Phone, MessageSquare, Banknote, ArrowDownToLine,
  Wallet, Home, TrendingUp, Calendar, CircleDot, Loader2, Send,
  User, Clock, ShieldCheck, History, CreditCard,
} from 'lucide-react';

interface FunderDetailViewProps {
  funder: {
    id: string;
    beneficiary_id: string;
    approval_status: string;
    created_at: string;
    beneficiary: { id: string; full_name: string; phone: string } | null;
  };
  stats: { totalInvested: number; totalROI: number; activeCount: number; walletBalance: number } | null;
  onBack: () => void;
  onSendStatement: () => void;
  sendingSMS: boolean;
  onRefresh: () => void;
}

interface FunderPortfolio {
  id: string;
  account_name: string | null;
  portfolio_code: string;
  investment_amount: number;
  total_roi_earned: number;
  roi_percentage: number;
  status: string;
  duration_months: number;
  maturity_date: string | null;
  next_roi_date: string | null;
  created_at: string;
}

interface ROIPayment {
  id: string;
  roi_amount: number;
  status: string;
  due_date: string | null;
  paid_at: string | null;
  payment_number: number;
}

interface WithdrawalRecord {
  id: string;
  amount: number;
  status: string;
  payout_method: string | null;
  created_at: string;
}

interface ProfileDetails {
  full_name: string;
  phone: string;
  email: string | null;
  intended_role: string | null;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  created_at: string;
}

export function FunderDetailView({
  funder, stats, onBack, onSendStatement, sendingSMS, onRefresh,
}: FunderDetailViewProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const beneficiaryId = funder.beneficiary?.id;

  const [portfolios, setPortfolios] = useState<FunderPortfolio[]>([]);
  const [roiPayments, setROIPayments] = useState<ROIPayment[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [profile, setProfile] = useState<ProfileDetails | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [isManaged, setIsManaged] = useState(false);
  const [togglingManaged, setTogglingManaged] = useState(false);

  const [withdrawDialogOpen, setWithdrawDialogOpen] = useState(false);
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);

  const [activeTab, setActiveTab] = useState<'overview' | 'portfolios' | 'history'>('overview');

  useEffect(() => {
    if (!beneficiaryId) return;
    fetchAllData();
  }, [beneficiaryId]);

  useFunderAccountsRealtime({
    agentId: user?.id,
    beneficiaryId,
    onChange: () => {
      fetchAllData();
      onRefresh();
    },
    enabled: !!beneficiaryId && !!user,
  });

  const fetchAllData = async () => {
    if (!beneficiaryId || !user) return;
    setLoadingData(true);
    try {
      const [profileRes, portfolioRes, roiRes, withdrawalRes, proxyRes] = await Promise.all([
        supabase.from('profiles')
          .select('full_name, phone, email, intended_role, mobile_money_number, mobile_money_provider, created_at')
          .eq('id', beneficiaryId).single(),
        supabase.from('investor_portfolios')
          .select('id, account_name, portfolio_code, investment_amount, total_roi_earned, roi_percentage, status, duration_months, maturity_date, next_roi_date, created_at')
          .eq('investor_id', beneficiaryId)
          .order('created_at', { ascending: false }),
        supabase.from('supporter_roi_payments')
          .select('id, roi_amount, status, due_date, paid_at, payment_number')
          .eq('supporter_id', beneficiaryId)
          .order('due_date', { ascending: false })
          .limit(20),
        supabase.from('withdrawal_requests')
          .select('id, amount, status, payout_method, created_at')
          .eq('proxy_partner_id', beneficiaryId)
          .order('created_at', { ascending: false })
          .limit(20),
        supabase.from('proxy_agent_assignments')
          .select('is_managed_account')
          .eq('agent_id', user.id)
          .eq('beneficiary_id', beneficiaryId)
          .eq('is_active', true)
          .maybeSingle(),
      ]);

      setProfile(profileRes.data as any);
      setPortfolios(portfolioRes.data || []);
      setROIPayments((roiRes.data as any) || []);
      setWithdrawals((withdrawalRes.data as any) || []);
      setIsManaged(proxyRes.data?.is_managed_account || false);
    } catch (err) {
      console.error('Error fetching funder details:', err);
    } finally {
      setLoadingData(false);
    }
  };

  const handleToggleManaged = async (checked: boolean) => {
    if (!user || !beneficiaryId) return;
    setTogglingManaged(true);
    try {
      const { error } = await supabase
        .from('proxy_agent_assignments')
        .update({ is_managed_account: checked })
        .eq('agent_id', user.id)
        .eq('beneficiary_id', beneficiaryId)
        .eq('is_active', true);
      if (error) throw error;
      setIsManaged(checked);

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: checked ? 'mark_managed_account' : 'unmark_managed_account',
        table_name: 'proxy_agent_assignments',
        record_id: beneficiaryId,
        metadata: { funder_name: funder.beneficiary?.full_name, managed: checked },
      } as any);

      toast({
        title: checked ? '🔒 Full management enabled' : '🔓 Self-service restored',
        description: checked
          ? `You now manage all operations for ${funder.beneficiary?.full_name}`
          : `${funder.beneficiary?.full_name} can manage their own account`,
      });
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setTogglingManaged(false);
    }
  };

  const isApproved = funder.approval_status === 'approved';

  const tabs = [
    { key: 'overview' as const, label: 'Overview', icon: User },
    { key: 'portfolios' as const, label: `Accounts (${portfolios.length})`, icon: Home },
    { key: 'history' as const, label: 'History', icon: History },
  ];

  if (loadingData) {
    return (
      <div className="p-4 space-y-3">
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs -ml-2" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> All Funders
        </Button>
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
      </div>
    );
  }

  return (
    <>
      <div className="p-4 space-y-3">
        {/* Back button */}
        <Button variant="ghost" size="sm" className="gap-1.5 text-xs -ml-2" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" /> All Funders
        </Button>

        {/* Profile Header */}
        <Card className="border-2 border-primary/20 bg-gradient-to-br from-primary/5 to-primary/10">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-bold text-base">{funder.beneficiary?.full_name}</h3>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Phone className="h-3 w-3" />
                  {funder.beneficiary?.phone}
                </div>
                {profile?.email && (
                  <p className="text-[10px] text-muted-foreground mt-0.5">{profile.email}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                {!isApproved ? (
                  <Badge className="text-[10px] bg-warning/15 text-warning border-0">⏳ Pending</Badge>
                ) : isManaged ? (
                  <Badge className="text-[10px] bg-primary/15 text-primary border-0">🔒 Managed</Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">💼 Funder</Badge>
                )}
              </div>
            </div>

            {/* Quick stats */}
            {stats && (
              <div className="grid grid-cols-4 gap-1.5">
                <div className="rounded-lg bg-background/80 p-2 text-center">
                  <p className="text-[9px] text-muted-foreground">Funded</p>
                  <p className="text-xs font-bold truncate">{formatUGX(stats.totalInvested)}</p>
                </div>
                <div className="rounded-lg bg-background/80 p-2 text-center">
                  <p className="text-[9px] text-muted-foreground">Returns</p>
                  <p className="text-xs font-bold text-success truncate">{formatUGX(stats.totalROI)}</p>
                </div>
                <div className="rounded-lg bg-background/80 p-2 text-center">
                  <p className="text-[9px] text-muted-foreground">Wallet</p>
                  <p className="text-xs font-bold truncate">{formatUGX(stats.walletBalance)}</p>
                </div>
                <div className="rounded-lg bg-background/80 p-2 text-center">
                  <p className="text-[9px] text-muted-foreground">Accounts</p>
                  <p className="text-xs font-bold text-primary">{stats.activeCount}</p>
                </div>
              </div>
            )}

            {/* Managed toggle */}
            {isApproved && (
              <div className="flex items-center justify-between rounded-lg bg-background/60 p-2.5">
                <div>
                  <p className="text-xs font-medium">No-Smartphone (Full Management)</p>
                  <p className="text-[10px] text-muted-foreground">
                    You handle all operations on their behalf
                  </p>
                </div>
                <Switch
                  checked={isManaged}
                  onCheckedChange={handleToggleManaged}
                  disabled={togglingManaged}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action buttons */}
        <div className="grid grid-cols-4 gap-1.5">
          <Button
            variant="outline"
            className="h-auto py-2.5 flex-col gap-1 text-[10px]"
            onClick={onSendStatement}
            disabled={sendingSMS}
          >
            {sendingSMS ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 text-primary" />}
            SMS
          </Button>
          <Button
            variant="outline"
            className="h-auto py-2.5 flex-col gap-1 text-[10px]"
            onClick={() => setDepositDialogOpen(true)}
          >
            <Banknote className="h-4 w-4 text-success" />
            Deposit
          </Button>
          <Button
            variant="outline"
            className="h-auto py-2.5 flex-col gap-1 text-[10px]"
            onClick={() => setWithdrawDialogOpen(true)}
            disabled={!isApproved}
          >
            <ArrowDownToLine className="h-4 w-4 text-destructive" />
            Withdraw
          </Button>
          <Button
            variant="outline"
            className="h-auto py-2.5 flex-col gap-1 text-[10px]"
            onClick={() => {
              if (funder.beneficiary?.phone) window.location.href = `tel:${funder.beneficiary.phone}`;
            }}
          >
            <Phone className="h-4 w-4 text-warning" />
            Call
          </Button>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 bg-muted/50 rounded-lg p-1">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1 py-2 px-2 rounded-md text-[10px] font-medium transition-all ${
                activeTab === t.key
                  ? 'bg-background shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon className="h-3 w-3" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === 'overview' && (
          <div className="space-y-3">
            {/* Profile details */}
            <Card>
              <CardContent className="p-3 space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5 text-primary" />
                  Profile Details
                </h4>
                <div className="space-y-1.5">
                  <DetailRow label="Full Name" value={profile?.full_name || '—'} />
                  <DetailRow label="Phone" value={profile?.phone || '—'} />
                  <DetailRow label="Email" value={profile?.email || 'Not set'} />
                  <DetailRow label="MoMo Number" value={profile?.mobile_money_number || 'Not set'} />
                  <DetailRow label="MoMo Provider" value={profile?.mobile_money_provider?.toUpperCase() || 'Not set'} />
                  <DetailRow label="Role" value={profile?.intended_role || 'supporter'} />
                  <DetailRow
                    label="Joined"
                    value={profile?.created_at ? format(new Date(profile.created_at), 'dd MMM yyyy') : '—'}
                  />
                  <DetailRow
                    label="Linked Since"
                    value={format(new Date(funder.created_at), 'dd MMM yyyy')}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Wallet summary */}
            <Card>
              <CardContent className="p-3 space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <Wallet className="h-3.5 w-3.5 text-primary" />
                  Wallet
                </h4>
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">Available Balance</p>
                  <p className="text-lg font-bold">{formatUGX(stats?.walletBalance || 0)}</p>
                </div>
              </CardContent>
            </Card>

            {/* Recent ROI */}
            <Card>
              <CardContent className="p-3 space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-success" />
                  Recent ROI Payments ({roiPayments.length})
                </h4>
                {roiPayments.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-2">No ROI payments yet</p>
                ) : (
                  <div className="space-y-1">
                    {roiPayments.slice(0, 5).map(r => (
                      <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/40 last:border-0">
                        <div>
                          <p className="font-medium">Payment #{r.payment_number}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {r.paid_at ? format(new Date(r.paid_at), 'dd MMM yyyy') : r.due_date ? `Due: ${format(new Date(r.due_date), 'dd MMM')}` : '—'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-success">{formatUGX(r.roi_amount)}</p>
                          <Badge className={`text-[9px] border-0 ${r.status === 'paid' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeTab === 'portfolios' && (
          <div className="space-y-2">
            {portfolios.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center">
                  <CircleDot className="h-6 w-6 mx-auto text-muted-foreground/40 mb-2" />
                  <p className="text-xs text-muted-foreground">No portfolios yet</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Fund on their behalf to create one</p>
                </CardContent>
              </Card>
            ) : (
              portfolios.map(p => {
                const statusColor = p.status === 'active' ? 'bg-success/15 text-success' :
                  p.status === 'matured' ? 'bg-primary/15 text-primary' :
                  p.status === 'pending_approval' ? 'bg-warning/15 text-warning' :
                  'bg-muted text-muted-foreground';
                return (
                  <Card key={p.id} className="border border-border/60">
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">
                            {p.account_name || p.portfolio_code}
                          </p>
                          <p className="text-[10px] text-muted-foreground font-mono">{p.portfolio_code}</p>
                        </div>
                        <Badge className={`text-[10px] shrink-0 border-0 ${statusColor}`}>
                          {p.status.replace(/_/g, ' ')}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-lg bg-muted/40 p-2">
                          <p className="text-[10px] text-muted-foreground">Funded</p>
                          <p className="text-xs font-bold">{formatUGX(p.investment_amount)}</p>
                        </div>
                        <div className="rounded-lg bg-muted/40 p-2">
                          <p className="text-[10px] text-muted-foreground">ROI Earned</p>
                          <p className="text-xs font-bold text-success">{formatUGX(p.total_roi_earned)}</p>
                        </div>
                        <div className="rounded-lg bg-muted/40 p-2">
                          <p className="text-[10px] text-muted-foreground">Rate</p>
                          <p className="text-xs font-bold">{p.roi_percentage}%</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {p.duration_months}mo term
                        </span>
                        {p.maturity_date && (
                          <span>Matures: {format(new Date(p.maturity_date), 'dd MMM yyyy')}</span>
                        )}
                        {p.next_roi_date && !p.maturity_date && (
                          <span>Next ROI: {format(new Date(p.next_roi_date), 'dd MMM')}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        )}

        {activeTab === 'history' && (
          <div className="space-y-3">
            {/* Withdrawals */}
            <Card>
              <CardContent className="p-3 space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5 text-destructive" />
                  Withdrawal Requests ({withdrawals.length})
                </h4>
                {withdrawals.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-2">No withdrawal requests</p>
                ) : (
                  <div className="space-y-1">
                    {withdrawals.map(w => (
                      <div key={w.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/40 last:border-0">
                        <div>
                          <p className="font-medium">{formatUGX(w.amount)}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {format(new Date(w.created_at), 'dd MMM yyyy HH:mm')}
                          </p>
                        </div>
                        <div className="text-right">
                          <Badge className={`text-[9px] border-0 ${
                            w.status === 'completed' ? 'bg-success/15 text-success' :
                            w.status === 'pending' ? 'bg-warning/15 text-warning' :
                            w.status === 'rejected' ? 'bg-destructive/15 text-destructive' :
                            'bg-muted text-muted-foreground'
                          }`}>
                            {w.status}
                          </Badge>
                          {w.payout_method && (
                            <p className="text-[9px] text-muted-foreground mt-0.5">{w.payout_method}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ROI full list */}
            <Card>
              <CardContent className="p-3 space-y-2">
                <h4 className="text-xs font-semibold flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-success" />
                  All ROI Payments ({roiPayments.length})
                </h4>
                {roiPayments.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-2">No ROI payments</p>
                ) : (
                  <div className="space-y-1">
                    {roiPayments.map(r => (
                      <div key={r.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/40 last:border-0">
                        <div>
                          <p className="font-medium">Payment #{r.payment_number}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {r.paid_at ? format(new Date(r.paid_at), 'dd MMM yyyy') : r.due_date ? `Due: ${format(new Date(r.due_date), 'dd MMM')}` : '—'}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-success">{formatUGX(r.roi_amount)}</p>
                          <Badge className={`text-[9px] border-0 ${r.status === 'paid' ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'}`}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Dialogs */}
      {funder.beneficiary && (
        <>
          <AgentProxyWithdrawalDialog
            open={withdrawDialogOpen}
            onOpenChange={setWithdrawDialogOpen}
            funderId={funder.beneficiary.id}
            funderName={funder.beneficiary.full_name}
            funderPhone={funder.beneficiary.phone}
            walletBalance={stats?.walletBalance || 0}
            onSuccess={() => {
              fetchAllData();
              onRefresh();
            }}
          />
          <ProxyPartnerDepositDialog
            open={depositDialogOpen}
            onOpenChange={setDepositDialogOpen}
            partner={funder.beneficiary}
            onSuccess={() => {
              fetchAllData();
              onRefresh();
            }}
          />
        </>
      )}
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Users, CheckCircle2, Clock, Wallet, Share2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import InviteMerchantAgentCard from '@/components/agent/InviteMerchantAgentCard';

interface ReferralRow {
  id: string;
  invitee_id: string;
  status: 'pending' | 'approved' | 'paid' | 'rejected';
  tier: 'direct' | 'upline';
  bonus_amount: number;
  paid_at: string | null;
  created_at: string;
  invitee?: { full_name: string | null; phone: string | null } | null;
}

export default function MerchantAgentReferrals() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['merchant-agent-referrals', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('merchant_agent_referrals')
        .select('id, invitee_id, status, tier, bonus_amount, paid_at, created_at, invitee:profiles!merchant_agent_referrals_invitee_id_fkey(full_name, phone)')
        .eq('beneficiary_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ReferralRow[];
    },
  });

  const stats = useMemo(() => {
    const total = rows.length;
    const paid = rows.filter((r) => r.status === 'paid').length;
    const pending = rows.filter((r) => r.status === 'pending' || r.status === 'approved').length;
    const earned = rows
      .filter((r) => r.status === 'paid')
      .reduce((s, r) => s + Number(r.bonus_amount || 0), 0);
    return { total, paid, pending, earned };
  }, [rows]);

  const statusBadge = (s: ReferralRow['status']) => {
    if (s === 'paid') return <Badge className="bg-success text-success-foreground">Paid</Badge>;
    if (s === 'approved') return <Badge className="bg-primary text-primary-foreground">Approved</Badge>;
    if (s === 'rejected') return <Badge variant="destructive">Rejected</Badge>;
    return <Badge variant="secondary">Pending</Badge>;
  };

  return (
    <div className="min-h-screen bg-background pb-20">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
        <div className="mx-auto max-w-2xl px-4 py-3 flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-9 w-9">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-bold">Merchant Agent Referrals</h1>
            <p className="text-xs text-muted-foreground">UGX 4,000 direct + UGX 6,000 when your recruit recruits</p>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-4 space-y-4">
        <InviteMerchantAgentCard />

        <div className="grid grid-cols-2 gap-3">
          <StatCard icon={<Users className="h-4 w-4" />} label="Invited" value={stats.total} />
          <StatCard icon={<CheckCircle2 className="h-4 w-4 text-success" />} label="Approved & Paid" value={stats.paid} />
          <StatCard icon={<Clock className="h-4 w-4 text-amber-500" />} label="Pending" value={stats.pending} />
          <StatCard icon={<Wallet className="h-4 w-4 text-primary" />} label="Total earned" value={formatUGX(stats.earned)} />
        </div>

        <Card className="p-4 rounded-2xl">
          <h2 className="text-sm font-bold mb-3">Recent invitations</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-6">Loading…</p>
          ) : rows.length === 0 ? (
            <div className="text-center py-8">
              <Share2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No invitations yet. Share your link to get started.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">
                      {r.invitee?.full_name || 'Invited user'}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {r.invitee?.phone || '—'} · {new Date(r.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {statusBadge(r.status)}
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {r.tier === 'upline' ? 'Upline' : 'Direct'}
                    </Badge>
                    <span className="text-[11px] font-mono">{formatUGX(r.bonus_amount)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <Card className="p-3 rounded-2xl">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-1 text-lg font-bold">{value}</p>
    </Card>
  );
}
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { formatRatePct, monthlyReturnFor, rateOrNull } from '@/lib/partnerReturnPolicy';
import { Wallet, Calendar, Clock, User, Shield, PiggyBank } from 'lucide-react';
import { format } from 'date-fns';

export default function InvestorPortfolioPublic() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [agentName, setAgentName] = useState('Agent');
  const [error, setError] = useState('');

  useEffect(() => {
    if (token) fetchPortfolio();
  }, [token]);

  const fetchPortfolio = async () => {
    setLoading(true);
    try {
      const { data, error: fetchError } = await supabase.rpc(
        'get_portfolio_by_activation_token' as never,
        { p_token: token } as never,
      );

      if (fetchError) throw fetchError;
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      const row = rows[0];
      if (!row) {
        setError('Portfolio not found or link expired');
        return;
      }

      setPortfolio(row);
      if (row.agent_name) setAgentName(row.agent_name);
    } catch (e: any) {
      setError(e.message || 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background p-4 space-y-4 max-w-lg mx-auto">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error || !portfolio) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="max-w-sm w-full">
          <CardContent className="p-8 text-center">
            <Shield className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <h2 className="font-bold text-lg mb-2">Portfolio Not Found</h2>
            <p className="text-sm text-muted-foreground">{error || 'This link may have expired or is invalid.'}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const roiModeLabel = portfolio.roi_mode === 'monthly_compounding' ? 'Monthly Compounding' : 'Monthly Payout';
  // The portfolio's own stored rate; null (masked by 4b, or missing) = no figure, never a default.
  const monthlyRoi = monthlyReturnFor(portfolio.investment_amount, rateOrNull(portfolio.roi_percentage));
  const ratePct = formatRatePct(rateOrNull(portfolio.roi_percentage));

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-primary/5 pb-10">
      {/* Header */}
      <header className="bg-gradient-to-br from-primary via-primary/90 to-violet-600 text-white p-6 pb-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <PiggyBank className="h-5 w-5 text-primary-foreground/70" />
            <span className="text-primary-foreground/70 text-xs font-medium uppercase tracking-wide">Supporter Portfolio</span>
          </div>
          <p className="text-3xl font-black">{formatUGX(portfolio.investment_amount)}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge className="bg-white/20 text-white border-0 text-xs">{portfolio.portfolio_code}</Badge>
            <Badge className="bg-white/20 text-white border-0 text-xs">{roiModeLabel}</Badge>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 -mt-4 space-y-4">
        {/* Support Details Card */}
        <Card className="shadow-lg">
          <CardContent className="p-5 space-y-4">
            <h3 className="font-bold text-base flex items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" />
              Support Details
            </h3>
            <div className="space-y-3">
              <DetailRow label="Support Amount" value={formatUGX(portfolio.investment_amount)} />
              <DetailRow label="Duration" value={`${portfolio.duration_months} months`} />
              {ratePct && <DetailRow label="Monthly Rent profit share" value={ratePct} highlight />}
              <DetailRow label="Rent profit share Mode" value={roiModeLabel} />
              {monthlyRoi != null && <DetailRow label="Expected Monthly Return" value={formatUGX(monthlyRoi)} highlight />}
            </div>
          </CardContent>
        </Card>

        {/* Schedule Card */}
        <Card>
          <CardContent className="p-5 space-y-4">
            <h3 className="font-bold text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Schedule
            </h3>
            <div className="space-y-3">
              <DetailRow label="Start Date" value={format(new Date(portfolio.created_at), 'dd MMM yyyy')} />
              {portfolio.next_roi_date && (
                <DetailRow label="Next Rent profit share Payment" value={format(new Date(portfolio.next_roi_date), 'dd MMM yyyy')} />
              )}
              {portfolio.maturity_date && (
                <DetailRow label="Maturity Date" value={format(new Date(portfolio.maturity_date), 'dd MMM yyyy')} />
              )}
              <DetailRow label="Total Rent profit share Earned" value={formatUGX(portfolio.total_roi_earned)} highlight />
            </div>
          </CardContent>
        </Card>

        {/* Agent Info */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Assigned Agent</p>
                <p className="font-semibold text-foreground">{agentName}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Status */}
        <div className="text-center py-4">
          <Badge variant="outline" className="bg-success/10 text-success border-success/30 text-sm px-4 py-1.5">
            <Clock className="h-3.5 w-3.5 mr-1.5" />
            Status: {portfolio.status === 'active' ? 'Active' : portfolio.status}
          </Badge>
        </div>
      </main>
    </div>
  );
}

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${highlight ? 'text-success' : 'text-foreground'}`}>{value}</span>
    </div>
  );
}

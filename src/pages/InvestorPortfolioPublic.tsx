import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { Wallet, TrendingUp, Calendar, Clock, User, Shield, PiggyBank } from 'lucide-react';
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
      const { data, error: fetchError } = await supabase
        .from('investor_portfolios')
        .select('*')
        .eq('activation_token', token)
        .maybeSingle();

      if (fetchError) throw fetchError;
      if (!data) {
        setError('Portfolio not found or link expired');
        return;
      }

      setPortfolio(data);

      // Fetch agent name
      const { data: agentProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', data.agent_id)
        .maybeSingle();
      if (agentProfile) setAgentName(agentProfile.full_name);
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
  const monthlyRoi = Math.round(portfolio.investment_amount * (portfolio.roi_percentage / 100));

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-primary/5 pb-10">
      {/* Header */}
      <header className="bg-gradient-to-br from-primary via-primary/90 to-violet-600 text-white p-6 pb-8">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-1">
            <PiggyBank className="h-5 w-5 text-primary-foreground/70" />
            <span className="text-primary-foreground/70 text-xs font-medium uppercase tracking-wide">Investor Portfolio</span>
          </div>
          <p className="text-3xl font-black">{formatUGX(portfolio.investment_amount)}</p>
          <div className="flex items-center gap-2 mt-2">
            <Badge className="bg-white/20 text-white border-0 text-xs">{portfolio.portfolio_code}</Badge>
            <Badge className="bg-white/20 text-white border-0 text-xs">{roiModeLabel}</Badge>
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 -mt-4 space-y-4">
        {/* Investment Details Card */}
        <Card className="shadow-lg">
          <CardContent className="p-5 space-y-4">
            <h3 className="font-bold text-base flex items-center gap-2">
              <Wallet className="h-4 w-4 text-primary" />
              Investment Details
            </h3>
            <div className="space-y-3">
              <DetailRow label="Investment Amount" value={formatUGX(portfolio.investment_amount)} />
              <DetailRow label="Duration" value={`${portfolio.duration_months} months`} />
              <DetailRow label="Monthly ROI" value={`${portfolio.roi_percentage}%`} highlight />
              <DetailRow label="ROI Mode" value={roiModeLabel} />
              <DetailRow label="Expected Monthly Return" value={formatUGX(monthlyRoi)} highlight />
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
                <DetailRow label="Next ROI Payment" value={format(new Date(portfolio.next_roi_date), 'dd MMM yyyy')} />
              )}
              {portfolio.maturity_date && (
                <DetailRow label="Maturity Date" value={format(new Date(portfolio.maturity_date), 'dd MMM yyyy')} />
              )}
              <DetailRow label="Total ROI Earned" value={formatUGX(portfolio.total_roi_earned)} highlight />
            </div>
          </CardContent>
        </Card>

        {/* Payment Info Card */}
        {portfolio.payment_method && (
          <Card>
            <CardContent className="p-5 space-y-4">
              <h3 className="font-bold text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" />
                ROI Payment Details
              </h3>
              <div className="space-y-3">
                <DetailRow label="Payment Method" value={portfolio.payment_method === 'mobile_money' ? 'Mobile Money' : 'Bank Transfer'} />
                {portfolio.payment_method === 'mobile_money' && (
                  <>
                    {portfolio.mobile_network && <DetailRow label="Network" value={portfolio.mobile_network.toUpperCase()} />}
                    {portfolio.mobile_money_number && <DetailRow label="Number" value={portfolio.mobile_money_number} />}
                  </>
                )}
                {portfolio.payment_method === 'bank' && (
                  <>
                    {portfolio.bank_name && <DetailRow label="Bank" value={portfolio.bank_name} />}
                    {portfolio.account_name && <DetailRow label="Account Name" value={portfolio.account_name} />}
                    {portfolio.account_number && <DetailRow label="Account Number" value={portfolio.account_number} />}
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}

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

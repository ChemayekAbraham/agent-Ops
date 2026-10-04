import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { format } from 'date-fns';
import {
  RefreshCw, Wallet, CheckCircle2, Shield, Calendar, User, Hash, FileText, ArrowLeft, Loader2,
} from 'lucide-react';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Mode = 'renew' | 'redeem';

interface Props { mode: Mode; }

const REQUEST_TYPE: Record<Mode, string> = {
  renew: 'RENEWAL_REQUEST',
  redeem: 'REDEMPTION_REQUEST',
};

const buildMessage = (mode: Mode, portfolioCode: string) =>
  mode === 'renew'
    ? `Greetings,

I am writing regarding my partnership portfolio (${portfolioCode}).

I would like to renew my partnership for a new investment cycle and continue participating in future opportunities available through the platform.

Kindly advise on any additional requirements or next steps.

Thank you.`
    : `Greetings,

I am writing regarding my partnership portfolio (${portfolioCode}).

I would like to request redemption of my partnership capital in accordance with the applicable partnership terms and conditions.

Kindly advise on the next steps and expected processing timelines.

Thank you.`;

export default function PortfolioActionRequest({ mode }: Props) {
  const { portfolioId } = useParams<{ portfolioId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<any>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ reference: string } | null>(null);

  const accent = mode === 'renew' ? 'hsl(271 79% 46%)' : 'hsl(142 71% 45%)';
  const title = mode === 'renew' ? 'Renew Partnership' : 'Redeem Partnership Capital';
  const Icon = mode === 'renew' ? RefreshCw : Wallet;

  // Require authentication — bounce to /auth and return here afterwards
  useEffect(() => {
    if (!authLoading && !user) {
      navigate(`/auth?redirect=${encodeURIComponent(location.pathname)}`, { replace: true });
    }
  }, [authLoading, user, navigate, location.pathname]);

  useEffect(() => {
    if (!portfolioId || !user) return;
    let active = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        let query = supabase
          .from('investor_portfolios')
          .select('id, portfolio_code, account_name, investment_amount, total_roi_earned, maturity_date, display_currency, investor_id, agent_id, status');
        query = UUID.test(portfolioId)
          ? query.eq('id', portfolioId)
          : query.eq('portfolio_code', portfolioId);
        const { data, error: fetchErr } = await query.maybeSingle();
        if (fetchErr) throw fetchErr;
        if (!active) return;
        if (!data) {
          setError('Portfolio not found. This link may have expired or you may not have access.');
          return;
        }
        if (data.investor_id !== user.id && data.agent_id !== user.id) {
          setError('You are not authorized to act on this portfolio.');
          return;
        }
        setPortfolio(data);
        const code = data.portfolio_code || `PF-${String(data.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
        setMessage(buildMessage(mode, code));
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed to load portfolio.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [portfolioId, user, mode]);

  const portfolioCode = useMemo(() => {
    if (!portfolio) return '';
    return portfolio.portfolio_code || `PF-${String(portfolio.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }, [portfolio]);

  const partnerName = (user?.user_metadata as any)?.full_name || user?.email || 'Partner';
  const currency = portfolio?.display_currency || 'UGX';
  const portfolioValue = Number(portfolio?.investment_amount) || 0;

  const fmtMoney = (n: number) => (currency === 'UGX' ? formatUGX(n) : `${currency} ${n.toLocaleString()}`);
  const fmtDate = (d: string | null) => {
    if (!d) return '—';
    try { return format(new Date(d), 'd MMMM yyyy'); } catch { return d; }
  };

  const handleSubmit = async () => {
    if (submitting || !portfolio) return;
    setSubmitting(true);
    const { data, error: subErr } = await invokeEdgeFunction<{ ok: boolean; requestReference: string }>(
      'submit-portfolio-action-request',
      {
        body: { portfolioId: portfolio.id, requestType: REQUEST_TYPE[mode], message },
        errorTitle: 'Request failed',
      },
    );
    setSubmitting(false);
    if (subErr || !data?.ok) return;
    setSubmitted({ reference: data.requestReference });
    toast.success('Request submitted', { description: 'Our Partnership Team will be in touch shortly.' });
  };

  // ---- Render states ----
  if (authLoading || (loading && !error)) {
    return (
      <div className="min-h-screen bg-muted/30 p-4">
        <div className="max-w-lg mx-auto space-y-4 pt-8">
          <Skeleton className="h-10 w-56" />
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center p-4">
        <Card className="max-w-sm w-full">
          <CardContent className="p-8 text-center space-y-3">
            <Shield className="h-12 w-12 mx-auto text-muted-foreground" />
            <h2 className="font-bold text-lg">Unable to continue</h2>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" className="mt-2" onClick={() => navigate('/dashboard/funder')}>
              Go to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-muted/30 flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center space-y-4">
            <div
              className="h-16 w-16 rounded-full mx-auto flex items-center justify-center"
              style={{ backgroundColor: `${accent}1a` }}
            >
              <CheckCircle2 className="h-9 w-9" style={{ color: accent }} />
            </div>
            <h2 className="font-bold text-xl">Request Submitted</h2>
            <p className="text-sm text-muted-foreground">
              Your {mode === 'renew' ? 'partnership renewal' : 'capital redemption'} request for{' '}
              <span className="font-semibold text-foreground">{portfolioCode}</span> has been received.
              Our Partnership Team will review it and follow up with you shortly. A confirmation email is on its way.
            </p>
            <div className="rounded-lg bg-muted px-4 py-3 text-sm">
              <span className="text-muted-foreground">Reference: </span>
              <span className="font-mono font-semibold">{submitted.reference}</span>
            </div>
            <Button className="w-full" onClick={() => navigate('/dashboard/funder')}>
              Back to dashboard
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30 p-4">
      <div className="max-w-lg mx-auto space-y-4 pt-6 pb-12">
        <button
          onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accent}1a` }}>
            <Icon className="h-6 w-6" style={{ color: accent }} />
          </div>
          <div>
            <h1 className="text-xl font-bold leading-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">Review your details and submit your request.</p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Review Request</CardTitle>
              <Badge variant="secondary">Matured</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Detail icon={FileText} label="Portfolio Name" value={portfolio?.account_name || 'Partnership Portfolio'} />
            <Detail icon={Hash} label="Portfolio ID" value={portfolioCode} mono />
            <Detail icon={Calendar} label="Maturity Date" value={fmtDate(portfolio?.maturity_date)} />
            <Detail icon={Wallet} label="Portfolio Value" value={fmtMoney(portfolioValue)} strong accent={accent} />
            <Detail icon={User} label="Partner Name" value={partnerName} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Request Message</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="request-message" className="sr-only">Request message</Label>
            <Textarea
              id="request-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={11}
              className="resize-none text-sm leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              This message will be sent to the Welile Partnership Team along with your request.
            </p>
          </CardContent>
        </Card>

        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <Button
            variant="outline"
            className="sm:flex-1"
            onClick={() => navigate('/dashboard/funder')}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            className="sm:flex-1 text-white"
            style={{ backgroundColor: accent }}
            onClick={handleSubmit}
            disabled={submitting || !message.trim()}
          >
            {submitting ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…</>
            ) : (
              'Submit Request'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Detail({
  icon: Icon, label, value, strong, mono, accent,
}: {
  icon: any; label: string; value: string; strong?: boolean; mono?: boolean; accent?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium">{label}</p>
        <p
          className={`${strong ? 'text-lg font-bold' : 'text-sm font-semibold'} ${mono ? 'font-mono' : ''} break-words`}
          style={strong && accent ? { color: accent } : undefined}
        >
          {value}
        </p>
      </div>
    </div>
  );
}
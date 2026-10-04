import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

interface FunnelRow {
  provider: string;
  env: string;
  attempts: number;
  redirected: number;
  errors: number;
  successes: number;
  completion_rate: number | null;
}

const ENV_LABEL: Record<string, string> = {
  local: 'Local dev',
  preview: 'Preview',
  published: 'Published',
  custom: 'Custom domain',
  unknown: 'Unknown',
};

const DAY_OPTIONS = [1, 7, 30];

export default function OAuthFunnel() {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (d: number) => {
    setLoading(true);
    setError(null);
    const { data, error } = await (supabase as any).rpc('get_oauth_funnel_stats', { p_days: d });
    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      setRows((data ?? []) as FunnelRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    load(days);
  }, [days]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.attempts += r.attempts;
        acc.redirected += r.redirected;
        acc.errors += r.errors;
        acc.successes += r.successes;
        return acc;
      },
      { attempts: 0, redirected: 0, errors: 0, successes: 0 },
    );
  }, [rows]);

  const overallRate = totals.attempts > 0 ? Math.round((1000 * totals.successes) / totals.attempts) / 10 : null;

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6 space-y-5">
      <Helmet>
        <title>OAuth Funnel | Welile</title>
        <meta name="description" content="Google and Apple sign-in funnel: attempts, redirects, failures and completions by environment." />
      </Helmet>

      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link to="/dashboard" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        </Button>
        <div>
          <h1 className="text-xl font-bold">OAuth Sign-in Funnel</h1>
          <p className="text-sm text-muted-foreground">Google &amp; Apple attempts vs completions by environment.</p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {DAY_OPTIONS.map((d) => (
          <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'} onClick={() => setDays(d)}>
            {d === 1 ? 'Last 24h' : `${d} days`}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => load(days)} className="ml-auto">
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Card className="p-3"><div className="text-xs text-muted-foreground">Attempts</div><div className="text-2xl font-bold">{totals.attempts}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Redirected</div><div className="text-2xl font-bold">{totals.redirected}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Completed</div><div className="text-2xl font-bold text-emerald-600">{totals.successes}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Failed</div><div className="text-2xl font-bold text-destructive">{totals.errors}</div></Card>
        <Card className="p-3"><div className="text-xs text-muted-foreground">Completion</div><div className="text-2xl font-bold">{overallRate === null ? '—' : `${overallRate}%`}</div></Card>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : error ? (
        <Card className="p-4 text-sm text-destructive">
          Could not load funnel data: {error}. This report is restricted to leadership/ops roles.
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No OAuth activity recorded in this window yet.
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3 font-medium">Provider</th>
                <th className="p-3 font-medium">Environment</th>
                <th className="p-3 font-medium text-right">Attempts</th>
                <th className="p-3 font-medium text-right">Redirected</th>
                <th className="p-3 font-medium text-right">Completed</th>
                <th className="p-3 font-medium text-right">Failed</th>
                <th className="p-3 font-medium text-right">Completion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.provider}-${r.env}-${i}`} className="border-b last:border-0">
                  <td className="p-3 capitalize font-medium">{r.provider}</td>
                  <td className="p-3">{ENV_LABEL[r.env] ?? r.env}</td>
                  <td className="p-3 text-right">{r.attempts}</td>
                  <td className="p-3 text-right">{r.redirected}</td>
                  <td className="p-3 text-right text-emerald-600">{r.successes}</td>
                  <td className="p-3 text-right text-destructive">{r.errors}</td>
                  <td className="p-3 text-right font-semibold">{r.completion_rate === null ? '—' : `${r.completion_rate}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        &ldquo;Completion&rdquo; = share of attempts that ended in a confirmed signed-in session. Focus on the
        <strong> Published</strong> and <strong>Custom domain</strong> rows for real user results — OAuth cannot complete on local dev.
      </p>
    </div>
  );
}

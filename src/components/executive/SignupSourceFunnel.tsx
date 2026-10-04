import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { Bot, UserPlus, Zap, Percent } from 'lucide-react';

// Connector / assistant-driven acquisition sources. Signups carrying these
// `signup_source` values came from an AI connector (e.g. the ChatGPT MCP),
// so we can isolate their conversion impact vs organic/direct signups.
const CONNECTOR_SOURCES = ['chatgpt', 'chat-gpt', 'openai', 'connector', 'mcp'];

function isConnector(source: string): boolean {
  const s = source.toLowerCase();
  return CONNECTOR_SOURCES.some((c) => s.includes(c));
}

const SOURCE_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT connector',
  direct: 'Direct / organic',
  'funder-onboarding': 'Funder onboarding',
  bot: 'Bot / automation',
};

function labelFor(source: string): string {
  return SOURCE_LABELS[source.toLowerCase()] ?? source;
}

interface FunnelRow {
  source: string;
  signups: number;
  activated: number;
}

interface Props {
  start: Date;
  end: Date;
}

export function SignupSourceFunnel({ start, end }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['signup-source-funnel', start.toISOString(), end.toISOString()],
    queryFn: async (): Promise<FunnelRow[]> => {
      const { data, error } = await (supabase.rpc as any)('signup_source_funnel', {
        p_start: start.toISOString(),
        p_end: end.toISOString(),
      });
      if (error) throw error;
      return ((data as FunnelRow[]) || []).map((r) => ({
        source: r.source,
        signups: Number(r.signups) || 0,
        activated: Number(r.activated) || 0,
      }));
    },
    staleTime: 600000,
  });

  const rows = data || [];
  const totalSignups = rows.reduce((s, r) => s + r.signups, 0);

  const connectorRows = rows.filter((r) => isConnector(r.source));
  const connectorSignups = connectorRows.reduce((s, r) => s + r.signups, 0);
  const connectorActivated = connectorRows.reduce((s, r) => s + r.activated, 0);
  const connectorActivationRate = connectorSignups > 0
    ? Math.round((connectorActivated / connectorSignups) * 100)
    : 0;
  const connectorShare = totalSignups > 0
    ? Math.round((connectorSignups / totalSignups) * 100)
    : 0;

  const chartData = rows.slice(0, 8).map((r) => ({
    name: labelFor(r.source),
    signups: r.signups,
    connector: isConnector(r.source),
  }));

  const tableData = rows.map((r) => ({
    ...r,
    label: labelFor(r.source),
    share: totalSignups > 0 ? Math.round((r.signups / totalSignups) * 100) : 0,
    activationRate: r.signups > 0 ? Math.round((r.activated / r.signups) * 100) : 0,
    connector: isConnector(r.source),
  }));

  const columns: Column<(typeof tableData)[number]>[] = [
    {
      key: 'label',
      label: 'Source',
      render: (_v, row) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{row.label}</span>
          {row.connector && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Bot className="w-3 h-3" /> Connector
            </span>
          )}
        </span>
      ),
    },
    { key: 'signups', label: 'Signups', render: (v) => (v as number).toLocaleString() },
    { key: 'share', label: 'Share', render: (v) => `${v}%` },
    { key: 'activated', label: 'Activated', render: (v) => (v as number).toLocaleString() },
    {
      key: 'activationRate',
      label: 'Activation',
      render: (v) => (
        <span className={(v as number) >= 50 ? 'text-green-600 font-medium' : 'text-muted-foreground'}>
          {v as number}%
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-3 sm:space-y-4">
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold">Signup Source Funnel</h3>
        <span className="text-xs text-muted-foreground">— connector conversion impact</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Total Signups" value={totalSignups.toLocaleString()} icon={UserPlus} loading={isLoading} />
        <KPICard title="Connector Signups" value={connectorSignups.toLocaleString()} icon={Bot} color="bg-primary/10 text-primary" loading={isLoading} />
        <KPICard title="Connector Share" value={`${connectorShare}%`} icon={Percent} color="bg-purple-500/10 text-purple-600" loading={isLoading} />
        <KPICard title="Connector Activation" value={`${connectorActivationRate}%`} icon={Zap} color="bg-green-500/10 text-green-600" loading={isLoading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h4 className="text-sm font-semibold mb-3">Signups by Source</h4>
          {chartData.length === 0 ? (
            <p className="text-xs text-muted-foreground py-8 text-center">No signups in this range.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis type="number" className="text-xs" allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={110} className="text-[10px]" />
                <Tooltip />
                <Bar dataKey="signups" radius={[0, 4, 4, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={entry.connector ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground)/0.5)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h4 className="text-sm font-semibold mb-3">Source Breakdown</h4>
          <ExecutiveDataTable data={tableData} columns={columns} loading={isLoading} />
        </div>
      </div>
    </div>
  );
}

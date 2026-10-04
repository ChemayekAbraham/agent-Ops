import { useQuery } from '@tanstack/react-query';
import { useState, useMemo, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import {
  Mail, Send, AlertTriangle, Clock, Users, Ban, TrendingUp, Inbox,
  ShieldAlert,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface EmailOverview {
  rangeDays: number;
  kpis: {
    total: number;
    totalSent: number;
    totalFailed: number;
    totalBounced: number;
    totalPending: number;
    totalSuppressed: number;
    suppressedTotal: number;
    deliveryRate: number;
    uniqueRecipients: number;
    topErrorCategory: string | null;
    topErrorCategoryCount: number;
    distinctErrorCategories: number;
  };
  series: { day: string; sent: number; failed: number; pending: number; total: number }[];
  templateSummary: { template: string; total: number; sent: number; failed: number; pending: number; lastSentAt: string | null }[];
  recent: { id: string; template_name: string; recipient_email: string; status: string; error_message: string | null; created_at: string; metadata?: { bcc?: string; from?: string; reply_to?: string; subject?: string } | null }[];
  errorCategories: { category: string; count: number }[];
  topErrorMessages: { message: string; count: number; category: string; lastSeen: string }[];
}

const RANGE_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '14d', value: 14 },
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
];

export function CTOEmailsOverview() {
  const [days, setDays] = useState(30);
  const [emailSearch, setEmailSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [previewRow, setPreviewRow] = useState<EmailOverview['recent'][number] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewSubject, setPreviewSubject] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // Resend a previously-logged email straight from the Recent Emails table.
  // The backend reconstructs the message from the archived template data and
  // re-queues it. Blocked (bounced/unsubscribed) addresses return `suppressed`
  // so the CTO can choose to force the send.
  const handleResend = async (
    row: EmailOverview['recent'][number],
    force = false,
  ) => {
    setResendingId(row.id);
    try {
      const sessionRes = await supabase.auth.getSession();
      const token = sessionRes.data.session?.access_token;
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cto-resend-email`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: row.id, force }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error('Resend failed', { description: json?.error || 'Unknown error' });
        return;
      }
      if (json.suppressed) {
        toast.warning('Address is blocked', {
          description: json.message || 'Previous bounce/unsubscribe.',
          action: { label: 'Force resend', onClick: () => handleResend(row, true) },
        });
        return;
      }
      toast.success('Email resent', {
        description: `Queued to ${json.recipient || row.recipient_email}`,
      });
    } catch (e) {
      toast.error('Resend failed', {
        description: e instanceof Error ? e.message : 'Network error',
      });
    } finally {
      setResendingId(null);
    }
  };

  // Debounce the search box so each keystroke doesn't fire a backend query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(emailSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [emailSearch]);

  const openPreview = async (row: EmailOverview['recent'][number]) => {
    setPreviewRow(row);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewHtml(null);
    setPreviewSubject(null);
    try {
      const sessionRes = await supabase.auth.getSession();
      const token = sessionRes.data.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cto-email-body?id=${row.id}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to load email body');
      setPreviewSubject(json.subject ?? null);
      setPreviewHtml(json.html ?? null);
      if (json.renderError) setPreviewError(json.renderError);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Failed to load email body');
    } finally {
      setPreviewLoading(false);
    }
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['cto-email-overview', days],
    queryFn: async () => {
      const sessionRes = await supabase.auth.getSession();
      const token = sessionRes.data.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cto-email-overview?days=${days}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as EmailOverview;
    },
    staleTime: 60_000,
  });

  // Backend search for the Recent Emails table — hits the database directly
  // across all time when the CTO types a query (≥2 chars). Otherwise the table
  // shows the recent set from the main overview payload.
  const isSearching = debouncedSearch.length >= 2;
  const { data: searchData, isFetching: searchFetching } = useQuery({
    queryKey: ['cto-email-search', debouncedSearch],
    enabled: isSearching,
    queryFn: async () => {
      const sessionRes = await supabase.auth.getSession();
      const token = sessionRes.data.session?.access_token;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/cto-email-overview?recentOnly=1&days=${days}&search=${encodeURIComponent(debouncedSearch)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(await res.text());
      return (await res.json()) as { recent: EmailOverview['recent'] };
    },
    staleTime: 30_000,
  });

  const recentRows = isSearching ? (searchData?.recent ?? []) : (data?.recent ?? []);

  const kpis = data?.kpis;

  // Distinct templates present in the recent set — drives the Template filter
  // dropdown so the CTO can narrow the table to a single email type.
  const templateFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of recentRows) {
      if (r.template_name) set.add(r.template_name);
    }
    return Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((t) => ({ value: t, label: t }));
  }, [recentRows]);

  const templateColumns: Column<EmailOverview['templateSummary'][number]>[] = [
    { key: 'template', label: 'Template' },
    { key: 'total', label: 'Total', render: (v) => Number(v).toLocaleString() },
    {
      key: 'sent',
      label: 'Sent',
      render: (v) => <span className="text-green-600 font-medium">{Number(v).toLocaleString()}</span>,
    },
    {
      key: 'failed',
      label: 'Failed',
      render: (v) => (
        <span className={Number(v) > 0 ? 'text-destructive font-medium' : 'text-muted-foreground'}>
          {Number(v).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'pending',
      label: 'Pending',
      render: (v) => <span className="text-amber-600">{Number(v).toLocaleString()}</span>,
    },
    {
      key: 'lastSentAt',
      label: 'Last Activity',
      render: (v) => (v ? format(new Date(v as string), 'dd MMM HH:mm') : '—'),
    },
  ];

  const recentColumns: Column<EmailOverview['recent'][number]>[] = [
    { key: 'created_at', label: 'Time', render: (v) => format(new Date(v as string), 'dd MMM HH:mm') },
    { key: 'template_name', label: 'Template' },
    { key: 'recipient_email', label: 'Recipient', className: 'max-w-[220px] truncate' },
    {
      key: 'status',
      label: 'Status',
      render: (v) => {
        const s = String(v);
        const cls =
          s === 'sent' ? 'bg-green-500/10 text-green-600' :
          s === 'failed' || s === 'dlq' || s === 'bounced' ? 'bg-destructive/10 text-destructive' :
          s === 'pending' ? 'bg-amber-500/10 text-amber-700' :
          'bg-muted text-muted-foreground';
        return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{s}</span>;
      },
    },
    { key: 'error_message', label: 'Error', className: 'max-w-[260px] truncate text-xs text-muted-foreground' },
    {
      key: 'metadata',
      label: 'BCC',
      className: 'max-w-[200px]',
      render: (_v, row) => {
        const bcc = row.metadata?.bcc;
        return bcc ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-600 whitespace-nowrap">
            <Mail className="h-3 w-3" />
            {bcc}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        );
      },
    },
    {
      key: 'id',
      label: 'Action',
      render: (_v, row) => (
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={resendingId === row.id}
          onClick={(e) => {
            e.stopPropagation();
            handleResend(row);
          }}
        >
          {resendingId === row.id ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          <span className="ml-1">Resend</span>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Emails Overview
          </h2>
          <p className="text-xs text-muted-foreground">
            Sent, delivered, failed, and queued transactional emails over the last {data?.rangeDays ?? days} days.
          </p>
        </div>
        <div className="flex gap-1 rounded-xl border border-border bg-card p-1">
          {RANGE_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={days === opt.value ? 'default' : 'ghost'}
              className="h-7 px-3 text-xs"
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load email overview: {(error as Error).message}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Total Emails"
          value={(kpis?.total ?? 0).toLocaleString()}
          icon={Inbox}
          loading={isLoading}
          subtitle={`Last ${data?.rangeDays ?? days} days`}
        />
        <KPICard
          title="Delivered"
          value={(kpis?.totalSent ?? 0).toLocaleString()}
          icon={Send}
          loading={isLoading}
          color="bg-green-500/10 text-green-600"
          subtitle={kpis ? `${kpis.deliveryRate}% delivery rate` : undefined}
        />
        <KPICard
          title="Failed / Bounced"
          value={((kpis?.totalFailed ?? 0) + (kpis?.totalBounced ?? 0)).toLocaleString()}
          icon={AlertTriangle}
          loading={isLoading}
          color="bg-destructive/10 text-destructive"
          subtitle="Requires attention"
        />
        <KPICard
          title="Pending in Queue"
          value={(kpis?.totalPending ?? 0).toLocaleString()}
          icon={Clock}
          loading={isLoading}
          color="bg-amber-500/10 text-amber-600"
        />
        <KPICard
          title="Unique Recipients"
          value={(kpis?.uniqueRecipients ?? 0).toLocaleString()}
          icon={Users}
          loading={isLoading}
          color="bg-blue-500/10 text-blue-600"
        />
        <KPICard
          title="Delivery Rate"
          value={kpis ? `${kpis.deliveryRate}%` : '—'}
          icon={TrendingUp}
          loading={isLoading}
          color={
            kpis && kpis.deliveryRate >= 90
              ? 'bg-green-500/10 text-green-600'
              : kpis && kpis.deliveryRate >= 70
              ? 'bg-amber-500/10 text-amber-600'
              : 'bg-destructive/10 text-destructive'
          }
        />
        <KPICard
          title="Suppressed"
          value={(kpis?.suppressedTotal ?? 0).toLocaleString()}
          icon={Ban}
          loading={isLoading}
          color="bg-rose-500/10 text-rose-600"
          subtitle="Bounce / unsubscribe / complaint"
        />
        <KPICard
          title="Templates Used"
          value={(data?.templateSummary?.length ?? 0).toLocaleString()}
          icon={Mail}
          loading={isLoading}
          color="bg-violet-500/10 text-violet-600"
        />
        <KPICard
          title="Top Error Category"
          value={kpis?.topErrorCategory ?? '—'}
          icon={ShieldAlert}
          loading={isLoading}
          color="bg-orange-500/10 text-orange-600"
          subtitle={
            kpis && kpis.topErrorCategoryCount > 0
              ? `${kpis.topErrorCategoryCount.toLocaleString()} of ${(kpis.totalFailed + kpis.totalBounced).toLocaleString()} failures • ${kpis.distinctErrorCategories} categories`
              : 'No failures in range'
          }
        />
      </div>

      {/* Line Graph */}
      <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Email Volume Trend</h3>
          <span className="text-[10px] text-muted-foreground">Daily • last {data?.rangeDays ?? days} days</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data?.series ?? []}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
            <XAxis
              dataKey="day"
              className="text-xs"
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => format(new Date(v), 'dd MMM')}
            />
            <YAxis className="text-xs" tick={{ fontSize: 10 }} />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--card))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => format(new Date(v as string), 'EEE dd MMM yyyy')}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Line type="monotone" dataKey="sent" name="Sent" stroke="hsl(142 71% 45%)" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="failed" name="Failed" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="pending" name="Pending" stroke="hsl(38 92% 50%)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Template summary table */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Summary by Template</h3>
        <ExecutiveDataTable
          data={data?.templateSummary ?? []}
          columns={templateColumns}
          loading={isLoading}
          title="Templates"
        />
      </div>

      {/* Failure breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-orange-600" />
            Failures by Error Category
          </h3>
          <ExecutiveDataTable
            data={data?.errorCategories ?? []}
            columns={[
              { key: 'category', label: 'Category' },
              {
                key: 'count',
                label: 'Count',
                render: (v) => <span className="font-medium text-destructive">{Number(v).toLocaleString()}</span>,
              },
              {
                key: 'count',
                label: 'Share',
                render: (v) => {
                  const totalFails = (data?.errorCategories ?? []).reduce((sum, c) => sum + c.count, 0);
                  const pct = totalFails > 0 ? Math.round((Number(v) / totalFails) * 1000) / 10 : 0;
                  return <span className="text-muted-foreground">{pct}%</span>;
                },
              },
            ]}
            loading={isLoading}
            title="Categories"
          />
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Top Error Messages
          </h3>
          <ExecutiveDataTable
            data={data?.topErrorMessages ?? []}
            columns={[
              {
                key: 'message',
                label: 'Error',
                className: 'max-w-[360px] truncate text-xs',
              },
              { key: 'category', label: 'Category', render: (v) => <span className="text-xs text-muted-foreground">{String(v)}</span> },
              {
                key: 'count',
                label: 'Count',
                render: (v) => <span className="font-medium text-destructive">{Number(v).toLocaleString()}</span>,
              },
              {
                key: 'lastSeen',
                label: 'Last Seen',
                render: (v) => (v ? format(new Date(v as string), 'dd MMM HH:mm') : '—'),
              },
            ]}
            loading={isLoading}
            title="Top 10 errors"
          />
        </div>
      </div>

      {/* Recent emails table */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Recent Emails</h3>
        <p className="text-xs text-muted-foreground mb-2">
          Search hits the database directly across all emails (recipient, template, or error) — not just the rows shown. Then narrow by status or template.
        </p>
        <ExecutiveDataTable
          data={recentRows}
          columns={recentColumns}
          loading={isLoading && !isSearching}
          title={isSearching ? `Search results for "${debouncedSearch}"` : 'Recent emails'}
          onRowClick={openPreview}
          searchValue={emailSearch}
          onSearchChange={setEmailSearch}
          searchPlaceholder="Search all emails by recipient, template, or error…"
          searching={searchFetching}
          filters={[
            {
              key: 'status',
              label: 'Status',
              options: [
                { value: 'sent', label: 'Sent' },
                { value: 'failed', label: 'Failed' },
                { value: 'pending', label: 'Pending' },
                { value: 'dlq', label: 'DLQ' },
                { value: 'bounced', label: 'Bounced' },
                { value: 'suppressed', label: 'Suppressed' },
              ],
            },
            ...(templateFilterOptions.length > 0
              ? [{ key: 'template_name', label: 'Template', options: templateFilterOptions }]
              : []),
          ]}
        />
      </div>

      <Dialog open={!!previewRow} onOpenChange={(o) => !o && setPreviewRow(null)}>
        <DialogContent className="max-w-3xl w-[95vw] max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">
              {previewSubject || previewRow?.template_name || 'Email preview'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              To <span className="font-medium text-foreground">{previewRow?.recipient_email}</span>
              {' • '}
              <span className="capitalize">{previewRow?.status}</span>
              {previewRow?.created_at && (
                <> • {format(new Date(previewRow.created_at), 'dd MMM yyyy HH:mm')}</>
              )}
              {' • template: '}
              <span className="font-mono">{previewRow?.template_name}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-[400px] border border-border rounded-lg overflow-hidden bg-card">
            {previewLoading ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Rendering email body…
              </div>
            ) : previewHtml ? (
              <iframe
                title="Email body"
                srcDoc={previewHtml}
                sandbox=""
                className="w-full h-[60vh]"
              />
            ) : (
              <div className="h-full p-6 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
                <AlertTriangle className="h-5 w-5 text-amber-600 mb-2" />
                <p className="font-medium text-foreground mb-1">Body not available</p>
                <p className="text-xs max-w-md">
                  {previewError ||
                    'No archived body for this email. Future sends will be viewable here.'}
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
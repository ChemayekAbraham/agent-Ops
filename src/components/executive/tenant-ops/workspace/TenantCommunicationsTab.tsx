import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import {
  BarChart3,
  FileSpreadsheet,
  FileText,
  Inbox,
  Loader2,
  MessageSquare,
  Phone,
  Save,
  Send,
  Clock3,
  XCircle,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import {
  buildEligibilityPreview,
  useSaveSupportContact,
  useTenantCommunications,
  useTenantPaymentMessageFigures,
  type CommsRecent,
  type SupportContact,
} from '@/hooks/useTenantCommunications';
import { useTenantTopupEligibility } from '@/hooks/useTenantTopupEligibility';
import { useAuth } from '@/hooks/useAuth';
import { KPICard } from '@/components/executive/KPICard';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import {
  exportTenantCommsMessageLogXlsx,
  generateTenantCommsMessageLogPdf,
} from '@/lib/tenantOpsCommunicationsReport';

function ContactRow({ contact }: { contact: SupportContact }) {
  const save = useSaveSupportContact();
  const [label, setLabel] = useState(contact.label);
  const [phone, setPhone] = useState(contact.phone);

  const dirty = label !== contact.label || phone !== contact.phone;

  const onSave = async () => {
    try {
      await save.mutateAsync({
        id: contact.id,
        label,
        phone,
        sort_order: contact.sort_order,
        active: contact.active,
      });
      toast.success('Customer care number updated');
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not save the number');
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
      <div className="min-w-[180px] flex-1">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="min-w-[160px] flex-1">
        <Label className="text-xs text-muted-foreground">Number</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
        <Save className="mr-1 h-3.5 w-3.5" />
        Save
      </Button>
      {!contact.active && <Badge variant="outline">Not in use</Badge>}
    </div>
  );
}

function AddContact() {
  const save = useSaveSupportContact();
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');

  const onAdd = async () => {
    try {
      await save.mutateAsync({ id: null, label, phone, sort_order: 99, active: true });
      setLabel('');
      setPhone('');
      toast.success('Customer care number added');
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not add the number');
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3">
      <div className="min-w-[180px] flex-1">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Welile Customer Care" />
      </div>
      <div className="min-w-[160px] flex-1">
        <Label className="text-xs text-muted-foreground">Number</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+256..." />
      </div>
      <Button size="sm" variant="outline" onClick={onAdd} disabled={!label.trim() || !phone.trim() || save.isPending}>
        Add number
      </Button>
    </div>
  );
}

/** Anything that isn't sent or failed is a skip — mirrors the original inline ternary. */
const isSkipped = (row: CommsRecent) => row.status !== 'sent' && row.status !== 'failed';

/** Result badge shared by the desktop table and the mobile card list. */
function ResultBadge({ row }: { row: CommsRecent }) {
  if (row.status === 'sent') {
    return <Badge variant="success">Sent</Badge>;
  }
  if (row.status === 'failed') {
    return <Badge variant="destructive">Failed</Badge>;
  }
  return (
    <Badge
      variant="outline"
      className="border-warning/40 bg-warning/10 text-warning"
      title={row.skip_reason ?? undefined}
    >
      Skipped
    </Badge>
  );
}

export default function TenantCommunicationsTab() {
  const { data, isLoading } = useTenantCommunications(50);
  const { user } = useAuth() as any;
  const [search, setSearch] = useState('');
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [xlsxLoading, setXlsxLoading] = useState(false);

  const lookup = useTenantTopupEligibility({
    search: search.trim().length >= 3 ? search.trim() : undefined,
    limit: 8,
    offset: 0,
  });
  const figures = useTenantPaymentMessageFigures(tenantId);

  const matches = useMemo(() => (search.trim().length >= 3 ? lookup.data?.rows ?? [] : []), [
    lookup.data,
    search,
  ]);

  const previewTail = useMemo(
    () =>
      buildEligibilityPreview(
        figures.data,
        data?.support_contacts ?? [],
        data?.channels ?? [],
      ),
    [figures.data, data],
  );

  const sentCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of data?.totals ?? []) {
      if (t.status !== 'sent') continue;
      out.set(t.event_key, (out.get(t.event_key) ?? 0) + Number(t.count || 0));
    }
    return out;
  }, [data]);

  // Same `data.totals` rows the "N sent in the last 7 days" line already
  // reads, aggregated a second way for the KPI strip and the chart below —
  // no new query, just different groupings of figures already fetched.
  const totals7d = useMemo(() => {
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const t of data?.totals ?? []) {
      const c = Number(t.count || 0);
      if (t.status === 'sent') sent += c;
      else if (t.status === 'failed') failed += c;
      else skipped += c;
    }
    return { sent, failed, skipped };
  }, [data]);

  const channelData = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of data?.totals ?? []) {
      if (t.status !== 'sent') continue;
      out.set(t.channel, (out.get(t.channel) ?? 0) + Number(t.count || 0));
    }
    return Array.from(out.entries()).map(([name, count]) => ({ name, count }));
  }, [data]);

  // The full recent-message array already in memory from the hook — not a
  // further-truncated slice — is what both exports and the table render.
  const messages = data?.recent ?? [];

  const onExportPdf = async () => {
    if (messages.length === 0) {
      toast.error('No payment messages to export yet.');
      return;
    }
    setPdfLoading(true);
    const toastId = toast.loading('Building the payment messages PDF…');
    try {
      await generateTenantCommsMessageLogPdf(messages, { generatedByUserId: user?.id });
      toast.success('Payment messages PDF ready', { id: toastId });
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not generate the PDF', { id: toastId });
    } finally {
      setPdfLoading(false);
    }
  };

  const onExportXlsx = async () => {
    if (messages.length === 0) {
      toast.error('No payment messages to export yet.');
      return;
    }
    setXlsxLoading(true);
    const toastId = toast.loading('Building the Excel export…');
    try {
      await exportTenantCommsMessageLogXlsx(messages);
      toast.success('Excel export ready', { id: toastId });
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not export to Excel', { id: toastId });
    } finally {
      setXlsxLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Every successful tenant payment already triggers a confirmation message. Those messages now
        also state, in exact shillings, how much has been paid, what remains, what rent the tenant has
        qualified for and how much more to pay for the next level — plus the pay codes and care
        numbers below. One message per payment day; nothing is sent twice.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KPICard
          title="Messages sent (7d)"
          value={totals7d.sent.toLocaleString()}
          icon={Send}
          color="bg-success/10 text-success"
        />
        <KPICard
          title="Failed (7d)"
          value={totals7d.failed.toLocaleString()}
          icon={XCircle}
          color="bg-destructive/10 text-destructive"
        />
        <KPICard
          title="Skipped (7d)"
          value={totals7d.skipped.toLocaleString()}
          icon={Clock3}
          color="bg-warning/10 text-warning"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <BarChart3 className="h-4 w-4 text-primary" />
            Messages sent by channel, last 7 days
          </CardTitle>
        </CardHeader>
        <CardContent>
          {channelData.length === 0 ? (
            <WorkspaceEmptyState
              icon={BarChart3}
              title="No sent messages in the last 7 days"
              hint="Channel activity will appear here once payment confirmations start going out."
            />
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={channelData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} className="fill-muted-foreground" />
                  <YAxis tick={{ fontSize: 10 }} className="fill-muted-foreground" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="count" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="h-4 w-4 text-primary" />
          Live messages
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(data?.templates ?? []).map((t) => (
            <div key={t.event_key} className="rounded-lg border bg-card p-3">
              <div className="flex items-start gap-2">
                <div className="rounded-lg bg-primary/10 p-1.5">
                  <MessageSquare className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{t.label ?? t.event_key}</span>
                    <Badge variant={t.active ? 'success' : 'muted'}>{t.active ? 'In use' : 'Off'}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {sentCounts.get(t.event_key) ?? 0} sent in the last 7 days
                  </span>
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {t.body_template}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Preview a tenant's message</h3>
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setTenantId(null);
          }}
          placeholder="Search a tenant by name or phone"
          className="max-w-sm"
        />
        {matches.length > 0 && !tenantId && (
          <div className="mt-2 flex flex-wrap gap-2">
            {matches.map((row) => (
              <Button
                key={row.tenant_id}
                size="sm"
                variant="outline"
                onClick={() => setTenantId(row.tenant_id)}
              >
                {row.tenant_name ?? 'Unnamed'} · {row.tenant_phone ?? 'no phone'}
              </Button>
            ))}
          </div>
        )}
        {tenantId && (
          <div className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm">
            {figures.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : previewTail ? (
              <p className="whitespace-pre-wrap">{previewTail}</p>
            ) : (
              <p className="text-muted-foreground">
                This tenant has no active Rent Plan figures to quote yet.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Payment codes</h3>
        <div className="flex flex-wrap gap-2">
          {(data?.channels ?? []).map((c) => (
            <Badge key={c.provider} variant="outline" className="text-sm">
              {c.provider}: {c.merchant_code}
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Phone className="h-4 w-4 text-primary" />
          Customer care numbers in messages
        </h3>
        <div className="space-y-2">
          {(data?.support_contacts ?? []).map((c) => (
            <ContactRow key={c.id} contact={c} />
          ))}
          <AddContact />
        </div>
      </div>

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Recent payment messages</h3>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onExportPdf} disabled={pdfLoading}>
              {pdfLoading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="mr-1 h-3.5 w-3.5" />
              )}
              Professional PDF
            </Button>
            <Button size="sm" variant="outline" onClick={onExportXlsx} disabled={xlsxLoading}>
              {xlsxLoading ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="mr-1 h-3.5 w-3.5" />
              )}
              Export Excel
            </Button>
          </div>
        </div>

        {messages.length === 0 ? (
          <WorkspaceEmptyState
            icon={Inbox}
            title="No payment messages recorded yet."
            hint="Confirmation messages will show up here as soon as tenant payments start coming in."
          />
        ) : (
          <>
            {/* Stacked cards below lg */}
            <div className="max-h-80 space-y-2 overflow-auto lg:hidden">
              {messages.map((r) => (
                <WorkspaceMobileRow
                  key={r.id}
                  title={r.tenant_name ?? r.tenant_id.slice(0, 8)}
                  badge={<ResultBadge row={r} />}
                  fields={[
                    { label: 'When', value: new Date(r.created_at).toLocaleString() },
                    { label: 'Channel', value: r.channel },
                    { label: 'Message', value: r.event_key, full: true },
                    ...(isSkipped(r) && r.skip_reason
                      ? [{ label: 'Reason', value: r.skip_reason, full: true }]
                      : []),
                  ]}
                />
              ))}
            </div>

            {/* Table at lg and above */}
            <div className="hidden max-h-80 overflow-auto rounded-lg border lg:block">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">When</TableHead>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-xs">Message</TableHead>
                    <TableHead className="text-xs">Channel</TableHead>
                    <TableHead className="text-xs">Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messages.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">
                        {new Date(r.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-xs">{r.tenant_name ?? r.tenant_id.slice(0, 8)}</TableCell>
                      <TableCell className="text-xs">{r.event_key}</TableCell>
                      <TableCell className="text-xs">{r.channel}</TableCell>
                      <TableCell className="text-xs">
                        <ResultBadge row={r} />
                        {isSkipped(r) && r.skip_reason && (
                          <p className="mt-0.5 text-[10px] text-muted-foreground">{r.skip_reason}</p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

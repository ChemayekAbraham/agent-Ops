import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import {
  ClipboardList, Search, RefreshCw, UserCheck, ShieldCheck, Loader2,
  ImageIcon, Receipt, MapPin, ChevronLeft, ChevronRight, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { formatDynamic } from '@/lib/currencyFormat';
import {
  usePartnerOpsRentQueue,
  PARTNER_OPS_RENT_PAGE_SIZE,
  type PartnerOpsRentRow,
} from '@/hooks/usePartnerOpsRentQueue';

type QueueStatus = 'landlord_ops_approved' | 'partner_ops_approved';

/** Every media URL a request carries, flattened once per row. */
function rowMedia(row: PartnerOpsRentRow) {
  const media: { url: string; label: string }[] = [];
  (row.house_image_urls ?? []).forEach((url, i) => url && media.push({ url, label: `House photo ${i + 1}` }));
  if (row.tenant_photo_url) media.push({ url: row.tenant_photo_url, label: 'Tenant photo' });
  if (row.latest_rent_receipt_url) media.push({ url: row.latest_rent_receipt_url, label: 'Latest receipt' });
  return media;
}

export function PartnerOpsRentRequestQueue() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<QueueStatus>('landlord_ops_approved');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [proxyAgentId, setProxyAgentId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);

  const { data, isLoading, isFetching, refetch } = usePartnerOpsRentQueue({ status, search, page });
  const rows = data?.rows ?? [];
  const proxyAgents = data?.proxy_agents ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PARTNER_OPS_RENT_PAGE_SIZE));

  const selectedIds = useMemo(
    () => rows.filter((r) => selected[r.id]).map((r) => r.id),
    [rows, selected],
  );
  const isAwaiting = status === 'landlord_ops_approved';
  const canSubmit = isAwaiting && selectedIds.length > 0 && !!proxyAgentId && note.trim().length >= 10;

  const resetSelection = () => {
    setSelected({});
    setNote('');
    setProxyAgentId('');
  };

  const switchStatus = (next: QueueStatus) => {
    setStatus(next);
    setPage(0);
    resetSelection();
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? Object.fromEntries(rows.map((r) => [r.id, true])) : {});
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { data: result, error } = await supabase.rpc('partner_ops_attach_proxy_and_forward', {
        p_request_ids: selectedIds,
        p_proxy_agent_id: proxyAgentId,
        p_comment: note.trim(),
      });
      if (error) throw error;
      const updated = (result as any)?.updated ?? 0;
      toast.success(`${updated} rent plan${updated === 1 ? '' : 's'} forwarded to the COO`);
      resetSelection();
      await queryClient.invalidateQueries({ queryKey: ['partner-ops-rent-queue'] });
      await queryClient.invalidateQueries({ queryKey: ['rent-pipeline'] });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not forward the selected rent plans');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-primary" />
            Rent Plans — Proxy Agent Attachment
            <Badge variant="secondary">{total}</Badge>
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Landlord Operations hands every rent plan here. Attach a verified proxy agent, then submit — only then does
          the plan appear on the COO desk.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <Tabs value={status} onValueChange={(v) => switchStatus(v as QueueStatus)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="landlord_ops_approved">Awaiting attachment</TabsTrigger>
            <TabsTrigger value="partner_ops_approved">Forwarded to COO</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search tenant, phone, agent, landlord or town"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          />
        </div>

        {isAwaiting && (
          <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Attach a verified proxy agent
              <Badge variant="outline" className="text-[10px]">{proxyAgents.length} verified</Badge>
            </div>
            <Select value={proxyAgentId} onValueChange={setProxyAgentId}>
              <SelectTrigger>
                <SelectValue placeholder={proxyAgents.length ? 'Select a verified proxy agent' : 'No verified proxy agents yet'} />
              </SelectTrigger>
              <SelectContent>
                {proxyAgents.map((p) => (
                  <SelectItem key={p.agent_user_id} value={p.agent_user_id}>
                    {p.full_name}{p.phone ? ` · ${p.phone}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={2}
              placeholder="Why this proxy agent (minimum 10 characters) — kept on the request for the COO"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={rows.length > 0 && selectedIds.length === rows.length}
                  onCheckedChange={(c) => toggleAll(!!c)}
                />
                Select all on this page
              </label>
              <Button size="sm" className="gap-1.5" disabled={!canSubmit || submitting} onClick={submit}>
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
                Submit {selectedIds.length || ''} to COO
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            Loading rent plans…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {isAwaiting ? 'No rent plans are waiting for a proxy agent.' : 'Nothing forwarded yet.'}
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => {
              const media = rowMedia(row);
              return (
                <div key={row.id} className="rounded-xl border p-3 space-y-3">
                  <div className="flex items-start gap-3">
                    {isAwaiting && (
                      <Checkbox
                        className="mt-1"
                        checked={!!selected[row.id]}
                        onCheckedChange={(c) => setSelected((s) => ({ ...s, [row.id]: !!c }))}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold">{row.tenant_name}</p>
                        {row.tenant_phone && (
                          <span className="text-xs text-muted-foreground">{row.tenant_phone}</span>
                        )}
                        {row.proxy_agent_name && (
                          <Badge className="gap-1 bg-violet-500/15 text-violet-700 hover:bg-violet-500/15">
                            <ShieldCheck className="h-3 w-3" />
                            {row.proxy_agent_name}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{formatDynamic(row.rent_amount)}</span>
                        {row.duration_days ? <span>{row.duration_days} days</span> : null}
                        {row.house_category ? <span>{row.house_category}</span> : null}
                        {row.request_city ? (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" />{row.request_city}
                          </span>
                        ) : null}
                        <span>Agent: {row.agent_name ?? '—'}</span>
                        <span>Landlord: {row.landlord_name ?? '—'}</span>
                        <span>
                          Landlord Ops:{' '}
                          {row.landlord_ops_reviewed_at
                            ? format(new Date(row.landlord_ops_reviewed_at), 'dd MMM, HH:mm')
                            : '—'}
                        </span>
                      </div>
                      {row.landlord_ops_comment && (
                        <p className="mt-1 text-xs italic text-muted-foreground">
                          Landlord Ops note: {row.landlord_ops_comment}
                        </p>
                      )}
                      {row.partner_ops_comment && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
                          <CheckCircle2 className="h-3 w-3" />
                          {row.partner_ops_comment}
                        </p>
                      )}
                    </div>
                  </div>

                  {media.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {media.map((m) => (
                        <button
                          key={m.url}
                          type="button"
                          onClick={() => setPreview(m)}
                          className="group relative h-16 w-16 overflow-hidden rounded-lg border bg-muted"
                          title={m.label}
                        >
                          <img
                            src={m.url}
                            alt={m.label}
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform group-hover:scale-105"
                          />
                          {m.label === 'Latest receipt' && (
                            <Receipt className="absolute bottom-0.5 right-0.5 h-3 w-3 text-white drop-shadow" />
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <ImageIcon className="h-3 w-3" /> No media attached to this request
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
            <span>Page {page + 1} of {pages}</span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{preview?.label}</DialogTitle>
          </DialogHeader>
          {preview && (
            <img src={preview.url} alt={preview.label} className="max-h-[70vh] w-full rounded-lg object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

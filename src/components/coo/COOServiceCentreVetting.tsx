import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Building2, CheckCircle, XCircle, Loader2, MapPin, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

interface SCRow {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  photo_url: string;
  latitude: number | string;
  longitude: number | string;
  location_name: string | null;
  status: string;
  verified_at: string | null;
  verified_amount: number | null;
  verification_comment: string | null;
  ceo_approved_at: string | null;
  ceo_comment: string | null;
  created_at: string;
}

const mapsUrl = (lat: number | string, lng: number | string) =>
  `https://www.google.com/maps?q=${lat},${lng}`;

export function COOServiceCentreVetting() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [tab, setTab] = useState('awaiting');

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['coo-service-centres'],
    queryFn: async (): Promise<SCRow[]> => {
      const { data, error } = await supabase
        .from('service_centre_setups' as any)
        .select('*')
        .in('status', ['verified', 'active'])
        .order('verified_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data || []) as unknown as SCRow[];
    },
    staleTime: 30_000,
  });

  const awaiting = useMemo(() => rows.filter((r) => r.status === 'verified'), [rows]);
  const active = useMemo(() => rows.filter((r) => r.status === 'active'), [rows]);

  const selectedIds = useMemo(
    () => awaiting.filter((r) => selected[r.id]).map((r) => r.id),
    [awaiting, selected],
  );
  const allSelected = awaiting.length > 0 && selectedIds.length === awaiting.length;

  const run = async (mode: 'approve' | 'reject') => {
    const text = comment.trim();
    if (!selectedIds.length) {
      toast.error('Select at least one service centre.');
      return;
    }
    if (text.length < 10) {
      toast.error('Add a comment of at least 10 characters.');
      return;
    }
    setBusy(mode);
    try {
      const fn = mode === 'approve' ? 'ceo_approve_service_centres' : 'ceo_reject_service_centres';
      const { data, error } = await supabase.rpc(fn as any, {
        p_ids: selectedIds,
        p_comment: text,
      });
      if (error) throw error;
      const count = Array.isArray(data) ? data.length : 0;
      if (!count) throw new Error('No service centre was updated — they may have changed status already.');
      toast.success(
        mode === 'approve'
          ? `${count} service centre${count > 1 ? 's' : ''} approved and marked active.`
          : `${count} service centre${count > 1 ? 's' : ''} rejected.`,
      );
      setSelected({});
      setComment('');
      queryClient.invalidateQueries({ queryKey: ['coo-service-centres'] });
      queryClient.invalidateQueries({ queryKey: ['service-centres-all'] });
      queryClient.invalidateQueries({ queryKey: ['service-centres-active'] });
    } catch (err: any) {
      toast.error(err?.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const renderCard = (s: SCRow, selectable: boolean) => (
    <div key={s.id} className="rounded-xl border border-border p-3 space-y-2">
      <div className="flex items-start gap-3">
        {selectable && (
          <Checkbox
            checked={!!selected[s.id]}
            onCheckedChange={(v) => setSelected((p) => ({ ...p, [s.id]: !!v }))}
            className="mt-1"
            aria-label={`Select ${s.agent_name}`}
          />
        )}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground truncate">{s.agent_name}</p>
            <Badge variant="outline" className="text-[10px]">
              {s.status === 'active' ? 'Active' : 'Awaiting COO vetting'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{s.agent_phone}</p>
          <p className="text-xs text-muted-foreground">{s.location_name || 'No description'}</p>
          <p className="text-xs text-muted-foreground">
            Verified by Agent Ops:{' '}
            {s.verified_at ? format(new Date(s.verified_at), 'dd MMM yyyy HH:mm') : 'n/a'}
          </p>
          {s.verified_amount != null && (
            <p className="text-xs font-medium text-foreground">
              Unit price: {formatUGX(Number(s.verified_amount))}
            </p>
          )}
          {s.verification_comment && (
            <p className="text-xs text-muted-foreground italic">Ops note: {s.verification_comment}</p>
          )}
          {s.ceo_comment && (
            <p className="text-xs text-muted-foreground italic">COO note: {s.ceo_comment}</p>
          )}
        </div>
        <a
          href={mapsUrl(s.latitude, s.longitude)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
        >
          <MapPin className="h-3 w-3" />
          Map
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {s.photo_url && (
        <img
          src={s.photo_url}
          alt={`Service centre of ${s.agent_name}`}
          loading="lazy"
          className="max-h-40 w-full rounded-lg border object-cover"
        />
      )}
    </div>
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          Service Centres — COO vetting
          {awaiting.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
              {awaiting.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-3 grid w-full grid-cols-2">
            <TabsTrigger value="awaiting" className="text-xs">
              Awaiting approval ({awaiting.length})
            </TabsTrigger>
            <TabsTrigger value="active" className="text-xs">
              Active ({active.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="awaiting" className="space-y-3">
            {isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !awaiting.length ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No verified service centres are waiting for COO vetting.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between rounded-lg border border-dashed border-border bg-muted/40 p-2.5">
                  <label className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={(v) =>
                        setSelected(
                          v ? Object.fromEntries(awaiting.map((r) => [r.id, true])) : {},
                        )
                      }
                      aria-label="Select all"
                    />
                    Select all
                  </label>
                  <span className="text-xs text-muted-foreground">{selectedIds.length} selected</span>
                </div>

                <div className="space-y-3">{awaiting.map((s) => renderCard(s, true))}</div>

                <div className="space-y-2 rounded-lg border border-border p-2.5">
                  <label className="text-[11px] text-muted-foreground" htmlFor="coo-sc-comment">
                    Comment (min 10 characters, applies to every selected centre)
                  </label>
                  <Textarea
                    id="coo-sc-comment"
                    rows={3}
                    maxLength={1000}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="Why these centres are approved or rejected"
                    className="text-xs"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 gap-1"
                      disabled={busy !== null || !selectedIds.length}
                      onClick={() => run('approve')}
                    >
                      {busy === 'approve' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <CheckCircle className="h-3 w-3" />
                      )}
                      Approve &amp; mark active ({selectedIds.length})
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1 gap-1"
                      disabled={busy !== null || !selectedIds.length}
                      onClick={() => run('reject')}
                    >
                      {busy === 'reject' ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <XCircle className="h-3 w-3" />
                      )}
                      Reject ({selectedIds.length})
                    </Button>
                  </div>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="active" className="space-y-3">
            {!active.length ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No active service centres yet.
              </p>
            ) : (
              active.map((s) => renderCard(s, false))
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default COOServiceCentreVetting;

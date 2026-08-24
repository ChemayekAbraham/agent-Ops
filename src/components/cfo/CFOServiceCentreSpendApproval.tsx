import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  photo_url: string | null;
  latitude: number | string;
  longitude: number | string;
  location_name: string | null;
  status: string;
  verified_at: string | null;
  verified_amount: number | null;
  verification_comment: string | null;
  ceo_approved_at: string | null;
  ceo_comment: string | null;
  cfo_decision: string | null;
  cfo_decided_at: string | null;
  cfo_approved_amount: number | null;
  cfo_comment: string | null;
}

const mapsUrl = (lat: number | string, lng: number | string) =>
  `https://www.google.com/maps?q=${lat},${lng}`;

export function CFOServiceCentreSpendApproval() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('awaiting');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cfo-service-centre-spend'],
    queryFn: async (): Promise<SCRow[]> => {
      const { data, error } = await supabase
        .from('service_centre_setups' as any)
        .select('*')
        .eq('status', 'active')
        .not('ceo_approved_at', 'is', null)
        .order('ceo_approved_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as SCRow[];
    },
    staleTime: 30_000,
  });

  const awaiting = useMemo(() => rows.filter((r) => !r.cfo_decision), [rows]);
  const decided = useMemo(() => rows.filter((r) => !!r.cfo_decision), [rows]);

  const pendingTotal = useMemo(
    () => awaiting.reduce((sum, r) => sum + Number(r.verified_amount || 0), 0),
    [awaiting],
  );

  const decide = async (row: SCRow, decision: 'approved' | 'declined') => {
    const comment = (comments[row.id] || '').trim();
    if (comment.length < 10) {
      toast.error('Add a comment of at least 10 characters.');
      return;
    }
    const amount =
      decision === 'approved'
        ? Number(amounts[row.id] ?? row.verified_amount ?? 0)
        : null;
    if (decision === 'approved' && (!amount || amount <= 0)) {
      toast.error('Enter the amount to be spent.');
      return;
    }
    setBusy(row.id);
    try {
      const { error } = await supabase.rpc('cfo_decide_service_centre' as any, {
        p_id: row.id,
        p_decision: decision,
        p_comment: comment,
        p_amount: amount,
      });
      if (error) throw error;
      toast.success(
        decision === 'approved'
          ? `Spend of ${formatUGX(Number(amount))} approved for ${row.agent_name}.`
          : `Service centre spend declined for ${row.agent_name}.`,
      );
      setComments((p) => ({ ...p, [row.id]: '' }));
      queryClient.invalidateQueries({ queryKey: ['cfo-service-centre-spend'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-actions-log'] });
    } catch (err: any) {
      toast.error(err?.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const renderCard = (s: SCRow, actionable: boolean) => (
    <div key={s.id} className="space-y-2 rounded-xl border border-border p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-foreground">{s.agent_name}</p>
            <Badge variant="outline" className="text-[10px]">
              {s.cfo_decision === 'approved'
                ? 'Spend approved'
                : s.cfo_decision === 'declined'
                  ? 'Declined'
                  : 'Awaiting CFO'}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">{s.agent_phone}</p>
          <p className="text-xs text-muted-foreground">{s.location_name || 'No description'}</p>
          <p className="text-xs text-muted-foreground">
            COO vetted:{' '}
            {s.ceo_approved_at ? format(new Date(s.ceo_approved_at), 'dd MMM yyyy HH:mm') : 'n/a'}
          </p>
          <p className="text-sm font-semibold text-foreground">
            Money to be spent: {formatUGX(Number(s.verified_amount || 0))}
          </p>
          {s.verification_comment && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Agent Ops reason:</span> {s.verification_comment}
            </p>
          )}
          {s.ceo_comment && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">COO reason:</span> {s.ceo_comment}
            </p>
          )}
          {s.cfo_comment && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">CFO note:</span> {s.cfo_comment}
              {s.cfo_approved_amount != null && ` — ${formatUGX(Number(s.cfo_approved_amount))}`}
            </p>
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

      {actionable && (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <label className="text-[11px] text-muted-foreground" htmlFor={`amt-${s.id}`}>
            Amount to spend (UGX)
          </label>
          <Input
            id={`amt-${s.id}`}
            type="number"
            min={0}
            value={amounts[s.id] ?? String(s.verified_amount ?? '')}
            onChange={(e) => setAmounts((p) => ({ ...p, [s.id]: e.target.value }))}
            className="h-8 text-xs"
          />
          <label className="text-[11px] text-muted-foreground" htmlFor={`cmt-${s.id}`}>
            CFO comment (min 10 characters)
          </label>
          <Textarea
            id={`cmt-${s.id}`}
            rows={2}
            maxLength={1000}
            value={comments[s.id] ?? ''}
            onChange={(e) => setComments((p) => ({ ...p, [s.id]: e.target.value }))}
            placeholder="Why this spend is approved or declined"
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 gap-1"
              disabled={busy !== null}
              onClick={() => decide(s, 'approved')}
            >
              {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
              Approve spend
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-1"
              disabled={busy !== null}
              onClick={() => decide(s, 'declined')}
            >
              {busy === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
              Decline
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          Service Centres — CFO spend approval
          {awaiting.length > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
              {awaiting.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="mb-3 text-xs text-muted-foreground">
          COO-vetted service centres land here with the reason from Agent Ops and the COO plus the money to be spent.
          Pending spend: <span className="font-semibold text-foreground">{formatUGX(pendingTotal)}</span>
        </p>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-3 grid w-full grid-cols-2">
            <TabsTrigger value="awaiting" className="text-xs">
              Awaiting CFO ({awaiting.length})
            </TabsTrigger>
            <TabsTrigger value="decided" className="text-xs">
              Decided ({decided.length})
            </TabsTrigger>
          </TabsList>

          <TabsContent value="awaiting" className="space-y-3">
            {isLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !awaiting.length ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No COO-vetted service centres are waiting for CFO approval.
              </p>
            ) : (
              awaiting.map((s) => renderCard(s, true))
            )}
          </TabsContent>

          <TabsContent value="decided" className="space-y-3">
            {!decided.length ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No CFO decisions yet.</p>
            ) : (
              decided.map((s) => renderCard(s, false))
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default CFOServiceCentreSpendApproval;

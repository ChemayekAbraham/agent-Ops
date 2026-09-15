import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Building2, CheckCircle, XCircle, Loader2, MapPin, ExternalLink, User } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

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
  payee_user_id: string | null;
  payee_name: string | null;
  payee_phone: string | null;
  payee_note: string | null;
}

interface PayeeChoice {
  userId: string | null;
  name: string;
  phone: string;
}

interface ProfileMatch {
  id: string;
  full_name: string | null;
  phone: string | null;
}

const mapsUrl = (lat: number | string, lng: number | string) =>
  `https://www.google.com/maps?q=${lat},${lng}`;

/** Service centre spend defaults to the operations manager account. */
const DEFAULT_PAYEE_EMAIL = 'grace.nation78@gmail.com';
const DEFAULT_PAYEE_FALLBACK: PayeeChoice = {
  userId: '99890a2e-b842-4d44-8516-e2eafe0711ff',
  name: 'Grace Paul Ochieng',
  phone: '+254733803035',
};

export function CFOServiceCentreSpendApproval() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('awaiting');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [payees, setPayees] = useState<Record<string, PayeeChoice>>({});
  const [payeeNotes, setPayeeNotes] = useState<Record<string, string>>({});
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<ProfileMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!searchFor) return;
    const term = search.trim();
    if (term.length < 3) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const like = `%${term}%`;
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .or(`full_name.ilike.${like},phone.ilike.${like}`)
        .limit(8);
      if (!cancelled) {
        setMatches((data || []) as ProfileMatch[]);
        setSearching(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, searchFor]);


  const { data: defaultPayee } = useQuery({
    queryKey: ['cfo-sc-default-payee'],
    queryFn: async (): Promise<PayeeChoice> => {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .eq('email', DEFAULT_PAYEE_EMAIL)
        .maybeSingle();
      if (!data) return DEFAULT_PAYEE_FALLBACK;
      return {
        userId: data.id,
        name: data.full_name || DEFAULT_PAYEE_FALLBACK.name,
        phone: data.phone || DEFAULT_PAYEE_FALLBACK.phone,
      };
    },
    staleTime: 10 * 60_000,
  });

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

  const payeeFor = (s: SCRow): PayeeChoice => {
    if (payees[s.id]) return payees[s.id];
    if (s.payee_name || s.payee_user_id) {
      return {
        userId: s.payee_user_id ?? null,
        name: s.payee_name || '',
        phone: s.payee_phone || '',
      };
    }
    return defaultPayee ?? DEFAULT_PAYEE_FALLBACK;
  };


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
    const payee = payeeFor(row);
    if (decision === 'approved' && !payee.name.trim()) {
      toast.error('Name who will receive this money.');
      return;
    }
    setBusy(row.id);
    try {
      const { error } = await supabase.rpc('cfo_decide_service_centre' as any, {
        p_id: row.id,
        p_decision: decision,
        p_comment: comment,
        p_amount: amount,
        p_payee_user_id: payee.userId,
        p_payee_name: payee.name.trim() || null,
        p_payee_phone: payee.phone.trim() || null,
        p_payee_note: (payeeNotes[row.id] || '').trim() || null,
      });
      if (error) throw error;
      if (decision === 'approved') {
        const { data: smsRes, error: smsErr } = await supabase.functions.invoke(
          'service-centre-spend-sms',
          { body: { setup_id: row.id } },
        );
        if (smsErr || !(smsRes as any)?.sent) {
          toast.warning(
            `Spend approved, but the SMS to ${payee.name.trim() || 'the recipient'} did not go out.`,
          );
        } else {
          toast.success(
            `Spend of ${formatUGX(Number(amount))} approved — SMS sent to ${payee.name.trim()} (${payee.phone.trim()}).`,
          );
        }
      } else {
        toast.success(`Service centre spend declined for ${row.agent_name}.`);
      }

      setComments((p) => ({ ...p, [row.id]: '' }));
      setSearchFor(null);
      setSearch('');
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
          <p className="text-xs text-foreground">
            <span className="font-medium">Money goes to:</span>{' '}
            {payeeFor(s).name || 'Not named yet'}
            {payeeFor(s).phone ? ` · ${payeeFor(s).phone}` : ''}
            {!s.payee_name && !s.cfo_decision ? ' (defaults to the manager account)' : ''}
          </p>
          {s.payee_note && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Recipient note:</span> {s.payee_note}
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
        <CfoApprovalGate>
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <div className="space-y-1.5 rounded-lg bg-muted/40 p-2">
            <p className="text-[11px] font-semibold text-foreground">Who gets this money</p>
            <p className="text-xs text-foreground">
              {payeeFor(s).name || 'Nobody selected'}
              {payeeFor(s).phone ? ` · ${payeeFor(s).phone}` : ''}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Defaults to the manager account. Change it to the centre agent or anyone else — the
              recipient gets an SMS as soon as the spend is approved.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                onClick={() =>
                  setPayees((p) => ({ ...p, [s.id]: defaultPayee ?? DEFAULT_PAYEE_FALLBACK }))
                }
              >
                <User className="h-3 w-3" />
                Pay the manager
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 text-[11px]"
                onClick={() =>
                  setPayees((p) => ({
                    ...p,
                    [s.id]: { userId: s.agent_id, name: s.agent_name || '', phone: s.agent_phone || '' },
                  }))
                }
              >
                <User className="h-3 w-3" />
                Pay the centre agent
              </Button>

              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={() => {
                  setSearchFor(searchFor === s.id ? null : s.id);
                  setSearch('');
                  setMatches([]);
                }}
              >
                {searchFor === s.id ? 'Close search' : 'Choose someone else'}
              </Button>
            </div>
            {searchFor === s.id && (
              <div className="space-y-1.5">
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search recipient by name or phone"
                  className="h-8 text-xs"
                />
                {searching && <p className="text-[11px] text-muted-foreground">Searching…</p>}
                {!searching && search.trim().length >= 3 && !matches.length && (
                  <p className="text-[11px] text-muted-foreground">No match for "{search.trim()}".</p>
                )}
                <div className="space-y-1">
                  {matches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setPayees((p) => ({
                          ...p,
                          [s.id]: { userId: m.id, name: m.full_name || '', phone: m.phone || '' },
                        }));
                        setSearchFor(null);
                        setSearch('');
                        setMatches([]);
                      }}
                      className="w-full rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-accent"
                    >
                      <span className="font-medium text-foreground">{m.full_name || 'Unnamed'}</span>
                      <span className="text-muted-foreground"> · {m.phone || '—'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Input
              value={payeeNotes[s.id] ?? ''}
              onChange={(e) => setPayeeNotes((p) => ({ ...p, [s.id]: e.target.value }))}
              placeholder="Recipient note (optional) — e.g. carpenter for shelving"
              className="h-8 text-xs"
            />
          </div>
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
        </CfoApprovalGate>
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

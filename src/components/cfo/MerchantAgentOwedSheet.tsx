import { useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  Smartphone,
  Landmark,
  ChevronRight,
  ArrowUpRight,
  ArrowDownLeft,
  AlertTriangle,
} from 'lucide-react';
import { useMerchantAgentMoneyOwed } from '@/hooks/useMerchantAgentMoneyOwed';
import {
  useMerchantAgentMovements,
  useBayoMercyMovements,
  useUnregisteredRecipientTransfers,
} from '@/hooks/useMerchantAgentMovements';

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

const day = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('en-GB', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

const channelLabel = (c: string) =>
  c === 'mtn_momo' ? 'MTN' : c === 'airtel_money' ? 'Airtel' : c || 'Line';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function MovementRow({
  direction,
  amount,
  at,
  party,
  reference,
  note,
  tag,
}: {
  direction: 'in' | 'out';
  amount: number;
  at: string | null;
  party: string | null;
  reference: string | null;
  note: string | null;
  tag?: string | null;
}) {
  const out = direction === 'out';
  return (
    <div className="flex items-start gap-3 border-t border-border/60 py-2 first:border-t-0">
      <div
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          out ? 'bg-orange-500/10 text-orange-600' : 'bg-emerald-500/10 text-emerald-600'
        }`}
      >
        {out ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownLeft className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-xs font-medium">
            {out ? 'Sent out' : 'Came back'}
            {party ? ` · ${party}` : ''}
          </p>
          <p
            className={`shrink-0 font-mono text-xs font-bold tabular-nums ${
              out ? 'text-orange-600' : 'text-emerald-600'
            }`}
          >
            {out ? '-' : '+'}
            {fmt(amount)}
          </p>
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {day(at)}
          {tag ? ` · ${tag}` : ''}
          {reference ? ` · Ref ${reference}` : ''}
        </p>
        {note ? <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground/80">{note}</p> : null}
      </div>
    </div>
  );
}

/**
 * Read-only drilldown behind the two Money We Owe lines: money sent to merchant
 * agents and money sent to the Bayo Mercy bank account, plus a flag list of
 * money-out transfers whose recipient is not a registered merchant agent.
 * Every figure comes from the Financial Ops email extractor; nothing is written.
 */
export function MerchantAgentOwedSheet({ open, onOpenChange }: Props) {
  const { data, isLoading, error } = useMerchantAgentMoneyOwed(open);
  const { data: movements, isLoading: movLoading } = useMerchantAgentMovements(open);
  const { data: bayoRows, isLoading: bayoLoading } = useBayoMercyMovements(open);
  const { data: flagged, isLoading: flagLoading } = useUnregisteredRecipientTransfers(open);
  const [expanded, setExpanded] = useState<string | null>(null);

  const agents = (data?.agents ?? []).filter((a) => a.still_held > 0 || a.email_sent_total > 0);

  const byDesk = useMemo(() => {
    const map = new Map<string, typeof movements>();
    (movements ?? []).forEach((m) => {
      const list = (map.get(m.desk_id) ?? []) as any[];
      list.push(m);
      map.set(m.desk_id, list as any);
    });
    return map;
  }, [movements]);

  const bayoIn = (bayoRows ?? []).filter((r) => r.direction === 'in').reduce((s, r) => s + r.amount, 0);
  const bayoOut = (bayoRows ?? []).filter((r) => r.direction === 'out').reduce((s, r) => s + r.amount, 0);
  const flaggedCount = flagged?.transfers.length ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="h-full w-full max-w-none overflow-y-auto p-0 sm:max-w-none">
        <div className="mx-auto h-full w-full max-w-7xl px-5 py-5">
          <SheetHeader className="text-left">
            <SheetTitle className="text-2xl">Money sitting with other people</SheetTitle>
            <SheetDescription className="text-sm">
              Built from the extracted MTN, Airtel and bank emails in Financial Ops. Read-only.
            </SheetDescription>
          </SheetHeader>

          {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="py-10 text-sm text-destructive">
            Could not load this breakdown. You may not have permission to view it.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] text-muted-foreground">Sent to merchant agents</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums">
                  {fmt(data?.merchantAgentTotal ?? 0)}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{agents.length} desk(s)</p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] text-muted-foreground">Sent to Bayo Mercy</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums">
                  {fmt(data?.bayoMercyTotal ?? 0)}
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {(bayoRows ?? []).length} movement(s)
                </p>
              </div>
              <div className="rounded-xl border border-orange-500/40 bg-orange-50/60 p-3 dark:bg-orange-950/20">
                <p className="text-[11px] text-orange-700 dark:text-orange-400">Total we owe</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums text-orange-700 dark:text-orange-400">
                  {fmt(data?.total ?? 0)}
                </p>
              </div>
            </div>

            {flaggedCount > 0 && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/50 bg-amber-50/70 p-3 dark:bg-amber-950/20">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  {flaggedCount} transfer(s) worth {fmt(flagged?.total ?? 0)} went to numbers that are not
                  registered merchant agents. They are not counted as owed — see the Flagged tab.
                </p>
              </div>
            )}

            <Tabs defaultValue="agents">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="agents" className="text-xs">
                  Merchant agents
                </TabsTrigger>
                <TabsTrigger value="bayo" className="text-xs">
                  Bayo Mercy
                </TabsTrigger>
                <TabsTrigger value="flagged" className="text-xs">
                  Flagged{flaggedCount > 0 ? ` (${flaggedCount})` : ''}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="agents" className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-emerald-600" />
                  <p className="text-xs font-semibold">Merchant agents ({agents.length})</p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Sent to their number in the emails, less what they sent back, less payouts they have
                  already completed for us. Tap a desk to see every transfer.
                </p>

                {agents.length === 0 ? (
                  <p className="py-6 text-xs text-muted-foreground">
                    No merchant agent movements found in the extracted emails.
                  </p>
                ) : (
                  agents.map((a) => {
                    const rows = (byDesk.get(a.desk_id) ?? []) as any[];
                    const isOpen = expanded === a.desk_id;
                    return (
                      <div key={a.desk_id} className="rounded-xl border border-border">
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : a.desk_id)}
                          className="w-full p-3 text-left transition-colors hover:bg-muted/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold">{a.agent_name}</p>
                              <p className="truncate text-[11px] text-muted-foreground">
                                {a.phone || 'No number on record'}
                                {a.label ? ` · ${a.label}` : ''}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <p className="font-mono text-sm font-bold tabular-nums text-orange-600">
                                {fmt(a.still_held)}
                              </p>
                              <ChevronRight
                                className={`h-4 w-4 text-muted-foreground transition-transform ${
                                  isOpen ? 'rotate-90' : ''
                                }`}
                              />
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                            <div>
                              <span className="text-muted-foreground">Sent to them</span>
                              <p className="font-mono tabular-nums">{fmt(a.email_sent_total)}</p>
                              <span className="text-muted-foreground">{a.email_sent_count} transfer(s)</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Sent back</span>
                              <p className="font-mono tabular-nums">{fmt(a.email_returned_total)}</p>
                              <span className="text-muted-foreground">
                                {a.email_returned_count} transfer(s)
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Paid out for us</span>
                              <p className="font-mono tabular-nums">{fmt(a.paid_out_total)}</p>
                              <span className="text-muted-foreground">Last sent {day(a.last_sent_at)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Claimed, not completed</span>
                              <p className="font-mono tabular-nums">{fmt(a.claimed_pending_total)}</p>
                              <span className="text-muted-foreground">
                                {a.claimed_pending_count} request(s)
                              </span>
                            </div>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="border-t border-border bg-muted/20 px-3 py-2">
                            <div className="mb-1 flex items-center justify-between">
                              <p className="text-[11px] font-semibold">Every transfer on this desk</p>
                              <Badge variant="outline" className="text-[10px]">
                                {rows.length} movement(s)
                              </Badge>
                            </div>
                            {movLoading ? (
                              <div className="flex justify-center py-4">
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              </div>
                            ) : rows.length === 0 ? (
                              <p className="py-3 text-[11px] text-muted-foreground">
                                No matched email transfers for this desk.
                              </p>
                            ) : (
                              <div className="max-h-72 overflow-y-auto pr-1">
                                {rows.map((m) => (
                                  <MovementRow
                                    key={`${m.id}-${m.desk_id}`}
                                    direction={m.direction}
                                    amount={m.amount}
                                    at={m.at}
                                    party={m.counterparty}
                                    reference={m.transaction_id}
                                    note={m.snippet}
                                    tag={channelLabel(m.channel)}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </TabsContent>

              <TabsContent value="bayo" className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Landmark className="h-4 w-4 text-sky-600" />
                  <p className="text-xs font-semibold">Bayo Mercy bank account</p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Credits in less debits out on the account, from the extracted bank emails since the
                  reconciliation reset.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-lg border border-border p-2">
                    <p className="text-[10px] text-muted-foreground">Money in</p>
                    <p className="font-mono text-xs font-bold tabular-nums text-emerald-600">{fmt(bayoIn)}</p>
                  </div>
                  <div className="rounded-lg border border-border p-2">
                    <p className="text-[10px] text-muted-foreground">Money out</p>
                    <p className="font-mono text-xs font-bold tabular-nums text-orange-600">{fmt(bayoOut)}</p>
                  </div>
                  <div className="rounded-lg border border-border p-2">
                    <p className="text-[10px] text-muted-foreground">Still held</p>
                    <p className="font-mono text-xs font-bold tabular-nums">
                      {fmt(data?.bayoMercyTotal ?? 0)}
                    </p>
                  </div>
                </div>

                {bayoLoading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : (bayoRows ?? []).length === 0 ? (
                  <p className="py-6 text-xs text-muted-foreground">
                    No qualifying bank movements found in the extracted emails.
                  </p>
                ) : (
                  <div className="rounded-xl border border-border px-3 py-2">
                    {(bayoRows ?? []).map((r) => (
                      <MovementRow
                        key={r.id}
                        direction={r.direction}
                        amount={r.amount}
                        at={r.at}
                        party={r.counterparty}
                        reference={r.transaction_id}
                        note={r.note}
                        tag="Bank"
                      />
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="flagged" className="mt-3 space-y-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <p className="text-xs font-semibold">Sent to someone who is not a merchant agent</p>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Money-out transfers in the emails whose receiving number is not on any active merchant
                  agent desk. Flagged for review only — they are not counted as money we owe.
                </p>

                {flagLoading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : flaggedCount === 0 ? (
                  <p className="py-6 text-xs text-muted-foreground">
                    Every money-out transfer went to a registered merchant agent.
                  </p>
                ) : (
                  <>
                    <div className="rounded-xl border border-amber-500/40 bg-amber-50/50 p-3 dark:bg-amber-950/20">
                      <p className="text-[10px] text-amber-800 dark:text-amber-300">Total flagged</p>
                      <p className="font-mono text-sm font-bold tabular-nums text-amber-800 dark:text-amber-300">
                        {fmt(flagged?.total ?? 0)}
                      </p>
                    </div>
                    <div className="max-h-96 overflow-y-auto rounded-xl border border-border px-3 py-2">
                      {(flagged?.transfers ?? []).map((t) => (
                        <MovementRow
                          key={t.id}
                          direction="out"
                          amount={t.amount}
                          at={t.at}
                          party={
                            t.profile_name
                              ? `${t.profile_name} (not a merchant agent)`
                              : t.counterparty || t.recipient_phone || 'Unknown recipient'
                          }
                          reference={t.transaction_id}
                          note={t.snippet}
                          tag={`${channelLabel(t.channel)}${t.recipient_phone ? ` · ${t.recipient_phone}` : ''}`}
                        />
                      ))}
                    </div>
                  </>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

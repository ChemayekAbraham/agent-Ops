import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { BarChart3, ChevronDown, ChevronUp, PhoneCall, Timer, TrendingUp } from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from 'recharts';

/**
 * Read-only conversion-queue analytics for the Promissory Notes page.
 *
 * Every figure comes from the SECURITY DEFINER, read-only RPC
 * `promissory_ops_analytics(p_days)`: contact attempts (manual Partner Ops log
 * plus automated reminder SMS), promise conversion, overdue aging and
 * fulfilment rates by partner and agent. Nothing is computed against money
 * here and nothing is written.
 */

type Json = Record<string, unknown>;

interface Totals {
  promises: number;
  fulfilled: number;
  open: number;
  promised_value: number;
  fulfilled_value: number;
  open_value: number;
  overdue_notes: number;
  overdue_value: number;
  with_due: number;
  on_time: number;
  avg_days_to_fulfil: number | null;
}

interface ContactBlock {
  manual_contacts: number;
  notes_contacted: number;
  open_notes_contacted: number;
  open_notes_never_contacted: number;
  open_value_never_contacted: number;
  by_channel: { channel: string; attempts: number }[];
  automated_sms: { source: string; sent: number; delivered: number; failed: number }[];
  daily: { day: string; manual: number; automated: number }[];
}

interface ConversionBlock {
  contacted_fulfilled: number;
  contacted_total: number;
  uncontacted_fulfilled: number;
  uncontacted_total: number;
  avg_days_first_contact_to_fulfil: number | null;
  weekly: {
    week: string;
    promised_count: number;
    promised_value: number;
    fulfilled_count: number;
    fulfilled_value: number;
  }[];
}

interface AgingRow {
  bucket: string;
  sort: number;
  notes: number;
  value: number;
  contacted: number;
}

interface PartnerRow {
  partner_key: string;
  partner_name: string | null;
  promises: number;
  fulfilled: number;
  fulfilled_value: number;
  open_notes: number;
  open_value: number;
  with_due: number;
  on_time: number;
  avg_days_late: number | null;
  avg_days_to_fulfil: number | null;
  contacts: number;
  last_contact_at: string | null;
  max_days_overdue: number | null;
  reminders_sent: number;
}

interface AgentRow {
  agent_id: string;
  agent_name: string;
  promises: number;
  fulfilled: number;
  fulfilled_value: number;
  open_notes: number;
  open_value: number;
  with_due: number;
  on_time: number;
  avg_days_to_fulfil: number | null;
  contacts: number;
  overdue_notes: number;
  overdue_value: number;
  reminders_sent: number;
}

interface AnalyticsPayload {
  generated_at: string;
  as_of_date: string;
  window_days: number;
  totals: Totals;
  contact: ContactBlock;
  conversion: ConversionBlock;
  aging: AgingRow[];
  by_partner: PartnerRow[];
  by_agent: AgentRow[];
}

const WINDOWS = [30, 90, 180, 365] as const;

const sourceLabels: Record<string, string> = {
  partner_promissory_note_reminder: 'Partner reminder (Mon/Wed/Fri)',
  proxy_promissory_note_reminder: 'Agent reminder (Mon/Wed/Fri)',
  promissory_fulfilment_due: 'Promised-day notice',
};

const channelLabels: Record<string, string> = {
  call: 'Phone call',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  visit: 'In person',
  other: 'Other',
  unrecorded: 'Not recorded',
};

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);
const shortDay = (d: string) => d.slice(5);
const days = (v: number | null) => (v === null || v === undefined ? '—' : `${v} day${Math.abs(v) === 1 ? '' : 's'}`);

export function PromissoryOpsAnalytics() {
  const [open, setOpen] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(90);
  const [tab, setTab] = useState<'partners' | 'agents'>('partners');

  const { data, isLoading, error } = useQuery({
    queryKey: ['promissory-ops-analytics', windowDays],
    enabled: open,
    staleTime: 60_000,
    queryFn: async (): Promise<AnalyticsPayload> => {
      const { data, error } = await supabase.rpc('promissory_ops_analytics', { p_days: windowDays });
      if (error) throw error;
      return data as unknown as AnalyticsPayload;
    },
  });

  const totals = data?.totals;

  const dailyChart = useMemo(
    () =>
      (data?.contact.daily ?? []).map((d) => ({
        day: shortDay(d.day),
        Manual: d.manual,
        Automated: d.automated,
      })),
    [data],
  );

  const weeklyChart = useMemo(
    () =>
      (data?.conversion.weekly ?? []).map((w) => ({
        week: shortDay(w.week),
        Promised: w.promised_count,
        Fulfilled: w.fulfilled_count,
        PromisedValue: w.promised_value,
        FulfilledValue: w.fulfilled_value,
      })),
    [data],
  );

  const agingChart = useMemo(
    () =>
      (data?.aging ?? [])
        .slice()
        .sort((a, b) => a.sort - b.sort)
        .map((a) => ({ bucket: a.bucket, Promises: a.notes, Value: a.value })),
    [data],
  );

  const partners = useMemo(
    () => (data?.by_partner ?? []).filter((p) => p.promises > 0).slice(0, 40),
    [data],
  );
  const agents = useMemo(() => (data?.by_agent ?? []).slice(0, 40), [data]);

  return (
    <Card className="border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Conversion analytics</span>
          <Badge variant="secondary" className="text-[10px]">Read-only</Badge>
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <CardContent className="space-y-6 border-t border-border/60 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Window</span>
            {WINDOWS.map((w) => (
              <Button
                key={w}
                size="sm"
                variant={windowDays === w ? 'default' : 'outline'}
                className="h-7 px-2 text-xs"
                onClick={() => setWindowDays(w)}
              >
                {w} days
              </Button>
            ))}
            {data && (
              <span className="ml-auto text-[11px] text-muted-foreground">
                As at {data.as_of_date} (Kampala)
              </span>
            )}
          </div>

          {isLoading && <p className="text-sm text-muted-foreground">Loading analytics…</p>}
          {error && (
            <p className="text-sm text-destructive">
              Analytics unavailable: {(error as Error).message}
            </p>
          )}

          {data && totals && (
            <>
              {/* Headline */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat
                  icon={<TrendingUp className="h-4 w-4" />}
                  label="Fulfilment rate"
                  value={`${pct(totals.fulfilled, totals.promises)}%`}
                  sub={`${totals.fulfilled.toLocaleString()} of ${totals.promises.toLocaleString()} promises · ${pct(totals.fulfilled_value, totals.promised_value)}% by value`}
                />
                <Stat
                  icon={<Timer className="h-4 w-4" />}
                  label="On-time fulfilment"
                  value={`${pct(totals.on_time, totals.with_due)}%`}
                  sub={`${totals.on_time.toLocaleString()} of ${totals.with_due.toLocaleString()} with a promised date · avg wait ${days(totals.avg_days_to_fulfil)}`}
                />
                <Stat
                  icon={<PhoneCall className="h-4 w-4" />}
                  label="Contact attempts"
                  value={(data.contact.manual_contacts + data.contact.automated_sms.reduce((s, a) => s + a.sent, 0)).toLocaleString()}
                  sub={`${data.contact.manual_contacts.toLocaleString()} recorded by Partner Ops · ${data.contact.automated_sms.reduce((s, a) => s + a.sent, 0).toLocaleString()} automated reminders`}
                />
                <Stat
                  icon={<BarChart3 className="h-4 w-4" />}
                  label="Still open"
                  value={formatUGX(totals.open_value)}
                  sub={`${totals.open.toLocaleString()} promises · ${totals.overdue_notes.toLocaleString()} past the promised date (${formatUGX(totals.overdue_value)})`}
                />
              </div>

              {/* Untouched warning */}
              {data.contact.open_notes_never_contacted > 0 && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  {data.contact.open_notes_never_contacted.toLocaleString()} open promises worth{' '}
                  {formatUGX(data.contact.open_value_never_contacted)} have no recorded Partner Ops contact yet.
                </div>
              )}

              {/* Contact attempts over time */}
              <Section title="Contact attempts per day">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyChart}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area type="monotone" dataKey="Automated" stroke="hsl(var(--primary))" fill="hsl(var(--primary) / 0.15)" />
                      <Line type="monotone" dataKey="Manual" stroke="hsl(var(--foreground))" dot={false} strokeWidth={2} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <MiniTable
                    heading="By channel (Partner Ops)"
                    rows={
                      data.contact.by_channel.length
                        ? data.contact.by_channel.map((c) => [channelLabels[c.channel] ?? c.channel, c.attempts.toLocaleString()])
                        : [['No contact recorded yet', '—']]
                    }
                  />
                  <MiniTable
                    heading="Automated reminders"
                    rows={
                      data.contact.automated_sms.length
                        ? data.contact.automated_sms.map((s) => [
                            sourceLabels[s.source] ?? s.source,
                            `${s.sent.toLocaleString()} sent · ${s.delivered.toLocaleString()} delivered${s.failed ? ` · ${s.failed} failed` : ''}`,
                          ])
                        : [['No reminders in this window', '—']]
                    }
                  />
                </div>
              </Section>

              {/* Conversion */}
              <Section title="Promise conversion">
                <div className="grid gap-3 sm:grid-cols-3">
                  <MiniStat
                    label="Contacted promises fulfilled"
                    value={`${pct(data.conversion.contacted_fulfilled, data.conversion.contacted_total)}%`}
                    sub={`${data.conversion.contacted_fulfilled.toLocaleString()} of ${data.conversion.contacted_total.toLocaleString()}`}
                  />
                  <MiniStat
                    label="Never contacted, fulfilled anyway"
                    value={`${pct(data.conversion.uncontacted_fulfilled, data.conversion.uncontacted_total)}%`}
                    sub={`${data.conversion.uncontacted_fulfilled.toLocaleString()} of ${data.conversion.uncontacted_total.toLocaleString()}`}
                  />
                  <MiniStat
                    label="First contact to fulfilment"
                    value={days(data.conversion.avg_days_first_contact_to_fulfil)}
                    sub="Average across contacted promises"
                  />
                </div>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={weeklyChart}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area type="monotone" dataKey="Promised" stroke="hsl(var(--muted-foreground))" fill="hsl(var(--muted-foreground) / 0.12)" />
                      <Line type="monotone" dataKey="Fulfilled" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Section>

              {/* Aging */}
              <Section title="Overdue aging (open promises)">
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={agingChart}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                      <Tooltip formatter={(v: number, k) => (k === 'Value' ? formatUGX(v) : v.toLocaleString())} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="Promises" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr className="border-b border-border/60">
                        <th className="py-1.5 text-left font-medium">Bucket</th>
                        <th className="py-1.5 text-right font-medium">Promises</th>
                        <th className="py-1.5 text-right font-medium">Value</th>
                        <th className="py-1.5 text-right font-medium">Contacted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agingRows(data.aging).map((r) => (
                        <tr key={r.bucket} className="border-b border-border/30">
                          <td className="py-1.5">{r.bucket}</td>
                          <td className="py-1.5 text-right">{r.notes.toLocaleString()}</td>
                          <td className="py-1.5 text-right">{formatUGX(r.value)}</td>
                          <td className="py-1.5 text-right">{r.contacted.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              {/* Per partner / per agent */}
              <Section title="Fulfilment by partner and agent">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={tab === 'partners' ? 'default' : 'outline'}
                    className="h-7 px-2 text-xs"
                    onClick={() => setTab('partners')}
                  >
                    Partners ({data.by_partner.length.toLocaleString()})
                  </Button>
                  <Button
                    size="sm"
                    variant={tab === 'agents' ? 'default' : 'outline'}
                    className="h-7 px-2 text-xs"
                    onClick={() => setTab('agents')}
                  >
                    Agents ({data.by_agent.length.toLocaleString()})
                  </Button>
                </div>

                <div className="overflow-x-auto">
                  {tab === 'partners' ? (
                    <table className="w-full min-w-[720px] text-xs">
                      <thead className="text-muted-foreground">
                        <tr className="border-b border-border/60">
                          <th className="py-1.5 text-left font-medium">Partner</th>
                          <th className="py-1.5 text-right font-medium">Promises</th>
                          <th className="py-1.5 text-right font-medium">Fulfilled</th>
                          <th className="py-1.5 text-right font-medium">On time</th>
                          <th className="py-1.5 text-right font-medium">Open value</th>
                          <th className="py-1.5 text-right font-medium">Days late</th>
                          <th className="py-1.5 text-right font-medium">Contacts</th>
                          <th className="py-1.5 text-right font-medium">Reminders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partners.map((p) => (
                          <tr key={p.partner_key} className="border-b border-border/30">
                            <td className="py-1.5">{p.partner_name || p.partner_key}</td>
                            <td className="py-1.5 text-right">{p.promises.toLocaleString()}</td>
                            <td className="py-1.5 text-right">
                              {p.fulfilled.toLocaleString()} ({pct(p.fulfilled, p.promises)}%)
                            </td>
                            <td className="py-1.5 text-right">
                              {p.with_due > 0 ? `${pct(p.on_time, p.with_due)}%` : '—'}
                            </td>
                            <td className="py-1.5 text-right">{formatUGX(p.open_value)}</td>
                            <td className="py-1.5 text-right">{p.avg_days_late === null ? '—' : p.avg_days_late}</td>
                            <td className="py-1.5 text-right">{p.contacts.toLocaleString()}</td>
                            <td className="py-1.5 text-right">{p.reminders_sent.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full min-w-[720px] text-xs">
                      <thead className="text-muted-foreground">
                        <tr className="border-b border-border/60">
                          <th className="py-1.5 text-left font-medium">Agent</th>
                          <th className="py-1.5 text-right font-medium">Promises</th>
                          <th className="py-1.5 text-right font-medium">Fulfilled</th>
                          <th className="py-1.5 text-right font-medium">On time</th>
                          <th className="py-1.5 text-right font-medium">Open value</th>
                          <th className="py-1.5 text-right font-medium">Overdue</th>
                          <th className="py-1.5 text-right font-medium">Avg wait</th>
                          <th className="py-1.5 text-right font-medium">Reminders</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map((a) => (
                          <tr key={a.agent_id} className="border-b border-border/30">
                            <td className="py-1.5">{a.agent_name || a.agent_id.slice(0, 8)}</td>
                            <td className="py-1.5 text-right">{a.promises.toLocaleString()}</td>
                            <td className="py-1.5 text-right">
                              {a.fulfilled.toLocaleString()} ({pct(a.fulfilled, a.promises)}%)
                            </td>
                            <td className="py-1.5 text-right">
                              {a.with_due > 0 ? `${pct(a.on_time, a.with_due)}%` : '—'}
                            </td>
                            <td className="py-1.5 text-right">{formatUGX(a.open_value)}</td>
                            <td className="py-1.5 text-right">
                              {a.overdue_notes > 0 ? `${a.overdue_notes} · ${formatUGX(a.overdue_value)}` : '—'}
                            </td>
                            <td className="py-1.5 text-right">{days(a.avg_days_to_fulfil)}</td>
                            <td className="py-1.5 text-right">{a.reminders_sent.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Showing the 40 largest by open value. Reminders count automated SMS in this window.
                </p>
              </Section>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function agingRows(rows: AgingRow[]) {
  return rows.slice().sort((a, b) => a.sort - b.sort);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-md border border-border/50 p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold">{value}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
    </div>
  );
}

function MiniTable({ heading, rows }: { heading: string; rows: [string, string][] }) {
  return (
    <div className="rounded-md border border-border/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{heading}</p>
      <ul className="mt-2 space-y-1">
        {rows.map(([k, v]) => (
          <li key={k} className={cn('flex items-center justify-between gap-3 text-xs')}>
            <span className="text-muted-foreground">{k}</span>
            <span className="font-medium">{v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

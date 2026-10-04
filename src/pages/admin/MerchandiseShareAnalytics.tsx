import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowLeft, BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface ShareOpenRow {
  id: string;
  catalog_id: string | null;
  item_name: string | null;
  is_bot: boolean;
  source: string | null;
  referrer: string | null;
  created_at: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const CHANNEL_MATCHERS: Array<{ label: string; test: RegExp }> = [
  { label: 'WhatsApp', test: /whats\s*app|wa\.me|whatsapp/i },
  { label: 'Facebook', test: /facebook|fb\b|messenger|fbclid/i },
  { label: 'Telegram', test: /telegram|t\.me/i },
  { label: 'X / Twitter', test: /twitter|t\.co|(^|[^a-z])x(\.com)?([^a-z]|$)/i },
  { label: 'Instagram', test: /instagram|ig\b/i },
  { label: 'TikTok', test: /tiktok/i },
  { label: 'SMS', test: /sms|text/i },
  { label: 'Email', test: /mail|gmail|outlook/i },
];

/** Classify a share open into a sharing channel from its source tag and referrer. */
function classifyChannel(row: ShareOpenRow): string {
  const hay = `${row.source ?? ''} ${row.referrer ?? ''}`.trim();
  if (!hay) return 'Direct / unknown';
  const hit = CHANNEL_MATCHERS.find((c) => c.test.test(hay));
  return hit ? hit.label : (row.source || 'Other');
}

export default function MerchandiseShareAnalytics() {
  const today = new Date();
  const past = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
  const [from, setFrom] = useState(isoDay(past));
  const [to, setTo] = useState(isoDay(today));
  const [channelFilter, setChannelFilter] = useState<'all' | 'whatsapp' | 'others'>('all');
  const [itemFilter, setItemFilter] = useState<string>('all');

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['merchandise-share-opens', from, to],
    queryFn: async () => {
      const db = supabase as any;
      const { data, error } = await db
        .from('merchandise_share_opens')
        .select('id, catalog_id, item_name, is_bot, source, referrer, created_at')
        .gte('created_at', `${from}T00:00:00.000Z`)
        .lte('created_at', `${to}T23:59:59.999Z`)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as ShareOpenRow[];
    },
  });

  const allRows = data ?? [];

  const itemOptions = useMemo(() => {
    const map = new Map<string, string>();
    allRows.forEach((r) => {
      const key = r.catalog_id ?? r.item_name ?? 'unknown';
      if (!map.has(key)) map.set(key, r.item_name || key);
    });
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((r) => {
        const channel = classifyChannel(r);
        if (channelFilter === 'whatsapp' && channel !== 'WhatsApp') return false;
        if (channelFilter === 'others' && channel === 'WhatsApp') return false;
        if (itemFilter !== 'all' && (r.catalog_id ?? r.item_name ?? 'unknown') !== itemFilter) return false;
        return true;
      }),
    [allRows, channelFilter, itemFilter],
  );

  const whatsappSplit = useMemo(() => {
    const acc = {
      whatsapp: { opens: 0, clicks: 0, previews: 0 },
      others: { opens: 0, clicks: 0, previews: 0 },
    };
    rows.forEach((r) => {
      const bucket = classifyChannel(r) === 'WhatsApp' ? acc.whatsapp : acc.others;
      bucket.opens += 1;
      if (r.is_bot) bucket.previews += 1;
      else bucket.clicks += 1;
    });
    return acc;
  }, [rows]);

  const totals = useMemo(() => {
    const clicks = rows.filter((r) => !r.is_bot).length;
    const previews = rows.length - clicks;
    const items = new Set(rows.map((r) => r.catalog_id ?? r.item_name ?? 'unknown')).size;
    return { opens: rows.length, clicks, previews, items };
  }, [rows]);

  const byItem = useMemo(() => {
    const map = new Map<
      string,
      { id: string; name: string; clicks: number; previews: number; waClicks: number; waPreviews: number }
    >();
    rows.forEach((r) => {
      const key = r.catalog_id ?? r.item_name ?? 'unknown';
      const entry =
        map.get(key) ??
        { id: key, name: r.item_name || 'Unknown item', clicks: 0, previews: 0, waClicks: 0, waPreviews: 0 };
      const isWa = classifyChannel(r) === 'WhatsApp';
      if (r.is_bot) {
        entry.previews += 1;
        if (isWa) entry.waPreviews += 1;
      } else {
        entry.clicks += 1;
        if (isWa) entry.waClicks += 1;
      }
      map.set(key, entry);
    });
    return Array.from(map.values()).sort((a, b) => b.clicks + b.previews - (a.clicks + a.previews));
  }, [rows]);

  const byDay = useMemo(() => {
    const map = new Map<string, { day: string; clicks: number; previews: number }>();
    rows.forEach((r) => {
      const day = r.created_at.slice(0, 10);
      const entry = map.get(day) ?? { day, clicks: 0, previews: 0 };
      if (r.is_bot) entry.previews += 1;
      else entry.clicks += 1;
      map.set(day, entry);
    });
    return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [rows]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { channel: string; clicks: number; previews: number; items: Set<string> }>();
    rows.forEach((r) => {
      const channel = classifyChannel(r);
      const entry = map.get(channel) ?? { channel, clicks: 0, previews: 0, items: new Set<string>() };
      if (r.is_bot) entry.previews += 1;
      else entry.clicks += 1;
      entry.items.add(r.catalog_id ?? r.item_name ?? 'unknown');
      map.set(channel, entry);
    });
    return Array.from(map.values())
      .map((e) => ({ channel: e.channel, clicks: e.clicks, previews: e.previews, items: e.items.size }))
      .sort((a, b) => b.clicks + b.previews - (a.clicks + a.previews));
  }, [rows]);

  const setPreset = (days: number) => {
    const end = new Date();
    const start = new Date(end.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
    setFrom(isoDay(start));
    setTo(isoDay(end));
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Button asChild variant="ghost" size="sm" className="-ml-2 mb-1 h-8 text-xs">
              <Link to="/cmo/dashboard?tab=merchandise">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Merchandise
              </Link>
            </Button>
            <h1 className="flex items-center gap-2 text-xl font-bold">
              <BarChart3 className="h-5 w-5 text-primary" /> Merchandise Share Analytics
            </h1>
            <p className="text-xs text-muted-foreground">
              Opens of shared merchandise links, split by real clicks and link-preview crawlers.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 pt-6">
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPreset(7)}>7d</Button>
              <Button variant="outline" size="sm" onClick={() => setPreset(30)}>30d</Button>
              <Button variant="outline" size="sm" onClick={() => setPreset(90)}>90d</Button>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Sharing source</Label>
              <select
                value={channelFilter}
                onChange={(e) => setChannelFilter(e.target.value as 'all' | 'whatsapp' | 'others')}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="all">All sources</option>
                <option value="whatsapp">WhatsApp only</option>
                <option value="others">Other sources</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Item</Label>
              <select
                value={itemFilter}
                onChange={(e) => setItemFilter(e.target.value)}
                className="h-9 max-w-[220px] rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="all">All items</option>
                {itemOptions.map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2">
          {([
            { label: 'WhatsApp', bucket: whatsappSplit.whatsapp },
            { label: 'Other sources', bucket: whatsappSplit.others },
          ] as const).map((s) => (
            <Card key={s.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{s.label}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-6 pb-6">
                <div>
                  <p className="text-xs text-muted-foreground">Opens</p>
                  <p className="text-xl font-bold">{s.bucket.opens.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Clicks</p>
                  <p className="text-xl font-bold">{s.bucket.clicks.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Previews</p>
                  <p className="text-xl font-bold text-muted-foreground">{s.bucket.previews.toLocaleString()}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: 'Total opens', value: totals.opens },
            { label: 'Real clicks', value: totals.clicks },
            { label: 'Link previews', value: totals.previews },
            { label: 'Items shared', value: totals.items },
          ].map((t) => (
            <Card key={t.label}>
              <CardContent className="pt-6">
                <p className="text-xs text-muted-foreground">{t.label}</p>
                <p className="text-2xl font-bold">{t.value.toLocaleString()}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Clicks per day</CardTitle>
          </CardHeader>
          <CardContent className="h-64">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : byDay.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No share opens in this range.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byDay}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="clicks" name="Clicks" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="previews" name="Previews" fill="hsl(var(--muted-foreground))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">By item</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Item ID</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">WhatsApp clicks</TableHead>
                  <TableHead className="text-right">Previews</TableHead>
                  <TableHead className="text-right">WhatsApp previews</TableHead>
                  <TableHead className="text-right">Total opens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byItem.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No data
                    </TableCell>
                  </TableRow>
                )}
                {byItem.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">{i.name}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{i.id}</TableCell>
                    <TableCell className="text-right">{i.clicks}</TableCell>
                    <TableCell className="text-right">{i.waClicks}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{i.previews}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{i.waPreviews}</TableCell>
                    <TableCell className="text-right font-semibold">{i.clicks + i.previews}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">By sharing source</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">Previews</TableHead>
                  <TableHead className="text-right">Items shared</TableHead>
                  <TableHead className="text-right">Total opens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byChannel.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                      No data
                    </TableCell>
                  </TableRow>
                )}
                {byChannel.map((c) => (
                  <TableRow key={c.channel}>
                    <TableCell className="font-medium">
                      {c.channel}
                      {c.channel === 'WhatsApp' && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">primary</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{c.clicks}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{c.previews}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{c.items}</TableCell>
                    <TableCell className="text-right font-semibold">{c.clicks + c.previews}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent opens</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Item ID</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Referrer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 50).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(r.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">{r.item_name || '—'}</TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {r.catalog_id || '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.is_bot ? 'outline' : 'default'} className="text-[10px]">
                        {r.is_bot ? 'Preview' : 'Click'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {classifyChannel(r)}
                      {r.source ? <span className="text-muted-foreground"> ({r.source})</span> : null}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {r.referrer || '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No share opens recorded in this range
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Copy } from 'lucide-react';
import { toast } from 'sonner';
import { getPublicOrigin } from '@/lib/getPublicOrigin';

type Link = { id: string; kind: string; short_code: string; destination_path: string; referrer_label: string };
type Click = {
  id: string; link_id: string; created_at: string; ip_address: string | null; user_agent: string | null;
  device_class: string | null; device_model: string | null; os: string | null; os_version: string | null;
  browser: string | null; browser_version: string | null; is_bot: boolean; country: string | null; city: string | null;
  user_id: string | null; came_in_at: string | null; is_new_registration: boolean | null;
};

const KIND_LABEL: Record<string, string> = { partnership: 'Partnership', tenant: 'Tenants', general: 'General' };

export function CustomerLeadsPanel() {
  const [filter, setFilter] = useState<string>('all');
  const links = useQuery({
    queryKey: ['lead-links'],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)('lead_links').select('*').order('kind');
      if (error) throw error;
      return data as Link[];
    },
  });
  const clicks = useQuery({
    queryKey: ['lead-link-clicks'],
    queryFn: async () => {
      const { data, error } = await (supabase.from as any)('lead_link_clicks').select('*').order('created_at', { ascending: false }).limit(1000);
      if (error) throw error;
      return data as Click[];
    },
  });
  const userIds = useMemo(() => [...new Set((clicks.data ?? []).map((c) => c.user_id).filter(Boolean))] as string[], [clicks.data]);
  const names = useQuery({
    queryKey: ['lead-link-users', userIds],
    enabled: userIds.length > 0,
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', userIds);
      return Object.fromEntries((data ?? []).map((p: any) => [p.id, p]));
    },
  });

  const origin = getPublicOrigin();
  const all = clicks.data ?? [];
  const shown = filter === 'all' ? all : all.filter((c) => c.link_id === filter);
  const stats = (rows: Click[]) => {
    const human = rows.filter((c) => !c.is_bot);
    return {
      clicks: human.length,
      unique: new Set(human.map((c) => `${c.ip_address}|${c.user_agent}`)).size,
      cameIn: rows.filter((c) => c.user_id).length,
      newReg: rows.filter((c) => c.is_new_registration).length,
      bots: rows.length - human.length,
    };
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Customer Leads</h2>
        <p className="text-sm text-muted-foreground">Two short links, both referred by NeexaBot. Every click records the device, browser, IP address and country.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {(links.data ?? []).map((l) => {
          const url = l.kind === 'general' ? `${origin}/${l.short_code}` : `${origin}/n/${l.short_code}`;
          const s = stats(all.filter((c) => c.link_id === l.id));
          return (
            <Card key={l.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  {KIND_LABEL[l.kind] ?? l.kind} link <Badge variant="secondary">Referrer: {l.referrer_label}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-sm">{url}</code>
                  <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(url); toast.success('Link copied'); }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Opens {l.destination_path}</p>
                <div className="grid grid-cols-4 gap-2 text-center">
                  {[['Clicks', s.clicks], ['Unique', s.unique], ['Came in', s.cameIn], ['New sign-ups', s.newReg]].map(([k, v]) => (
                    <div key={k as string} className="rounded bg-muted p-2"><div className="text-lg font-semibold">{v}</div><div className="text-xs text-muted-foreground">{k}</div></div>
                  ))}
                </div>
                {s.bots > 0 && <p className="text-xs text-muted-foreground">{s.bots} link previews (e.g. WhatsApp) not counted.</p>}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-base">Who clicked</CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => setFilter('all')}>All</Button>
            {(links.data ?? []).map((l) => (
              <Button key={l.id} size="sm" variant={filter === l.id ? 'default' : 'outline'} onClick={() => setFilter(l.id)}>{KIND_LABEL[l.kind] ?? l.kind}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr><th className="p-2">When</th><th className="p-2">Link</th><th className="p-2">Device</th><th className="p-2">System</th><th className="p-2">Browser</th><th className="p-2">IP address</th><th className="p-2">Country</th><th className="p-2">Came in as</th></tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const link = links.data?.find((l) => l.id === c.link_id);
                const p = c.user_id ? names.data?.[c.user_id] : null;
                return (
                  <tr key={c.id} className="border-t border-border align-top">
                    <td className="p-2 whitespace-nowrap">{new Date(c.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                    <td className="p-2">{KIND_LABEL[link?.kind ?? ''] ?? '—'}</td>
                    <td className="p-2">{c.device_model || c.device_class}{c.is_bot && <Badge variant="outline" className="ml-1">preview</Badge>}</td>
                    <td className="p-2">{c.os} {c.os_version}</td>
                    <td className="p-2">{c.browser} {c.browser_version}</td>
                    <td className="p-2">{c.ip_address ?? '—'}</td>
                    <td className="p-2">{[c.city, c.country].filter(Boolean).join(', ') || '—'}</td>
                    <td className="p-2">{c.user_id ? <>{p?.full_name ?? 'User'}{p?.phone ? ` · ${p.phone}` : ''}{c.is_new_registration && <Badge className="ml-1">new</Badge>}</> : <span className="text-muted-foreground">Not yet</span>}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">{clicks.isLoading ? 'Loading…' : 'No clicks yet'}</td></tr>}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

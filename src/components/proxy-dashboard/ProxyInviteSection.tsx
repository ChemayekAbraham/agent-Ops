import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Share2, MessageCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { createShortLink } from '@/lib/createShortLink';
import { useProxyCommandCenterSummary } from '@/hooks/useProxyAgentCommandCenter';
import { SectionError, SectionTitle, ugx } from './ProxyDashboardParts';

/** Same attributed-link flow as the Command Center: log once, hand out a short branded link. */
export function ProxyInviteSection({ agentId }: { agentId?: string }) {
  const summary = useProxyCommandCenterSummary(agentId);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  const build = async () => {
    setErr(false);
    try {
      const { data, error } = await supabase.rpc('log_proxy_partner_invite', { p_channel: 'link', p_invitee_name: null, p_invitee_phone: null });
      if (error) throw error;
      const payload = data as unknown as { path: string };
      const long = `${getPublicOrigin()}${payload.path}`;
      try {
        const parsed = new URL(long);
        const params: Record<string, string> = {};
        parsed.searchParams.forEach((v, k) => { params[k] = v; });
        setUrl(await createShortLink(agentId!, parsed.pathname, params));
      } catch { setUrl(long); }
    } catch { setErr(true); }
  };
  useEffect(() => { if (agentId && !started.current) { started.current = true; void build(); } }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const message = url ? `Join me in supporting tenants on Welile and earn monthly returns: ${url}` : '';
  const copy = async () => { if (!url) return; await navigator.clipboard.writeText(url); setCopied(true); toast.success('Copied'); setTimeout(() => setCopied(false), 2000); };
  const share = async () => {
    if (!url) return;
    try { if (navigator.share) await navigator.share({ title: 'Join Welile', text: message, url }); else await copy(); } catch { /* cancelled */ }
  };

  const s = summary.data;
  const stats: [string, string][] = s ? [
    ['Links shared', s.invites.shared.toLocaleString()],
    ['Link opens', s.invites.clicked.toLocaleString()],
    ['Sign-ups', s.invites.converted.toLocaleString()],
    ['Partners joined', s.partners.onboarded.toLocaleString()],
    ['Partners funded', s.partners.came_in.toLocaleString()],
    ['Amount brought in', ugx(s.partners.total_funded)],
  ] : [];

  return (
    <div className="space-y-3">
      <SectionTitle title="Invite & Share" />
      <Card className="border-primary/20 bg-primary/5 p-4 shadow-none">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your invite link</p>
        {err ? (
          <div className="mt-2 flex items-center justify-between gap-2"><p className="text-sm text-muted-foreground">Could not create your link.</p><Button size="sm" variant="outline" onClick={build}>Retry</Button></div>
        ) : (
          <p className="mt-1 flex min-h-[1.5rem] items-center gap-2 break-all text-sm font-semibold text-primary">
            {url ?? <><Loader2 className="h-4 w-4 animate-spin" />Creating your link…</>}
          </p>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Button size="sm" onClick={copy} disabled={!url}>{copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}{copied ? 'Copied' : 'Copy'}</Button>
          <Button size="sm" variant="outline" onClick={share} disabled={!url}><Share2 className="mr-1 h-4 w-4" />Share</Button>
          <Button size="sm" variant="outline" disabled={!url} onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank')}><MessageCircle className="mr-1 h-4 w-4" />WhatsApp</Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Partners who join through your link will be connected to you according to Welile's attribution rules.</p>
      </Card>

      <h2 className="pt-1 text-base font-bold">Invite performance</h2>
      {summary.isError ? <SectionError label="invite performance" onRetry={() => summary.refetch()} />
        : !s ? <Skeleton className="h-32 rounded-xl" />
        : (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {stats.map(([k, v]) => (
              <Card key={k} className="p-3 shadow-none"><p className="text-xs text-muted-foreground">{k}</p><p className="truncate text-lg font-bold tabular-nums">{v}</p></Card>
            ))}
          </div>
        )}
    </div>
  );
}

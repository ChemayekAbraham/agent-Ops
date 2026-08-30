/**
 * ProxyAgentQuickView — lightweight drawer opened from the Proxy Agent
 * Directory. Shows who the agent is (role/status), how they are tracking
 * against this month's target, and a shortcut to the onboarding audit trail.
 *
 * Read-only. It reuses the directory row already in memory plus the single
 * aggregate target RPC (never a per-agent fan-out), so opening it costs
 * nothing extra per agent.
 */
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ExternalLink, History, Link2, ShieldCheck, Target } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyTargetOverview,
  PROXY_TARGET_METRICS,
  proxyInitials,
  proxyStatusTone,
  type ProxyDirRow,
  type ProxyTargetMetric,
} from './proxyAgentDirectory';

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** What this agent has personally achieved for each target metric. */
function achievedFor(row: ProxyDirRow, metric: ProxyTargetMetric): number {
  if (metric === 'partners_came_in') return Number(row.partners_came_in || 0);
  if (metric === 'notes_activated') return Number(row.notes_activated || 0);
  return Number(row.partner_funded || 0);
}

interface Props {
  agent: ProxyDirRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenFullProfile: (agent: ProxyDirRow) => void;
  onOpenAudit: (agent: ProxyDirRow) => void;
  /** Copy a shareable link that reopens this list with the agent preselected. */
  onCopyLink?: (agent: ProxyDirRow) => void;
}

export function ProxyAgentQuickView({
  agent,
  open,
  onOpenChange,
  onOpenFullProfile,
  onOpenAudit,
  onCopyLink,
}: Props) {
  const month = thisMonth();
  const overview = useQuery({
    queryKey: ['proxy-agent-target-overview', month],
    queryFn: () => fetchProxyTargetOverview(month),
    staleTime: 60_000,
    enabled: open,
  });

  const targets = overview.data?.targets ?? {};

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {agent && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-3">
                <Avatar className="h-10 w-10 border">
                  <AvatarImage src={agent.avatar_url ?? undefined} alt={agent.name} />
                  <AvatarFallback className="text-[11px] font-bold">
                    {proxyInitials(agent.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 truncate text-base">{agent.name}</span>
              </SheetTitle>
              <SheetDescription className="text-xs">
                Quick view — role, this month's target progress and onboarding history.
              </SheetDescription>
            </SheetHeader>

            {/* Role & standing */}
            <div className="mt-4 rounded-lg border p-3">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                Role
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  Proxy Agent
                </Badge>
                <Badge variant="outline" className={cn('text-[10px]', proxyStatusTone(agent.status))}>
                  {agent.status}
                </Badge>
              </div>
              <dl className="mt-3 space-y-1.5 text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd className="truncate font-medium">{agent.phone || '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="truncate font-medium">{agent.email || '—'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Activated</dt>
                  <dd className="font-medium">
                    {agent.approved_at ? format(new Date(agent.approved_at), 'dd MMM yyyy') : 'Not yet'}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Brought in by</dt>
                  <dd className="truncate font-medium">{agent.referrer_name || 'Direct'}</dd>
                </div>
              </dl>
            </div>

            {/* Target progress */}
            <div className="mt-3 rounded-lg border p-3">
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                <Target className="h-3.5 w-3.5" />
                Target progress · {format(new Date(`${month}-01`), 'MMMM yyyy')}
              </p>

              {overview.isLoading ? (
                <p className="mt-3 text-[11px] text-muted-foreground">Loading targets…</p>
              ) : overview.isError ? (
                <p className="mt-3 text-[11px] text-destructive">Target progress is unavailable right now.</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {PROXY_TARGET_METRICS.map((m) => {
                    const target = targets[m.key]?.target_value ?? 0;
                    const achieved = achievedFor(agent, m.key);
                    const pct = target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0;
                    const show = (n: number) => (m.money ? formatUGX(n) : n.toLocaleString());
                    return (
                      <div key={m.key}>
                        <div className="flex items-baseline justify-between gap-2">
                          <p className="text-[11px] font-medium">{m.label}</p>
                          <p className="text-[11px] tabular-nums text-muted-foreground">
                            {show(achieved)}
                            {target > 0 ? ` of ${show(target)}` : ' · no target set'}
                          </p>
                        </div>
                        {target > 0 && (
                          <div className="mt-1 flex items-center gap-2">
                            <Progress value={pct} className="h-1.5 flex-1" />
                            <span
                              className={cn(
                                'w-10 text-right text-[10px] font-bold tabular-nums',
                                pct >= 100 ? 'text-emerald-600' : 'text-muted-foreground',
                              )}
                            >
                              {pct}%
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator className="my-4" />

            <div className="space-y-2">
              <Button
                className="w-full justify-start text-xs"
                variant="outline"
                onClick={() => onOpenAudit(agent)}
              >
                <History className="mr-2 h-4 w-4" />
                View onboarding audit trail
              </Button>
              {onCopyLink && (
                <Button
                  className="w-full justify-start text-xs"
                  variant="outline"
                  onClick={() => onCopyLink(agent)}
                >
                  <Link2 className="mr-2 h-4 w-4" />
                  Copy link to this agent
                </Button>
              )}
              <Button className="w-full justify-start text-xs" onClick={() => onOpenFullProfile(agent)}>
                <ExternalLink className="mr-2 h-4 w-4" />
                Open full profile
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

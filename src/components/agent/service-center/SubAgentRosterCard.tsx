import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ChevronRight, Mail, Phone } from 'lucide-react';
import { ServiceCenterSubAgent } from '@/hooks/useAgentServiceCenter';
import { initialsOf, tintFor } from './subAgentVisuals';

/** Identity-only card. Everything else lives in the detail drawer. */
export function SubAgentRosterCard({
  subAgent,
  onOpen,
}: {
  subAgent: ServiceCenterSubAgent;
  onOpen: (s: ServiceCenterSubAgent) => void;
}) {
  const suspended = !!subAgent.suspension;
  const tint = tintFor(subAgent.sub_agent_id);

  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/40">
      <button
        type="button"
        onClick={() => onOpen(subAgent)}
        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${subAgent.full_name ?? 'sub-agent'} details`}
      >
        <CardContent className="flex items-center gap-3 p-0">
          <span className={`h-[72px] w-1.5 shrink-0 ${tint.rail}`} aria-hidden />
          <Avatar className="my-3 h-11 w-11 shrink-0">
            <AvatarImage src={subAgent.avatar_url ?? undefined} alt={subAgent.full_name ?? 'Sub-agent'} />
            <AvatarFallback className={tint.fallback}>{initialsOf(subAgent.full_name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-semibold text-foreground">
                {subAgent.full_name ?? 'Unnamed sub-agent'}
              </span>
              {suspended && <Badge variant="destructive" className="text-[10px]">Suspended</Badge>}
              {subAgent.link_status !== 'verified' && (
                <Badge variant="outline" className="text-[10px]">Pending</Badge>
              )}
            </div>
            <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
              {subAgent.phone && (
                <div className="flex items-center gap-1.5"><Phone className="h-3 w-3" />{subAgent.phone}</div>
              )}
              {subAgent.email && (
                <div className="flex items-center gap-1.5">
                  <Mail className="h-3 w-3 shrink-0" /><span className="truncate">{subAgent.email}</span>
                </div>
              )}
            </div>
          </div>
          <ChevronRight className="mr-3 h-5 w-5 shrink-0 text-muted-foreground" />
        </CardContent>
      </button>
    </Card>
  );
}

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { UserPlus, UsersRound, Crown } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { SubAgentsList } from './SubAgentsList';
import { SubAgentInvitesList } from './SubAgentInvitesList';
import { AddSubAgentSearch } from './AddSubAgentSearch';
import { useUserSnapshot } from '@/hooks/useUserSnapshot';

interface SubAgentsPanelProps {
  agentId: string;
  onInviteSubAgent?: () => void;
}

export function SubAgentsPanel({ agentId, onInviteSubAgent }: SubAgentsPanelProps) {
  const { profile } = useProfile();
  const { snapshot } = useUserSnapshot(agentId);
  const [summary, setSummary] = useState<{ count: number; totalTenants: number; totalEarnings: number }>({
    count: 0,
    totalTenants: 0,
    totalEarnings: 0,
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const pendingCount = snapshot.pendingSubAgentInvites?.length || 0;
  const isEmpty = summary.count === 0 && pendingCount === 0;
  const parentName = profile?.full_name || 'Lead Agent';

  return (
    <div className="space-y-4">
      {/* Lead Agent header */}
      <Card className="overflow-hidden border-orange-500/30 bg-gradient-to-br from-orange-500/5 via-card to-card">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <UserAvatar avatarUrl={profile?.avatar_url} fullName={parentName} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="font-bold text-base leading-tight truncate">{parentName}</p>
                <Badge className="bg-orange-500/15 text-orange-600 border border-orange-500/30 hover:bg-orange-500/15 gap-1 text-[10px] px-1.5 py-0">
                  <Crown className="h-3 w-3" /> Lead Agent
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Manages {summary.count} sub-agent{summary.count === 1 ? '' : 's'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-3">
            <div className="rounded-xl bg-muted/60 p-3">
              <p className="text-[11px] text-muted-foreground">Sub-Agents</p>
              <p className="font-bold text-2xl leading-none mt-1 text-foreground">{summary.count}</p>
            </div>
            <div className="rounded-xl bg-muted/60 p-3">
              <p className="text-[11px] text-muted-foreground">Total Tenants</p>
              <p className="font-bold text-2xl leading-none mt-1 text-foreground">{summary.totalTenants}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pending invites */}
      {pendingCount > 0 && <SubAgentInvitesList />}

      {/* Search any user and add as sub-agent */}
      <AddSubAgentSearch onAdded={() => setRefreshKey((k) => k + 1)} />

      {/* Active list */}
      <SubAgentsList key={refreshKey} onSummary={setSummary} parentAgentName={parentName} />

      {/* Empty state */}
      {isEmpty && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-center space-y-3">
            <div className="w-14 h-14 rounded-full bg-orange-500/10 flex items-center justify-center mx-auto">
              <UsersRound className="h-7 w-7 text-orange-500" />
            </div>
            <div>
              <p className="font-semibold text-sm">No sub-agents yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Invite trusted helpers to grow your tenant base. You earn 2% on every collection they make.
              </p>
            </div>
            {onInviteSubAgent && (
              <Button onClick={onInviteSubAgent} className="gap-2 bg-orange-500 hover:bg-orange-600 text-white">
                <UserPlus className="h-4 w-4" />
                Invite Sub-Agent
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default SubAgentsPanel;

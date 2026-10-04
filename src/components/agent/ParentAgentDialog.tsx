import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { UserAvatar } from '@/components/UserAvatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Building2, Clock, MapPin, Phone, UsersRound } from 'lucide-react';

export interface ParentAgentInfo {
  parent_agent_id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  location_label: string | null;
  link_status: string | null;
  linked_at: string | null;
  invited_at: string | null;
  service_centre_name: string | null;
  service_centre_status: string | null;
  service_centre_photo_url: string | null;
}

export async function fetchMyParentAgent(): Promise<ParentAgentInfo | null> {
  const { data, error } = await supabase.rpc('get_my_parent_agent');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ParentAgentInfo) || null;
}

export function useMyParentAgent(agentId?: string) {
  return useQuery({
    queryKey: ['my-parent-agent-details', agentId],
    enabled: !!agentId,
    queryFn: fetchMyParentAgent,
  });
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-0">
      <div className="mt-0.5 rounded-lg bg-accent p-1.5 text-accent-foreground shrink-0">
        <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          {label}
        </p>
        <p className="text-sm font-semibold text-foreground break-words">{value}</p>
      </div>
    </div>
  );
}

interface ParentAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string;
}

export function ParentAgentDialog({ open, onOpenChange, agentId }: ParentAgentDialogProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['my-parent-agent-details', agentId],
    enabled: !!agentId && open,
    queryFn: fetchMyParentAgent,
  });

  const linkedLabel = fmtDate(data?.linked_at) || fmtDate(data?.invited_at);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>My Parent Agent</DialogTitle>
          <DialogDescription>
            The agent who recruited you onto Welile.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !data?.parent_agent_id ? (
          <p className="text-sm text-muted-foreground py-4">
            You are not linked to a parent agent. You registered directly with Welile.
          </p>
        ) : (
          <div>
            <div className="flex items-center gap-3 pb-3">
              <UserAvatar
                fullName={data.full_name || 'Your agent'}
                avatarUrl={data.avatar_url}
                className="h-14 w-14 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="font-bold text-foreground truncate">
                  {data.full_name || 'Your agent'}
                </p>
                {data.link_status && (
                  <Badge variant="secondary" className="mt-1 capitalize text-[10px]">
                    {data.link_status.replace(/_/g, ' ')}
                  </Badge>
                )}
              </div>
            </div>

            <Row icon={UsersRound} label="Agent name" value={data.full_name || 'Not provided'} />
            <Row icon={Phone} label="Phone number" value={data.phone || 'Not provided'} />
            <Row icon={MapPin} label="Location" value={data.location_label || 'Not provided'} />
            <Row
              icon={Building2}
              label="Service centre"
              value={
                data.service_centre_name
                  ? data.service_centre_status
                    ? `${data.service_centre_name} (${data.service_centre_status.replace(/_/g, ' ')})`
                    : data.service_centre_name
                  : 'Not linked'
              }
            />
            <Row icon={Clock} label="Linked date" value={linkedLabel || 'Not available'} />

            {data.service_centre_photo_url && (
              <div className="mt-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
                  Service centre photo
                </p>
                <img
                  src={data.service_centre_photo_url}
                  alt={`Service centre of ${data.full_name || 'parent agent'}`}
                  loading="lazy"
                  className="w-full h-40 object-cover rounded-xl border border-border/60"
                />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

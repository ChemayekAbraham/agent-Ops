import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import BusinessAdvanceStatusTracker, { AdvanceStatusRow, getActiveAdvanceStage } from '@/components/business-advance/BusinessAdvanceStatusTracker';
import { useBusinessAdvanceRealtime } from '@/hooks/useBusinessAdvanceRealtime';
import { BusinessAdvanceAuditLog } from '@/components/business-advance/BusinessAdvanceAuditLog';
import { LiveUpdatingBadge } from '@/components/business-advance/LiveUpdatingBadge';
import { BusinessAdvanceNotificationPreferences } from '@/components/business-advance/NotificationPreferences';
import { BusinessAdvanceDocumentUploadPanel } from '@/components/business-advance/DocumentUploadPanel';
import { Skeleton } from '@/components/ui/skeleton';

const ACTIVE_STATUSES = ['pending','agent_ops_approved','tenant_ops_approved','landlord_ops_approved','coo_approved','active'] as const;

/**
 * Prominent banner on the tenant dashboard surfacing any in-flight or active
 * Business Advance. Shows the live multi-stage approval timeline at the top so
 * tenants always know exactly where their request stands.
 */
export function BusinessAdvanceStatusHero() {
  const { user } = useAuth();
  const storageKey = user?.id ? `tenant-ba-hero-open:${user.id}` : null;
  const [open, setOpen] = useState(false);
  const [userToggled, setUserToggled] = useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setUserToggled(true);
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, next ? '1' : '0'); } catch {}
  };

  const { data, refetch, isLoading } = useQuery({
    queryKey: ['tenant-active-business-advance', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('business_advances')
        .select('id,status,business_name,principal,outstanding_balance,reason,created_at,agent_ops_reviewed_at,tenant_ops_reviewed_at,landlord_ops_reviewed_at,coo_approved_at,cfo_disbursed_at,disbursed_at,completed_at,rejection_reason,agent_id')
        .eq('tenant_id', user!.id)
        .in('status', ACTIVE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      let agentName: string | null = null;
      if (data.agent_id) {
        const { data: ap } = await supabase.from('profiles').select('full_name').eq('id', data.agent_id).maybeSingle();
        agentName = ap?.full_name ?? null;
      }
      return { ...data, agent_name: agentName } as AdvanceStatusRow & { agent_id: string };
    },
  });

  const rtStatus = useBusinessAdvanceRealtime(
    user?.id ? `tenant-hero-${user.id}` : null,
    () => { refetch(); },
    user?.id ? { filter: `tenant_id=eq.${user.id}` } : undefined
  );

  // Auto: expand when status is active, collapse otherwise. Honour the user's
  // manual toggle (persisted in localStorage) once they've interacted.
  const currentStatus = data?.status;
  useEffect(() => {
    if (userToggled || !currentStatus) return;
    let saved: string | null = null;
    if (storageKey) {
      try { saved = localStorage.getItem(storageKey); } catch {}
    }
    if (saved !== null) {
      setOpen(saved === '1');
    } else {
      setOpen(currentStatus === 'active');
    }
  }, [currentStatus, storageKey, userToggled]);

  if (!data && !isLoading) return null;

  const activeStage = data ? getActiveAdvanceStage(data) : null;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 via-background to-primary/5 shadow-md">
      <Collapsible open={open} onOpenChange={handleOpenChange}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => handleOpenChange(!open)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleOpenChange(!open);
            }
          }}
          className="w-full flex items-center justify-between gap-2 p-4 text-left hover:bg-muted/30 transition-colors rounded-lg cursor-pointer"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold text-primary">
              <Sparkles className="h-3 w-3" />
              {isLoading || !data
                ? 'Loading your Business Advance…'
                : data.status === 'active'
                  ? 'Your Business Advance is active'
                  : 'Your Business Advance is being reviewed'}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Tap to {open ? 'hide' : 'expand'} progress, documents and notification settings.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <LiveUpdatingBadge status={rtStatus} />
            <CollapsibleTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label={open ? 'Collapse Business Advance details' : 'Expand Business Advance details'}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-border bg-background hover:bg-muted transition-colors"
              >
                {open ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <CardContent className="p-4 pt-0 space-y-3">
            {!data ? (
              <div className="space-y-3" aria-busy="true" aria-live="polite">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-10 w-1/2" />
              </div>
            ) : (
              <>
                <BusinessAdvanceStatusTracker row={data} compact />
                {activeStage && user?.id && (
                  <BusinessAdvanceDocumentUploadPanel
                    advanceId={data.id}
                    tenantId={user.id}
                    stageKey={activeStage.key}
                    stageLabel={activeStage.label}
                  />
                )}
                <BusinessAdvanceAuditLog advanceId={data.id} />
                {user?.id && <BusinessAdvanceNotificationPreferences userId={user.id} />}
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

export default BusinessAdvanceStatusHero;

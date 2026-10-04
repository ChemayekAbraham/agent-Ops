import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Smartphone, Send, CheckCircle2, Phone, HelpCircle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface CallCentreSmartphonePanelProps {
  tenantId: string;
  smartphoneStatus?: string | null;
  smartphoneSource?: string | null;
  onRefetch?: () => void | Promise<unknown>;
}

function formatSmartphoneStatus(status?: string | null): string {
  if (!status) return 'Unknown';
  switch (status.toUpperCase()) {
    case 'CONFIRMED_SMARTPHONE':
      return 'Confirmed smartphone';
    case 'CONFIRMED_FEATURE_PHONE':
      return 'Confirmed feature phone';
    case 'UNKNOWN':
    default:
      return 'Unknown';
  }
}

function formatSmartphoneSource(source?: string | null): string {
  if (!source) return '—';
  switch (source.toUpperCase()) {
    case 'ONBOARDING':
      return 'Onboarding';
    case 'AGENT':
      return 'Agent';
    case 'CALL_CENTER':
      return 'Call Centre';
    case 'DASHBOARD_ACCESS':
      return 'Dashboard access';
    default:
      return source;
  }
}

export function CallCentreSmartphonePanel({
  tenantId,
  smartphoneStatus,
  smartphoneSource,
  onRefetch,
}: CallCentreSmartphonePanelProps) {
  const [updatingStatus, setUpdatingStatus] = useState<string | null>(null);
  const [sendingLink, setSendingLink] = useState(false);

  const handleSetStatus = async (
    status: 'CONFIRMED_SMARTPHONE' | 'CONFIRMED_FEATURE_PHONE' | 'UNKNOWN',
  ) => {
    setUpdatingStatus(status);
    try {
      const { error } = await (supabase.rpc as any)('set_tenant_smartphone_status', {
        p_tenant_id: tenantId,
        p_status: status,
        p_source: 'CALL_CENTER',
      });

      if (error) {
        toast.error(error.message || 'Failed to update smartphone status');
        return;
      }

      toast.success(
        status === 'CONFIRMED_SMARTPHONE'
          ? 'Confirmed smartphone'
          : status === 'CONFIRMED_FEATURE_PHONE'
          ? 'Confirmed feature phone'
          : 'Status set to Unknown',
      );

      if (onRefetch) {
        await onRefetch();
      }
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Failed to update status');
    } finally {
      setUpdatingStatus(null);
    }
  };

  const handleSendDashboardLink = async () => {
    setSendingLink(true);
    try {
      const { data, error } = await supabase.functions.invoke('tenant-dashboard-invites', {
        body: {
          tenant_id: tenantId,
          mode: 'invite',
        },
      });

      if (error) {
        toast.error(error.message || 'Failed to send dashboard link');
        return;
      }

      if (data?.success === false) {
        toast.error(data.error || 'Failed to send dashboard link');
        return;
      }

      toast.success('Dashboard link sent via SMS');
      if (onRefetch) {
        await onRefetch();
      }
    } catch (e: unknown) {
      toast.error((e as Error)?.message || 'Network error while sending dashboard link');
    } finally {
      setSendingLink(false);
    }
  };

  const statusDisplay = formatSmartphoneStatus(smartphoneStatus);
  const sourceDisplay = formatSmartphoneSource(smartphoneSource);

  const getStatusBadgeVariant = () => {
    if (smartphoneStatus === 'CONFIRMED_SMARTPHONE') return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';
    if (smartphoneStatus === 'CONFIRMED_FEATURE_PHONE') return 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20';
    return 'bg-muted text-muted-foreground border-border';
  };

  return (
    <Card className="rounded-xl border border-border/70 shadow-sm">
      <CardHeader className="py-3 px-4 pb-2 border-b border-border/40">
        <CardTitle className="text-xs font-bold tracking-wider uppercase text-muted-foreground flex items-center gap-2">
          <Smartphone className="h-3.5 w-3.5 text-primary" />
          SMARTPHONE
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-muted-foreground block text-[11px]">Status</span>
            <div className="mt-1">
              <Badge variant="outline" className={`font-semibold ${getStatusBadgeVariant()}`}>
                {statusDisplay}
              </Badge>
            </div>
          </div>
          <div>
            <span className="text-muted-foreground block text-[11px]">Source</span>
            <p className="font-semibold text-foreground mt-1">{sourceDisplay}</p>
          </div>
        </div>

        <div className="pt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant={smartphoneStatus === 'CONFIRMED_SMARTPHONE' ? 'default' : 'outline'}
            onClick={() => handleSetStatus('CONFIRMED_SMARTPHONE')}
            disabled={Boolean(updatingStatus)}
            className="h-8 text-xs font-medium"
          >
            {updatingStatus === 'CONFIRMED_SMARTPHONE' ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-500" />
            )}
            Confirm Smartphone
          </Button>

          <Button
            type="button"
            size="sm"
            variant={smartphoneStatus === 'CONFIRMED_FEATURE_PHONE' ? 'default' : 'outline'}
            onClick={() => handleSetStatus('CONFIRMED_FEATURE_PHONE')}
            disabled={Boolean(updatingStatus)}
            className="h-8 text-xs font-medium"
          >
            {updatingStatus === 'CONFIRMED_FEATURE_PHONE' ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Phone className="h-3 w-3 mr-1 text-amber-500" />
            )}
            Feature Phone
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => handleSetStatus('UNKNOWN')}
            disabled={Boolean(updatingStatus)}
            className="h-8 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {updatingStatus === 'UNKNOWN' ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <HelpCircle className="h-3 w-3 mr-1" />
            )}
            Keep Unknown
          </Button>

          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleSendDashboardLink}
            disabled={sendingLink}
            className="h-8 text-xs font-semibold ml-auto"
          >
            {sendingLink ? (
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <Send className="h-3 w-3 mr-1 text-primary" />
            )}
            Send Dashboard Link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

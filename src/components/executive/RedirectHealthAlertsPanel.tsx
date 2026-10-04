import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ShieldAlert, RefreshCw, CheckCircle2, XCircle, Save } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface MonitorRow {
  id: string;
  old_domain: string;
  new_domain: string;
  enabled: boolean;
  alert_emails: string[];
  notify_managers: boolean;
  currently_healthy: boolean | null;
  ever_healthy: boolean;
  consecutive_failures: number;
  last_healthy_at: string | null;
  last_checked_at: string | null;
}
interface AlertRow {
  id: string;
  alert_type: string;
  severity: string;
  recipients: string[];
  email_sent: boolean;
  push_sent: boolean;
  created_at: string;
  resolved_at: string | null;
}

export function RedirectHealthAlertsPanel() {
  const [running, setRunning] = useState(false);
  const [emails, setEmails] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: monitor, isLoading, refetch } = useQuery({
    queryKey: ['redirect-monitor'],
    queryFn: async (): Promise<MonitorRow | null> => {
      const { data, error } = await supabase
        .from('redirect_monitor')
        .select('*')
        .eq('old_domain', 'welilereceipts.com')
        .eq('new_domain', 'welileapp.com')
        .maybeSingle();
      if (error) throw error;
      return data as unknown as MonitorRow | null;
    },
  });

  const { data: alerts, refetch: refetchAlerts } = useQuery({
    queryKey: ['redirect-monitor-alerts'],
    queryFn: async (): Promise<AlertRow[]> => {
      const { data, error } = await supabase
        .from('redirect_monitor_alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(8);
      if (error) throw error;
      return (data ?? []) as unknown as AlertRow[];
    },
  });

  useEffect(() => {
    if (monitor) setEmails((monitor.alert_emails ?? []).join(', '));
  }, [monitor]);

  const runCheck = async () => {
    setRunning(true);
    try {
      const { error } = await supabase.functions.invoke('redirect-health-monitor', { body: {} });
      if (error) throw error;
      await Promise.all([refetch(), refetchAlerts()]);
      toast.success('Redirect health checked');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  };

  const saveRecipients = async () => {
    if (!monitor) return;
    setSaving(true);
    try {
      const list = emails.split(',').map((s) => s.trim()).filter(Boolean);
      const { error } = await supabase
        .from('redirect_monitor')
        .update({ alert_emails: list })
        .eq('id', monitor.id);
      if (error) throw error;
      await refetch();
      toast.success('Alert recipients saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed (managers only)');
    } finally {
      setSaving(false);
    }
  };

  const healthy = monitor?.currently_healthy;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          Redirect uptime alerts — welilereceipts.com → welileapp.com
        </CardTitle>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={running}>
          <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
          <span className="ml-2">Check now</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !monitor ? (
          <p className="text-sm text-muted-foreground">Monitor not configured.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              {healthy == null ? (
                <Badge variant="outline">Not checked yet</Badge>
              ) : healthy ? (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Redirect healthy
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-destructive text-destructive">
                  <XCircle className="h-3.5 w-3.5" />
                  {monitor.ever_healthy ? 'Redirect DOWN' : 'Not live yet'}
                </Badge>
              )}
              {monitor.last_checked_at && (
                <span className="text-xs text-muted-foreground">
                  Checked {formatDistanceToNow(new Date(monitor.last_checked_at), { addSuffix: true })}
                </span>
              )}
              <span className="text-xs text-muted-foreground">Runs every 15 min</span>
            </div>

            {!monitor.ever_healthy && (
              <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Alerts are armed but stay silent until the redirect goes live at least once — this
                avoids false alarms during setup. Once it's up, any regression triggers a manager
                push notification and an email.
              </p>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Alert email recipients (comma-separated · managers can edit)
              </label>
              <div className="flex gap-2">
                <Input
                  value={emails}
                  onChange={(e) => setEmails(e.target.value)}
                  placeholder="Leave blank to alert all managers by email"
                />
                <Button size="sm" variant="secondary" onClick={saveRecipients} disabled={saving}>
                  <Save className="h-4 w-4" />
                  <span className="ml-2">Save</span>
                </Button>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Recent alerts</p>
              {(alerts?.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground">No alerts raised yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {alerts!.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-2">
                        {a.alert_type === 'redirect_down' ? (
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        ) : (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        )}
                        {a.alert_type === 'redirect_down' ? 'Redirect went down' : 'Redirect restored'}
                        {a.resolved_at && a.alert_type === 'redirect_down' && (
                          <Badge variant="secondary" className="ml-1">resolved</Badge>
                        )}
                      </span>
                      <span className="text-muted-foreground">
                        {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
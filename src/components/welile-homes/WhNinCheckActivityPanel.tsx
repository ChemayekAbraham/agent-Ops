import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type Row = {
  agent_id: string; agent_name: string | null; agent_phone: string | null;
  checks: number; in_use: number; blocked: number; enrol_duplicates: number; last_check: string;
};

/** Agent Ops review of Welile Homes NIN "already on file" checks per agent (counts only, never NINs). */
export function WhNinCheckActivityPanel() {
  const [hours, setHours] = useState(24);
  const { data, isLoading, error } = useQuery({
    queryKey: ['wh-nin-check-activity', hours],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('wh_nin_check_activity', { p_hours: hours });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm">Tenant ID checks by agent</CardTitle>
        <div className="flex gap-1">
          {[24, 168].map((h) => (
            <Button key={h} size="sm" variant={hours === h ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setHours(h)}>
              {h === 24 ? 'Last 24 hours' : 'Last 7 days'}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-xs text-muted-foreground">Limit: 30 checks per agent per hour. Agents with high numbers are listed first.</p>
        {isLoading ? <p className="text-xs text-muted-foreground">Loading…</p>
          : error ? <p className="text-xs text-destructive">Could not load ID check activity.</p>
          : !data?.length ? <p className="text-xs text-muted-foreground">No ID checks in this period.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="text-left">
                    <th className="py-1 pr-2">Agent</th><th className="py-1 pr-2 text-right">Checks</th>
                    <th className="py-1 pr-2 text-right">Already on file</th><th className="py-1 pr-2 text-right">Duplicate enrol attempts</th>
                    <th className="py-1 pr-2 text-right">Blocked</th><th className="py-1">Last check</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.agent_id} className="border-t border-border">
                      <td className="py-1 pr-2">{r.agent_name || 'Unknown'}<div className="text-muted-foreground">{r.agent_phone}</div></td>
                      <td className="py-1 pr-2 text-right font-medium">{r.checks}</td>
                      <td className="py-1 pr-2 text-right">{r.in_use}</td>
                      <td className="py-1 pr-2 text-right">{r.enrol_duplicates}</td>
                      <td className="py-1 pr-2 text-right">{r.blocked > 0 ? <Badge variant="destructive">{r.blocked}</Badge> : 0}</td>
                      <td className="py-1">{new Date(r.last_check).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardContent>
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, Fingerprint, ShieldAlert, Users } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';

/**
 * Devices ranked by how many accounts they actually created.
 *
 * The attempt log next to this answers "what happened just now". During the
 * 10-14 September ring — 34,317 accounts, all since frozen — the useful question
 * was instead "which devices are farming accounts", which a time-ordered list
 * cannot show.
 *
 * `accounts_created` comes from `profiles.signup_device_fp`, not from the
 * attempt log, so a signup that skipped the client-side guard entirely still
 * appears here. That column only populates from 26 September onwards, when the
 * fingerprint started being recorded on the account itself.
 *
 * Rows flagged `agent_assisted` are tenant registrations — one agent legitimately
 * registering many tenants from one phone. They are exempt from the
 * one-account-per-device-per-day rule and capped separately at 5/hour, 15/day.
 * They are shown rather than hidden, because "which agent is registering an
 * implausible number of tenants" is also worth seeing.
 */

const RANGES = [1, 7, 30] as const;

interface DeviceRow {
  device_fp: string;
  accounts_created: number;
  attempts_total: number;
  attempts_blocked: number;
  distinct_ips: number;
  distinct_referrers: number;
  agent_assisted: boolean;
  first_seen: string | null;
  last_seen: string | null;
  sample_user_agent: string | null;
  account_names: string | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/** A device creating several accounts on its own is the shape worth chasing. */
function risk(row: DeviceRow): 'high' | 'watch' | null {
  if (row.agent_assisted) return null;
  if (num(row.accounts_created) >= 3) return 'high';
  if (num(row.accounts_created) >= 2 || num(row.attempts_blocked) >= 5) return 'watch';
  return null;
}

export function SignupDeviceAbusePanel() {
  const [days, setDays] = useState<number>(7);
  const [showAgentAssisted, setShowAgentAssisted] = useState(true);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['signup-device-abuse', days],
    queryFn: async () => {
      const { data, error } = await (supabase as never as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      }).rpc('get_signup_device_abuse', { p_days: days, p_limit: 150 });
      if (error) throw error;
      return (data ?? []) as DeviceRow[];
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const rows = useMemo(
    () => (data ?? []).filter(r => showAgentAssisted || !r.agent_assisted),
    [data, showAgentAssisted],
  );

  const summary = useMemo(() => {
    const live = (data ?? []).filter(r => !r.agent_assisted);
    return {
      devices: live.length,
      accounts: live.reduce((s, r) => s + num(r.accounts_created), 0),
      blocked: (data ?? []).reduce((s, r) => s + num(r.attempts_blocked), 0),
      repeatOffenders: live.filter(r => num(r.accounts_created) >= 2).length,
    };
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-primary" />
            Devices creating accounts
          </CardTitle>
          <CardDescription>
            One account per device per 24 hours, enforced on the <code>auth.users</code> trigger
            so it cannot be skipped by calling the Auth endpoint directly. Tenant registration is
            exempt and capped separately.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGES.map(d => (
            <Button
              key={d}
              size="sm"
              variant={days === d ? 'default' : 'outline'}
              className="h-7 text-xs"
              onClick={() => setDays(d)}
            >
              {d === 1 ? '24h' : `${d}d`}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void refetch()}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Devices seen" value={String(summary.devices)} />
          <Stat label="Accounts created" value={String(summary.accounts)} />
          <Stat label="Attempts blocked" value={String(summary.blocked)} />
          <Stat
            label="Devices with 2+ accounts"
            value={String(summary.repeatOffenders)}
            tone={summary.repeatOffenders > 0 ? 'bad' : undefined}
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showAgentAssisted}
            onChange={e => setShowAgentAssisted(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Include tenant registration (agent-assisted)
        </label>

        {error && <p className="text-sm text-destructive">Could not load: {(error as Error).message}</p>}
        {!error && !isLoading && rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No devices recorded in this window.
          </p>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Device</TableHead>
                  <TableHead className="text-right text-xs">Accounts</TableHead>
                  <TableHead className="text-right text-xs">Attempts</TableHead>
                  <TableHead className="text-right text-xs">Blocked</TableHead>
                  <TableHead className="text-right text-xs">IPs</TableHead>
                  <TableHead className="text-xs">Last seen</TableHead>
                  <TableHead className="text-xs">Accounts on this device</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(r => {
                  const level = risk(r);
                  return (
                    <TableRow key={r.device_fp}>
                      <TableCell className="font-mono text-[11px]">
                        {r.device_fp.slice(0, 12)}…
                        {r.agent_assisted && (
                          <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[9px]">
                            <Users className="mr-0.5 h-2.5 w-2.5" />
                            tenant reg
                          </Badge>
                        )}
                        {level === 'high' && (
                          <Badge variant="destructive" className="ml-1.5 px-1 py-0 text-[9px]">
                            <ShieldAlert className="mr-0.5 h-2.5 w-2.5" />
                            high
                          </Badge>
                        )}
                        {level === 'watch' && (
                          <Badge variant="secondary" className="ml-1.5 px-1 py-0 text-[9px]">watch</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-semibold">
                        {num(r.accounts_created)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts_total)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {num(r.attempts_blocked) > 0 ? (
                          <span className="text-orange-600 dark:text-orange-400">{num(r.attempts_blocked)}</span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.distinct_ips)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.last_seen ? `${formatDistanceToNowStrict(new Date(r.last_seen))} ago` : '—'}
                      </TableCell>
                      <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground" title={r.account_names ?? ''}>
                        {r.account_names || '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-[10px] text-muted-foreground">
          &ldquo;Accounts&rdquo; counts real profiles carrying this fingerprint, not log entries — a signup
          that skipped the client guard still shows. Recording started 26 September, so earlier
          windows show attempts only.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}>
        {value}
      </div>
    </div>
  );
}

export default SignupDeviceAbusePanel;

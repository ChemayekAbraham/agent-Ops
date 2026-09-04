import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, CalendarRange, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface ReportRow {
  id: string;
  granularity: string;
  period_start: string;
  period_end: string | null;
  status: string;
  submitted_at: string | null;
  submitted_by: string | null;
}

interface NoteRow { id: string; zone: string; reason_note: string; created_at: string }
interface ActionRow {
  id: string;
  zone: string;
  item_text: string;
  owner_label: string | null;
  due_date: string | null;
  outcome: string | null;
  outcome_note: string | null;
}

function longDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function stamp(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala',
  }).format(new Date(iso));
}

/**
 * Read-only HR view of Portfolio Performance reports submitted by Tenant Ops.
 * HR cannot create, edit or reopen a report — this is a records surface only.
 */
export default function HRSubmittedReports() {
  const [openId, setOpenId] = useState<string | null>(null);

  const { data: reports = [], isLoading } = useQuery({
    queryKey: ['hr-submitted-tppo-reports'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tppo_reports')
        .select('id, granularity, period_start, period_end, status, submitted_at, submitted_by')
        .eq('status', 'submitted')
        .order('submitted_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as ReportRow[];
    },
  });

  const submitterIds = useMemo(
    () => Array.from(new Set(reports.map((r) => r.submitted_by).filter(Boolean))) as string[],
    [reports],
  );

  const { data: names = {} } = useQuery({
    queryKey: ['hr-submitted-tppo-submitters', submitterIds],
    enabled: submitterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', submitterIds);
      if (error) return {};
      const map: Record<string, string> = {};
      (data || []).forEach((p: { id: string; full_name: string | null }) => {
        map[p.id] = p.full_name || 'Unnamed';
      });
      return map;
    },
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['hr-submitted-tppo-detail', openId],
    enabled: !!openId,
    queryFn: async () => {
      const [notes, actions] = await Promise.all([
        supabase
          .from('tppo_report_notes')
          .select('id, zone, reason_note, created_at')
          .eq('report_id', openId!)
          .order('created_at', { ascending: true }),
        supabase
          .from('tppo_report_actions')
          .select('id, zone, item_text, owner_label, due_date, outcome, outcome_note')
          .eq('report_id', openId!)
          .order('created_at', { ascending: true }),
      ]);
      return {
        notes: (notes.data || []) as NoteRow[],
        actions: (actions.data || []) as ActionRow[],
      };
    },
  });

  const active = reports.find((r) => r.id === openId) || null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submitted Reports</h1>
        <p className="text-sm text-muted-foreground">
          Portfolio Performance reports submitted by Tenant Operations. Read-only.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            Reports on record
            <Badge variant="secondary">{reports.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : reports.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No submitted reports yet.
            </p>
          ) : (
            <div className="divide-y">
              {reports.map((r, i) => (
                <button
                  key={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="text-muted-foreground">{i + 1}.</span>
                      <CalendarRange className="h-3.5 w-3.5 text-muted-foreground" />
                      {longDate(r.period_start)}
                      {r.period_end && r.period_end !== r.period_start
                        ? ` – ${longDate(r.period_end)}`
                        : ''}
                      <Badge variant="outline" className="capitalize">{r.granularity}</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      {r.submitted_by ? names[r.submitted_by] || 'Tenant Ops' : 'Tenant Ops'}
                      <span>·</span>
                      {stamp(r.submitted_at)}
                    </div>
                  </div>
                  <Badge className="shrink-0">Submitted</Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {active
                ? `${longDate(active.period_start)}${
                    active.period_end && active.period_end !== active.period_start
                      ? ` – ${longDate(active.period_end)}`
                      : ''
                  }`
                : 'Report'}
            </SheetTitle>
          </SheetHeader>

          {detailLoading ? (
            <div className="mt-4 space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : (
            <div className="mt-4 space-y-6">
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Collections narrative</h3>
                {(detail?.notes.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No narrative recorded.</p>
                ) : (
                  detail!.notes.map((n) => (
                    <div key={n.id} className="rounded-lg border p-3 text-sm">
                      <Badge variant="outline" className="mb-2">{n.zone}</Badge>
                      <p className="whitespace-pre-wrap">{n.reason_note}</p>
                    </div>
                  ))
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Action items</h3>
                {(detail?.actions.length ?? 0) === 0 ? (
                  <p className="text-sm text-muted-foreground">No action items recorded.</p>
                ) : (
                  detail!.actions.map((a) => (
                    <div key={a.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline">{a.zone}</Badge>
                        {a.outcome && (
                          <Badge variant="secondary" className="capitalize">
                            {a.outcome.replace(/_/g, ' ')}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 whitespace-pre-wrap">{a.item_text}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Owner: {a.owner_label || '—'} · Due: {longDate(a.due_date)}
                      </p>
                      {a.outcome_note && (
                        <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                          {a.outcome_note}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </section>

              <Button variant="outline" onClick={() => setOpenId(null)}>Close</Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

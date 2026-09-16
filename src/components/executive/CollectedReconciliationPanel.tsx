import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Download, RefreshCw, AlertTriangle } from "lucide-react";
import { formatUGX } from "@/lib/agentAdvanceCalculations";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * Daily reconciliation view for Fleet "Collected".
 *
 * For each day in [start, end]:
 *   • total_collected   = sum of `agent_collections.amount` where tracking_id LIKE 'AGT-%'
 *   • excluded_llf      = subset whose rent_request was CFO-funded via landlord float
 *                         (row exists in `agent_landlord_float_allocations`)
 *   • net_collected     = total_collected − excluded_llf   ← what Fleet Performance shows
 *
 * Purpose: quickly audit mismatches between raw agent_collections and the
 * "Collected" number rendered on FleetPerformanceStats.
 */

type Row = {
  day: string;
  total_rows: number;
  total_amount: number;
  excluded_rows: number;
  excluded_amount: number;
  net_amount: number;
};

function toISODateLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayKey(iso: string) {
  const d = new Date(iso);
  return toISODateLocal(d);
}

async function fetchReconciliation(startISO: string, endISO: string): Promise<Row[]> {
  const PAGE = 1000;
  let from = 0;
  const rows: Array<{ amount: number; created_at: string; rent_request_id: string | null }> = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("agent_collections")
      .select("amount, created_at, rent_request_id")
      .is("reversed_at", null)
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .gt("amount", 0)
      .like("tracking_id", "AGT-%")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = data || [];
    page.forEach((r: any) => {
      if (!r.created_at) return;
      rows.push({
        amount: Number(r.amount) || 0,
        created_at: r.created_at,
        rent_request_id: r.rent_request_id ?? null,
      });
    });
    if (page.length < PAGE) break;
    from += PAGE;
  }

  // Look up which rent_requests are CFO landlord-float funded
  const rrIds = Array.from(
    new Set(rows.map((r) => r.rent_request_id).filter((x): x is string => !!x)),
  );
  const excluded = new Set<string>();
  const BATCH = 200;
  for (let i = 0; i < rrIds.length; i += BATCH) {
    const chunk = rrIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("agent_landlord_float_allocations")
      .select("rent_request_id")
      .in("rent_request_id", chunk);
    if (error) throw error;
    (data || []).forEach((r: any) => {
      if (r.rent_request_id) excluded.add(r.rent_request_id);
    });
  }

  const byDay = new Map<string, Row>();
  rows.forEach((r) => {
    const k = dayKey(r.created_at);
    let bucket = byDay.get(k);
    if (!bucket) {
      bucket = {
        day: k,
        total_rows: 0,
        total_amount: 0,
        excluded_rows: 0,
        excluded_amount: 0,
        net_amount: 0,
      };
      byDay.set(k, bucket);
    }
    bucket.total_rows += 1;
    bucket.total_amount += r.amount;
    if (r.rent_request_id && excluded.has(r.rent_request_id)) {
      bucket.excluded_rows += 1;
      bucket.excluded_amount += r.amount;
    }
    bucket.net_amount = bucket.total_amount - bucket.excluded_amount;
  });

  return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? 1 : -1));
}

function csvEscape(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows: Row[]) {
  const header = [
    "day",
    "total_rows",
    "total_amount_ugx",
    "excluded_rows",
    "excluded_amount_ugx",
    "net_amount_ugx",
  ];
  const body = rows.map((r) =>
    [r.day, r.total_rows, r.total_amount, r.excluded_rows, r.excluded_amount, r.net_amount]
      .map(csvEscape)
      .join(","),
  );
  const blob = new Blob([[header.join(","), ...body].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `collected-reconciliation_${rows[rows.length - 1]?.day ?? "range"}_${rows[0]?.day ?? ""}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function CollectedReconciliationPanel() {
  const today = useMemo(() => new Date(), []);
  const defaultStart = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 13);
    return toISODateLocal(d);
  }, [today]);
  const defaultEnd = useMemo(() => toISODateLocal(today), [today]);

  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);
  const [drillDay, setDrillDay] = useState<string | null>(null);

  // Convert to a half-open [start, end+1day) window in local time
  const { startISO, endISO } = useMemo(() => {
    const s = new Date(`${startDate}T00:00:00`);
    const e = new Date(`${endDate}T00:00:00`);
    e.setDate(e.getDate() + 1);
    return { startISO: s.toISOString(), endISO: e.toISOString() };
  }, [startDate, endDate]);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ["collected-reconciliation", startISO, endISO],
    queryFn: () => fetchReconciliation(startISO, endISO),
    staleTime: 60_000,
  });

  const rows = data ?? [];
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.total_rows += r.total_rows;
          acc.total_amount += r.total_amount;
          acc.excluded_rows += r.excluded_rows;
          acc.excluded_amount += r.excluded_amount;
          acc.net_amount += r.net_amount;
          return acc;
        },
        { total_rows: 0, total_amount: 0, excluded_rows: 0, excluded_amount: 0, net_amount: 0 },
      ),
    [rows],
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <CardTitle className="text-base">Collected reconciliation</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Daily audit: raw agent collections (AGT-*) vs landlord-float exclusions vs the
            net figure shown on Fleet Performance.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="rec-start" className="text-xs">From</Label>
            <Input
              id="rec-start"
              type="date"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div>
            <Label htmlFor="rec-end" className="text-xs">To</Label>
            <Input
              id="rec-end"
              type="date"
              value={endDate}
              min={startDate}
              max={defaultEnd}
              onChange={(e) => setEndDate(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(rows)}
            disabled={!rows.length}
          >
            <Download className="h-4 w-4 mr-1" />
            CSV
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Failed to load reconciliation.
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <SummaryTile label="Total collected (raw)" value={formatUGX(totals.total_amount)} sub={`${totals.total_rows.toLocaleString()} rows`} />
          <SummaryTile
            label="Excluded landlord-float"
            value={formatUGX(totals.excluded_amount)}
            sub={`${totals.excluded_rows.toLocaleString()} rows`}
            tone="text-amber-600 dark:text-amber-400"
          />
          <SummaryTile
            label="Net collected (Fleet)"
            value={formatUGX(totals.net_amount)}
            sub="raw − excluded"
            tone="text-primary"
          />
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Day</th>
                <th className="text-right px-3 py-2">Total collected</th>
                <th className="text-right px-3 py-2">Rows</th>
                <th className="text-right px-3 py-2">Excluded (LLF)</th>
                <th className="text-right px-3 py-2">Excl. rows</th>
                <th className="text-right px-3 py-2">Net</th>
                <th className="text-right px-3 py-2">Excl. %</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">
                    No collections in this range.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const pct = r.total_amount > 0 ? (r.excluded_amount / r.total_amount) * 100 : 0;
                  return (
                    <tr
                      key={r.day}
                      className="border-t cursor-pointer hover:bg-muted/40"
                      onClick={() => setDrillDay(r.day)}
                      role="button"
                      title="Open drilldown"
                    >
                      <td className="px-3 py-2 font-medium underline-offset-2 hover:underline">
                        {r.day}
                      </td>
                      <td className="px-3 py-2 text-right">{formatUGX(r.total_amount)}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{r.total_rows}</td>
                      <td className="px-3 py-2 text-right text-amber-600 dark:text-amber-400">
                        {formatUGX(r.excluded_amount)}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{r.excluded_rows}</td>
                      <td className="px-3 py-2 text-right font-semibold">{formatUGX(r.net_amount)}</td>
                      <td className="px-3 py-2 text-right">
                        {pct >= 25 ? (
                          <Badge variant="secondary" className="text-amber-700 dark:text-amber-400">
                            {pct.toFixed(1)}%
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">{pct.toFixed(1)}%</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <ReconciliationDrilldown day={drillDay} onClose={() => setDrillDay(null)} />
      </CardContent>
    </Card>
  );
}

function SummaryTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${tone ?? ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export default CollectedReconciliationPanel;

// --- Drilldown ---------------------------------------------------------------

type DetailRow = {
  id: string;
  amount: number;
  created_at: string;
  tracking_id: string | null;
  rent_request_id: string | null;
  agent_id: string | null;
};

async function fetchDayDetails(day: string): Promise<{
  included: DetailRow[];
  excluded: DetailRow[];
}> {
  const s = new Date(`${day}T00:00:00`);
  const e = new Date(s);
  e.setDate(e.getDate() + 1);

  const PAGE = 1000;
  let from = 0;
  const all: DetailRow[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from("agent_collections")
      .select("id, amount, created_at, tracking_id, rent_request_id, agent_id")
      .is("reversed_at", null)
      .gte("created_at", s.toISOString())
      .lt("created_at", e.toISOString())
      .gt("amount", 0)
      .like("tracking_id", "AGT-%")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data as DetailRow[]) || [];
    all.push(...page);
    if (page.length < PAGE) break;
    from += PAGE;
  }

  const rrIds = Array.from(
    new Set(all.map((r) => r.rent_request_id).filter((x): x is string => !!x)),
  );
  const excludedRR = new Set<string>();
  const BATCH = 200;
  for (let i = 0; i < rrIds.length; i += BATCH) {
    const chunk = rrIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("agent_landlord_float_allocations")
      .select("rent_request_id")
      .in("rent_request_id", chunk);
    if (error) throw error;
    (data || []).forEach((r: any) => {
      if (r.rent_request_id) excludedRR.add(r.rent_request_id);
    });
  }

  const included: DetailRow[] = [];
  const excluded: DetailRow[] = [];
  all.forEach((r) => {
    if (r.rent_request_id && excludedRR.has(r.rent_request_id)) excluded.push(r);
    else included.push(r);
  });
  return { included, excluded };
}

function copyToClipboard(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

function DetailTable({
  rows,
  emptyLabel,
  showRentRequest,
}: {
  rows: DetailRow[];
  emptyLabel: string;
  showRentRequest?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-muted-foreground px-3 py-6 text-center">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border max-h-[55vh]">
      <table className="w-full text-xs">
        <thead className="bg-muted/40 text-muted-foreground sticky top-0">
          <tr>
            <th className="text-left px-2 py-1.5">Time</th>
            <th className="text-left px-2 py-1.5">Tracking ID</th>
            <th className="text-left px-2 py-1.5">
              {showRentRequest ? "Rent request" : "Rent request"}
            </th>
            <th className="text-left px-2 py-1.5">Agent</th>
            <th className="text-right px-2 py-1.5">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-2 py-1.5 whitespace-nowrap">
                {new Date(r.created_at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
              <td className="px-2 py-1.5 font-mono">{r.tracking_id ?? "—"}</td>
              <td className="px-2 py-1.5 font-mono text-muted-foreground">
                {r.rent_request_id ? r.rent_request_id.slice(0, 8) : "—"}
              </td>
              <td className="px-2 py-1.5 font-mono text-muted-foreground">
                {r.agent_id ? r.agent_id.slice(0, 8) : "—"}
              </td>
              <td className="px-2 py-1.5 text-right font-medium">
                {formatUGX(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReconciliationDrilldown({
  day,
  onClose,
}: {
  day: string | null;
  onClose: () => void;
}) {
  const open = !!day;
  const { data, isLoading, error } = useQuery({
    queryKey: ["collected-reconciliation-drill", day],
    queryFn: () => fetchDayDetails(day!),
    enabled: open,
    staleTime: 60_000,
  });

  const included = data?.included ?? [];
  const excluded = data?.excluded ?? [];
  const includedTotal = included.reduce((s, r) => s + r.amount, 0);
  const excludedTotal = excluded.reduce((s, r) => s + r.amount, 0);

  const copyIds = (rows: DetailRow[], field: "tracking_id" | "rent_request_id") => {
    const ids = Array.from(
      new Set(rows.map((r) => r[field]).filter((x): x is string => !!x)),
    );
    copyToClipboard(ids.join("\n"));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Reconciliation — {day}</DialogTitle>
          <DialogDescription>
            AGT-* collections captured on this day. "Excluded" rows are those
            whose rent_request was CFO-funded via landlord float and are removed
            from Fleet "Collected".
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Failed to load details.
          </div>
        )}

        <Tabs defaultValue="included" className="w-full">
          <TabsList>
            <TabsTrigger value="included">
              Included · {included.length} · {formatUGX(includedTotal)}
            </TabsTrigger>
            <TabsTrigger value="excluded">
              Excluded (LLF) · {excluded.length} · {formatUGX(excludedTotal)}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="included" className="space-y-2">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyIds(included, "tracking_id")}
                disabled={!included.length}
              >
                Copy tracking IDs
              </Button>
            </div>
            {isLoading ? (
              <div className="text-sm text-muted-foreground px-3 py-6 text-center">
                Loading…
              </div>
            ) : (
              <DetailTable
                rows={included}
                emptyLabel="No included AGT-* rows for this day."
              />
            )}
          </TabsContent>

          <TabsContent value="excluded" className="space-y-2">
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyIds(excluded, "rent_request_id")}
                disabled={!excluded.length}
              >
                Copy rent_request IDs
              </Button>
            </div>
            {isLoading ? (
              <div className="text-sm text-muted-foreground px-3 py-6 text-center">
                Loading…
              </div>
            ) : (
              <DetailTable
                rows={excluded}
                emptyLabel="No landlord-float exclusions for this day."
                showRentRequest
              />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
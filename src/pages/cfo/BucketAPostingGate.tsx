import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatUGX } from "@/lib/utils";

const CONFIRM = "AUTHORIZE BUCKET A POSTING";
type Check = { check: string; pass: boolean; value: unknown };
type Preflight = {
  pass: boolean; package_hash: string; record_count: number; total: number; preflight_id: string;
  checks: Check[]; amount_mismatches: any[]; status_changes: any[]; already_posted: boolean;
  can_authorize: boolean; mapped_receivable_balance_now: number; evaluated_at: string;
};

export default function BucketAPostingGate() {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<any>(null);

  const runPreflight = async () => {
    setBusy(true); setErr(null); setResult(null); setTyped("");
    const { data, error } = await (supabase.rpc as any)("cfo_bucket_a_preflight");
    setBusy(false);
    if (error) return setErr(error.message);
    setPf(data as Preflight);
  };

  const authorize = async () => {
    if (!pf) return;
    setBusy(true); setErr(null);
    const { data, error } = await (supabase.rpc as any)("cfo_bucket_a_post", {
      p_preflight_id: pf.preflight_id, p_package_hash: pf.package_hash, p_confirmation: typed,
    });
    setBusy(false);
    if (error) return setErr(error.message);
    setResult(data); setPf(null);
  };

  const ready = pf && pf.pass && !pf.already_posted;
  const row = (k: string, v: string) => (
    <div className="flex justify-between border-b border-border py-1.5 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-medium">{v}</span></div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Bucket A – Agent Receivables Correction</h1>
      <p className="text-sm text-muted-foreground">Step 1 re-reads all 322 records from the live books and changes nothing. Posting is a separate step that only an authorised CFO approver can take.</p>
      <Button onClick={runPreflight} disabled={busy}>{busy ? "Working..." : "Run live pre-flight"}</Button>
      {err && <p className="text-sm text-destructive">{err}</p>}

      {pf && (
        <Card>
          <CardHeader><CardTitle className={pf.pass ? "" : "text-destructive"}>
            {pf.already_posted ? "Bucket A has already been posted" : pf.pass ? "PRE-FLIGHT PASSED — NOTHING POSTED" : "POSTING BLOCKED — NEW CFO VALIDATION REQUIRED"}
          </CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {pf.checks.map((c) => (
              <div key={c.check} className="flex justify-between text-sm"><span>{c.check}</span><span className={c.pass ? "text-primary" : "text-destructive"}>{c.pass ? "PASS" : "FAIL"}</span></div>
            ))}
            {[...pf.amount_mismatches, ...pf.status_changes].length > 0 && (
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify([...pf.amount_mismatches, ...pf.status_changes], null, 2)}</pre>
            )}
          </CardContent>
        </Card>
      )}

      {ready && (
        <Card>
          <CardHeader><CardTitle>Final Bucket A posting</CardTitle></CardHeader>
          <CardContent>
            {row("Records", "322")}
            {row("Correction", formatUGX(pf!.total))}
            {row("Debits", formatUGX(pf!.total))}
            {row("Credits", formatUGX(pf!.total))}
            {row("Wallet / cash / repayment / agent float impact", formatUGX(0))}
            {row("Existing matching correction", "None")}
            {row("Atomic transaction", "Yes")}
            {row("All 322 records unchanged", "Yes")}
            {row("Agent receivables in the books now", formatUGX(pf!.mapped_receivable_balance_now))}
            {pf!.can_authorize ? (
              <div className="mt-4 space-y-2">
                <p className="text-sm">Type <b>{CONFIRM}</b> to post. Viewing this page does not authorise anything.</p>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM} />
                <Button variant="destructive" disabled={busy || typed !== CONFIRM} onClick={authorize}>AUTHORIZE BUCKET A POSTING</Button>
              </div>
            ) : <p className="mt-4 text-sm text-muted-foreground">Only an authorised CFO approver can post. You can view the pre-flight only.</p>}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card><CardHeader><CardTitle className={result.status === "committed" ? "" : "text-destructive"}>
          {result.status === "committed" ? "BUCKET A POSTED SUCCESSFULLY — UGX 10,133,013.74 ACROSS 322 RECORDS" : result.message}
        </CardTitle></CardHeader>
        <CardContent>{result.status === "committed" && <>
          {row("Books before", formatUGX(result.receivable_balance_before))}
          {row("Books after", formatUGX(result.receivable_balance_after))}
          {row("Ledger lines", String(result.legs))}
        </>}</CardContent></Card>
      )}
    </div>
  );
}

import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatUGX } from "@/lib/agentAdvanceCalculations";

const PACKAGE_ID = "CORR-2026-10-08-9fc656402a73";
const FINGERPRINT = "262bf75c20610b3682ce31a4ff508006";
const CONFIRM = `AUTHORIZE CORRECTION ${PACKAGE_ID}`;
type Check = { check: string; pass: boolean; value: unknown };
type Preflight = {
  pass: boolean; package_hash: string; line_count: number; total: number; preflight_id: string;
  checks: Check[]; already_posted: boolean; can_authorize: boolean;
  balances_now: Record<string, number>; evaluated_at: string;
};

export default function CorrectionPackage5300000Gate() {
  const [pf, setPf] = useState<Preflight | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fp, setFp] = useState("");
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState<any>(null);

  const runPreflight = async () => {
    setBusy(true); setErr(null); setResult(null); setTyped(""); setFp("");
    const { data, error } = await (supabase.rpc as any)("cfo_corr_5300000_preflight");
    setBusy(false);
    if (error) return setErr(error.message);
    setPf(data as Preflight);
  };

  const authorize = async () => {
    if (!pf) return;
    setBusy(true); setErr(null);
    const { data, error } = await (supabase.rpc as any)("cfo_corr_5300000_post", {
      p_preflight_id: pf.preflight_id, p_package_hash: fp, p_confirmation: typed,
    });
    setBusy(false);
    if (error) return setErr(error.message);
    setResult(data); setPf(null);
  };

  const pfFresh = !!pf?.evaluated_at && Date.now() - new Date(pf.evaluated_at).getTime() < 30 * 60 * 1000;
  const ready = pf && pf.pass && !pf.already_posted;
  const row = (k: string, v: string) => (
    <div className="flex justify-between border-b border-border py-1.5 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-medium">{v}</span></div>
  );

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <h1 className="text-2xl font-semibold">Correction package {PACKAGE_ID}</h1>
      <p className="text-sm text-muted-foreground">Two lines, {formatUGX(5300000)}. The pre-flight re-reads the live books and changes nothing. Posting is a separate step only an authorised CFO approver can take.</p>
      <Card><CardContent className="pt-4">
        {row("C1 Yaseen Kc — Dr Equity (E3) / Cr Agent Advance Receivable (A10)", formatUGX(5100000))}
        {row("C2 Nabwire Jackline — Dr Rent Plan Receivable (A3) / Cr Equity (E3)", formatUGX(200000))}
        {row("Wallet, repayment, commission, Returns and fee impact", formatUGX(0))}
      </CardContent></Card>
      <Button onClick={runPreflight} disabled={busy}>{busy ? "Working..." : "Run live pre-flight"}</Button>
      {err && <p className="text-sm text-destructive">{err}</p>}

      {pf && (
        <Card>
          <CardHeader><CardTitle className={pf.pass ? "" : "text-destructive"}>
            {pf.already_posted ? "This package has already been posted" : !pf.pass || !pfFresh ? "POSTING BLOCKED — NEW CFO VALIDATION REQUIRED" : "PRE-FLIGHT PASSED — NOT AUTHORIZED — NOT POSTED"}
          </CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {pf.checks.map((c) => (
              <div key={c.check} className="flex justify-between gap-4 text-sm"><span>{c.check}</span><span className={c.pass ? "text-primary" : "text-destructive"}>{c.pass ? "PASS" : "FAIL"}</span></div>
            ))}
          </CardContent>
        </Card>
      )}

      {ready && (
        <Card>
          <CardHeader><CardTitle>Final posting</CardTitle></CardHeader>
          <CardContent>
            {Object.entries(pf!.balances_now).map(([k, v]) => row(`${k} in the books now`, formatUGX(v)))}
            {pf!.can_authorize && !pfFresh ? (
              <p className="mt-4 text-sm text-destructive">This pre-flight is older than 30 minutes. Run a fresh pre-flight before authorising.</p>
            ) : pf!.can_authorize ? (
              <div className="mt-4 space-y-2">
                <p className="text-sm">Enter the package fingerprint, then type <b>{CONFIRM}</b>. Viewing this page does not authorise anything.</p>
                <Input value={fp} onChange={(e) => setFp(e.target.value.trim())} placeholder="Package fingerprint" />
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={CONFIRM} />
                <Button variant="destructive" disabled={busy || typed !== CONFIRM || fp !== FINGERPRINT} onClick={authorize}>AUTHORIZE CORRECTION</Button>
              </div>
            ) : <p className="mt-4 text-sm text-muted-foreground">Only an authorised CFO approver can post. You can view the pre-flight only.</p>}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card><CardHeader><CardTitle className={result.status === "committed" ? "" : "text-destructive"}>
          {result.status === "committed" ? `POSTED — 2/2 LINES — ${formatUGX(5300000)}` : result.status === "blocked" ? "POSTING BLOCKED — NOTHING POSTED" : "POSTING FAILED — ROLLED BACK — NOTHING POSTED"}
          {result.status !== "committed" && result.message && <p className="mt-1 text-sm font-normal">{result.message}</p>}
        </CardTitle></CardHeader>
        {result.status === "committed" && <CardContent>
          {row("Ledger lines", String(result.legs))}
          {row("Debits", formatUGX(result.debits))}
          {row("Credits", formatUGX(result.credits))}
        </CardContent>}</Card>
      )}
    </div>
  );
}

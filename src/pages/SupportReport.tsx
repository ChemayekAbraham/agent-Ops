import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2, ShieldAlert, ClipboardCopy, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface ReportData {
  report: string;
  createdAt: string;
  expiresAt: string;
  viewCount: number;
}

export default function SupportReport() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!token) {
        setError("Missing report token.");
        setLoading(false);
        return;
      }
      try {
        const { data: res, error: fnError } = await supabase.functions.invoke(
          "view-diagnostics-report",
          { body: { token } }
        );
        if (!active) return;
        if (fnError) {
          // Map known statuses to friendly text
          const ctx = (fnError as any)?.context;
          if (ctx?.status === 404) setError("This support link is invalid or no longer exists.");
          else if (ctx?.status === 410) setError("This support link has expired.");
          else setError("Could not load this report. Please try again.");
        } else if (res?.report) {
          setData({
            report: res.report,
            createdAt: res.createdAt,
            expiresAt: res.expiresAt,
            viewCount: res.viewCount,
          });
        } else {
          setError(res?.error === "expired" ? "This support link has expired." : "Report not found.");
        }
      } catch {
        if (active) setError("Could not load this report. Please try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [token]);

  const copyReport = async () => {
    if (!data?.report) return;
    try {
      await navigator.clipboard.writeText(data.report);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = data.report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-4">
        <header>
          <h1 className="text-xl font-bold">Support diagnostics report</h1>
          <p className="text-sm text-muted-foreground">One-time link for the support team</p>
        </header>

        {loading && (
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading report…
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-6">
            <ShieldAlert className="mt-0.5 h-5 w-5 text-destructive" />
            <div>
              <p className="text-sm font-medium">Unable to open report</p>
              <p className="mt-1 text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        {!loading && data && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                <div>Generated: {new Date(data.createdAt).toLocaleString()}</div>
                <div>Expires: {new Date(data.expiresAt).toLocaleString()}</div>
                <div>Views: {data.viewCount}</div>
              </div>
              <button
                onClick={copyReport}
                className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-2 text-sm font-medium hover:bg-muted/80"
              >
                {copied ? <CheckCircle2 className="h-4 w-4 text-green-500" /> : <ClipboardCopy className="h-4 w-4" />}
                {copied ? "Copied!" : "Copy report"}
              </button>
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {data.report}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

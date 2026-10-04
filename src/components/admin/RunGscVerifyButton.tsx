import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Search, Loader2, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

interface GscResult {
  done: boolean;
  reason?: string;
  message?: string;
  verified?: boolean;
  sitemapSubmitted?: boolean;
  steps?: Record<string, unknown>;
}

export default function RunGscVerifyButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GscResult | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke('gsc-auto-verify', { body: {} });
      if (error) throw error;
      const res = data as GscResult;
      setResult(res);
      if (res.done) {
        toast.success('Verified & sitemap submitted to Google Search Console');
      } else if (res.reason === 'verification_tag_not_live_yet') {
        toast.warning('Verification tag not live yet — publish the site, then run again');
      } else {
        toast.warning('Could not complete yet — see details');
      }
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || 'Run failed');
    } finally {
      setRunning(false);
    }
  };

  const pending = result && !result.done;

  return (
    <div className="space-y-3 p-4 rounded-xl border-2 bg-card">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Search className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm">Google Search Console</p>
            <p className="text-xs text-muted-foreground">Verify domain & submit sitemap now (also retries every 30 min)</p>
          </div>
        </div>
        <Button onClick={handleRun} disabled={running} size="sm" className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {running ? 'Running…' : 'Run now'}
        </Button>
      </div>

      {result?.done && (
        <div className="rounded-lg border bg-emerald-500/5 border-emerald-500/30 p-3 space-y-1">
          <div className="flex items-center gap-2 text-emerald-700 text-sm font-semibold">
            <CheckCircle2 className="h-4 w-4" />
            Verified and sitemap submitted
          </div>
          <p className="text-xs text-muted-foreground">
            Google Search Console now owns this domain and has the sitemap. Indexing data appears within a few days.
          </p>
        </div>
      )}

      {pending && result?.reason === 'verification_tag_not_live_yet' && (
        <div className="rounded-lg border bg-amber-500/5 border-amber-500/30 p-3 space-y-1">
          <div className="flex items-center gap-2 text-amber-700 text-sm font-semibold">
            <Clock className="h-4 w-4" />
            Waiting for the live site
          </div>
          <p className="text-xs text-muted-foreground">
            {result.message || 'Publish the updated site so the verification tag appears on the live domain, then run again.'}
          </p>
        </div>
      )}

      {pending && result?.reason !== 'verification_tag_not_live_yet' && (
        <div className="rounded-lg border bg-destructive/5 border-destructive/30 p-3 space-y-1">
          <div className="flex items-center gap-2 text-destructive text-sm font-semibold">
            <AlertTriangle className="h-4 w-4" />
            Could not complete
          </div>
          <p className="text-xs text-muted-foreground break-all">
            {result?.reason || 'Unknown issue'} — the scheduled job will keep retrying.
          </p>
        </div>
      )}
    </div>
  );
}
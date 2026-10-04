import { useEffect, useState } from 'react';
import { AlertTriangle, Copy, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { readOAuthError, clearOAuthError, type OAuthErrorRecord } from '@/lib/oauthErrorLog';
import { useToast } from '@/hooks/use-toast';

/**
 * Persistent, user-visible OAuth failure card. Surfaces the exact reason
 * and timestamp (plus expandable diagnostics) so support can debug without
 * chasing screenshots of transient toasts.
 */
export function OAuthErrorCard() {
  const [err, setErr] = useState<OAuthErrorRecord | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setErr(readOAuthError());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<OAuthErrorRecord | null>).detail;
      setErr(detail ?? readOAuthError());
    };
    window.addEventListener('welile:oauth-error', onChange);
    return () => window.removeEventListener('welile:oauth-error', onChange);
  }, []);

  if (!err) return null;

  const when = new Date(err.at);
  const relative = formatRelative(when);
  const providerLabel = err.provider === 'google' ? 'Google' : err.provider === 'apple' ? 'Apple' : err.provider;

  const copyAll = async () => {
    const payload = [
      `Provider: ${providerLabel}`,
      `Time: ${when.toLocaleString()} (${relative})`,
      err.code ? `Code: ${err.code}` : null,
      `Message: ${err.message}`,
      err.context ? `Context: ${err.context}` : null,
      err.url ? `URL: ${err.url}` : null,
      err.userAgent ? `UA: ${err.userAgent}` : null,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      toast({ title: 'Copied error details', description: 'Paste this to support so we can debug it.' });
    } catch {
      toast({ title: 'Copy failed', description: 'Long-press to copy manually.', variant: 'destructive' });
    }
  };

  return (
    <div className="mb-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-left animate-in fade-in slide-in-from-top-1">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-destructive">
              {providerLabel} sign-in failed
            </p>
            <button
              onClick={() => { clearOAuthError(); setErr(null); }}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {relative} · {when.toLocaleTimeString()}
          </p>
          <p className="mt-2 text-sm text-foreground break-words">
            {err.message || 'Unknown error'}
          </p>
          {err.code && (
            <p className="mt-1 text-[11px] font-mono text-muted-foreground">code: {err.code}</p>
          )}

          <div className="flex items-center gap-2 mt-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronUp className="h-3 w-3 mr-1" /> : <ChevronDown className="h-3 w-3 mr-1" />}
              {expanded ? 'Hide details' : 'Show details'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={copyAll}
            >
              <Copy className="h-3 w-3 mr-1" /> Copy
            </Button>
          </div>

          {expanded && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/60 p-2 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
{`context: ${err.context || '—'}
url: ${err.url || '—'}
ua: ${err.userAgent || '—'}
at: ${err.at}`}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function formatRelative(d: Date) {
  const secs = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
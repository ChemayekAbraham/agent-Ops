import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AlertTriangle, Check, Copy, Fingerprint, ScanFace, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';

/**
 * The face-recognition record behind a rent request's passport photo.
 *
 * Every passport photo is graded before it can be submitted, and the SHA-256 of
 * the exact bytes that were graded is kept. Two things matter to a reviewer:
 *
 *   1. Did the checker actually find a face, and was the photo passport-grade?
 *   2. Has this identical image been used on ANYONE ELSE?
 *
 * The second is what a hash is uniquely good for. The same photo appearing on
 * two registrations is not a quality problem — it is one person being presented
 * as two, and it is called out in red here.
 *
 * Read-only: `identity_photo_checks_for_request` proves the caller may see this
 * request before it returns anything.
 */
interface PhotoCheck {
  sha256: string;
  source: string | null;
  verdict: string | null;
  score: number | null;
  is_face: boolean | null;
  is_passport_photo: boolean | null;
  failures: { id?: string; label?: string; severity?: string; advice?: string }[] | null;
  photo_url: string | null;
  checked_at: string;
  checked_by_name: string | null;
  also_on_other_people: number;
}

const SOURCE_LABEL: Record<string, string> = {
  tenant_onboarding: 'Tenant self-onboarding',
  agent_rent_request: 'Agent registration',
};

function HashLine({ sha256 }: { sha256: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sha256);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error('Could not copy the hash');
        }
      }}
      className="group flex w-full items-start gap-1.5 rounded-md bg-background/70 px-2 py-1.5 text-left transition-colors hover:bg-background"
      title="Copy the full hash"
    >
      <Fingerprint className="mt-px h-3 w-3 shrink-0 text-muted-foreground" />
      <code className="min-w-0 flex-1 break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
        {sha256}
      </code>
      {copied
        ? <Check className="mt-px h-3 w-3 shrink-0 text-emerald-600" />
        : <Copy className="mt-px h-3 w-3 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />}
    </button>
  );
}

export function TenantPhotoChecksPanel({ rentRequestId }: { rentRequestId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['identity-photo-checks', rentRequestId],
    enabled: !!rentRequestId,
    staleTime: 60_000,
    queryFn: async (): Promise<PhotoCheck[]> => {
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string, args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'identity_photo_checks_for_request', { p_rent_request_id: rentRequestId },
      );
      if (error) throw new Error(error.message);
      return (data as PhotoCheck[]) ?? [];
    },
  });

  if (isLoading) {
    return <p className="text-[10px] text-muted-foreground">Loading the face check…</p>;
  }

  const checks = data ?? [];
  if (checks.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <ScanFace className="h-3 w-3 shrink-0" />
        No face check on record — this photo predates the check, or it was posted while the checker was unavailable.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {checks.map((c) => {
        const reused = (c.also_on_other_people ?? 0) > 0;
        const noFace = c.is_face === false;
        return (
          <div
            key={c.sha256}
            className={`rounded-lg border p-2 space-y-1.5 ${
              reused || noFace ? 'border-destructive/50 bg-destructive/5' : 'border-border bg-muted/40'
            }`}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <ScanFace className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="text-[11px] font-semibold">
                {noFace ? 'No face detected' : c.is_face ? 'Face recognised' : 'Face not confirmed'}
              </span>
              {c.verdict && (
                <Badge
                  variant={c.verdict === 'pass' ? 'default' : c.verdict === 'fail' ? 'destructive' : 'secondary'}
                  className="h-4 px-1.5 text-[9px] uppercase tracking-wide"
                >
                  {c.verdict}
                </Badge>
              )}
              {c.is_passport_photo === false && (
                <Badge variant="outline" className="h-4 px-1.5 text-[9px]">Not passport-style</Badge>
              )}
              {typeof c.score === 'number' && (
                <span className="text-[10px] text-muted-foreground">score {Number(c.score).toFixed(2)}</span>
              )}
            </div>

            {reused && (
              <p className="flex items-start gap-1.5 text-[11px] font-semibold text-destructive">
                <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
                This exact image is also on {c.also_on_other_people} other{' '}
                {c.also_on_other_people === 1 ? 'person' : 'people'} — check before approving.
              </p>
            )}

            {(c.failures?.length ?? 0) > 0 && (
              <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                {c.failures!.map((f) => f.label).filter(Boolean).join(', ')}
              </p>
            )}

            <HashLine sha256={c.sha256} />

            <p className="text-[9px] text-muted-foreground">
              {SOURCE_LABEL[c.source ?? ''] ?? c.source ?? 'Unknown source'}
              {c.checked_by_name ? ` · captured by ${c.checked_by_name}` : ''}
              {' · '}
              {new Date(c.checked_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
            </p>
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Download, ExternalLink, FileText, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { useToast } from '@/hooks/use-toast';
import {
  classifyProof, getFreshProofUrl, isPdfProof, resolveProofPath, type ProofSource,
} from '@/lib/payoutProof';

export type ProofDialogRow = ProofSource & {
  id: string;
  amount: number;
  payout_proof_uploaded_at?: string | null;
  uploaded_by_name?: string | null;
  user_name?: string | null;
  agent_name?: string | null;
  receipt_token?: string | null;
};

/**
 * Proof-of-payment preview for the FinOps Receipt Archive. Always re-signs a
 * fresh URL from the stored storage path — never trusts the persisted link.
 */
export function PayoutProofDialog({
  row, open, onOpenChange,
}: { row: ProofDialogRow | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { toast } = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const state = row ? classifyProof(row) : 'missing';
  const pdf = row ? isPdfProof(row) : false;

  useEffect(() => {
    if (!open || !row || state !== 'attached') { setUrl(null); setErr(null); return; }
    let alive = true;
    setLoading(true); setErr(null);
    getFreshProofUrl(row, { expiresIn: 60 * 15 })
      .then((u) => { if (alive) setUrl(u); })
      .catch((e) => { if (alive) setErr(e?.message || 'Could not load proof'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, row, state]);

  const download = async () => {
    if (!row) return;
    try {
      const u = await getFreshProofUrl(row, { download: true, expiresIn: 60 * 5 });
      window.open(u, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      toast({ title: 'Download failed', description: e?.message, variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-primary" /> Proof of payment
          </DialogTitle>
        </DialogHeader>

        {!row ? null : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
              <Meta label="Withdrawal ref" value={row.receipt_token ? `RCPT-${row.receipt_token.slice(0, 8).toUpperCase()}` : row.id.slice(0, 8).toUpperCase()} />
              <Meta label="Amount" value={formatUGX(Number(row.amount || 0))} />
              <Meta label="Merchant agent" value={row.agent_name || '—'} />
              <Meta label="Customer" value={row.user_name || '—'} />
              <Meta label="Uploaded" value={row.payout_proof_uploaded_at ? format(new Date(row.payout_proof_uploaded_at), 'MMM d, yyyy HH:mm') : '—'} />
              <Meta label="Uploaded by" value={row.uploaded_by_name || '—'} />
              <Meta label="File type" value={row.payout_proof_type || (pdf ? 'application/pdf' : '—')} />
              <Meta label="Storage path" value={resolveProofPath(row) || '—'} mono />
            </div>

            {state !== 'attached' ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700 flex items-start gap-2">
                <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <Badge variant="outline" className="mb-1 text-[10px]">
                    {state === 'legacy' ? 'Legacy record' : 'Proof missing'}
                  </Badge>
                  <p>No uploaded proof available.</p>
                  {state === 'legacy' && row.payout_proof && (
                    <p className="mt-1 font-mono text-[11px] break-all opacity-80">{row.payout_proof}</p>
                  )}
                </div>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : err ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{err}</div>
            ) : url ? (
              <div className="rounded-lg border bg-muted/30 overflow-hidden">
                {pdf ? (
                  <iframe src={url} title="Proof of payment PDF" className="w-full h-[60vh]" />
                ) : (
                  <img src={url} alt="Merchant payout proof of payment" className="w-full max-h-[60vh] object-contain bg-background" loading="lazy" />
                )}
              </div>
            ) : null}

            {state === 'attached' && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={download}>
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Download
                </Button>
                <Button size="sm" variant="outline" disabled={!url} onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}>
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open full size
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5 min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`truncate text-xs font-medium ${mono ? 'font-mono' : ''}`} title={value}>{value}</div>
    </div>
  );
}

export default PayoutProofDialog;
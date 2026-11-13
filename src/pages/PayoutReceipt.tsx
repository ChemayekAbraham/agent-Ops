import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, AlertTriangle, Clock, Download, ShieldCheck } from 'lucide-react';
import { downloadPayoutReceiptPdf, type PayoutReceiptData as ReceiptData } from '@/lib/payoutReceiptPdf';
import { copyFromPayoutReceipt } from '@/lib/payoutReceiptCopy';
import { verifyReceiptChecksum } from '@/lib/receiptVerification';
import { ReceiptCopy } from '@/components/financial-ops/ReceiptCopy';
import ScreenLoader from '@/components/common/ScreenLoader';

/**
 * Public proof-of-payment receipt. Opens instantly from the SMS link a customer
 * receives once a merchant agent confirms their payout — no sign-in, no redirect.
 * Reached via an unguessable token (/r/:token) or, for authenticated in-app use,
 * by withdrawal id (/receipt/:id). It is the same black-and-white receipt, in the
 * paper-book layout, that the company holds in its Receipt Archive and that the
 * PDF download produces (src/lib/receiptCopy.ts), with a QR code that resolves
 * back to this URL and a one-tap PDF download. It never shows the merchant's commission.
 */
export default function PayoutReceipt() {
  const { id, token, code } = useParams<{ id?: string; token?: string; code?: string }>();
  // The public `/r/:code` route shares its namespace with short links; when it
  // falls through to this receipt view the param arrives as `code`.
  const receiptToken = token ?? code;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ReceiptData | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!id && !receiptToken) {
      setError('Missing receipt reference');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { data: res, error: rpcErr } = receiptToken
          ? await supabase.rpc('get_payout_receipt_by_token' as any, { p_token: receiptToken })
          : await supabase.rpc('get_payout_receipt', { p_withdrawal_id: id as string });
        if (rpcErr) throw rpcErr;
        if (!res) setError('Receipt not found');
        else setData(res as unknown as ReceiptData);
      } catch (e: any) {
        setError(e.message || 'Failed to load receipt');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, receiptToken]);

  // When the receipt is opened from a scanned QR/URL that carries a `c=` code,
  // recompute the checksum from the server-loaded receipt and confirm it matches.
  const providedChecksum =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('c')
      : null;
  const checksumVerified = data ? verifyReceiptChecksum(data, providedChecksum) : false;

  if (loading) {
    return (
      <ScreenLoader className="bg-muted/30" />
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-6 text-center">
        <AlertTriangle className="h-10 w-10 text-muted-foreground mb-3" />
        <p className="text-lg font-semibold">Receipt unavailable</p>
        <p className="text-sm text-muted-foreground mt-1">{error || 'This receipt could not be found.'}</p>
      </div>
    );
  }

  if (!data.paid) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-6 text-center">
        <Clock className="h-10 w-10 text-amber-500 mb-3" />
        <p className="text-lg font-semibold">Payment not completed yet</p>
        <p className="text-sm text-muted-foreground mt-1">
          This withdrawal has not been paid. A receipt will appear here once it is processed.
        </p>
      </div>
    );
  }

  const copy = copyFromPayoutReceipt(data, null);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadPayoutReceiptPdf(data);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/30 py-6 px-3 sm:px-4 flex justify-center">
      <div className="w-full max-w-[880px]">
        <ReceiptCopy data={copy} />

        {/* The paper layout is landscape; on a phone it shrinks, so the same facts are repeated here at a readable size. */}
        <div className="sm:hidden mt-3 rounded-2xl border border-border bg-card p-4">
          <p className="text-3xl font-extrabold tabular-nums text-foreground text-center">{formatUGX(copy.amount)}</p>
          <p className="text-xs text-muted-foreground text-center mt-1">Receipt No. {copy.numberLabel} · {copy.dateLabel}</p>
          <dl className="mt-3 divide-y divide-border">
            {copy.lines.filter((l) => l.label !== 'A sum of Shillings:' && l.value).map((l) => (
              <div key={l.label} className="py-2 flex items-start justify-between gap-3">
                <dt className="text-sm text-muted-foreground shrink-0">{l.label.replace(/:$/, '')}</dt>
                <dd className="text-sm font-semibold text-right break-words">{l.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        {checksumVerified && (
          <p className="mt-3 text-sm text-emerald-700 font-semibold inline-flex items-center gap-1.5 w-full justify-center">
            <ShieldCheck className="h-4 w-4" /> Authenticity verified
          </p>
        )}

        {/* Download (functional action, outside the receipt) */}
        <button
          onClick={downloadPdf}
          disabled={downloading}
          className="mt-4 w-full max-w-md mx-auto inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-4 py-3 text-sm font-semibold disabled:opacity-60"
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {downloading ? 'Preparing PDF…' : 'Download PDF receipt'}
        </button>
        <p className="mt-3 text-center text-[12px] text-muted-foreground">
          This receipt was generated electronically. Scan the QR code, or open welileapp.com, to verify it.
        </p>
      </div>
    </div>
  );
}

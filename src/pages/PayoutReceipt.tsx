import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { QRCodeCanvas } from 'qrcode.react';
import { Loader2, AlertTriangle, Clock, Download, ScanLine, ShieldCheck } from 'lucide-react';
import welileWordmark from '@/assets/welile-wordmark.png';
import { downloadPayoutReceiptPdf, receiptMethodLabel, receiptQrValue, type PayoutReceiptData as ReceiptData } from '@/lib/payoutReceiptPdf';
import { verifyReceiptChecksum } from '@/lib/receiptVerification';
import { WelileStamp } from '@/components/receipts/WelileStamp';
import ScreenLoader from '@/components/common/ScreenLoader';

/**
 * Public proof-of-payment receipt. Opens instantly from the SMS link a customer
 * receives once a merchant agent confirms their payout — no sign-in, no redirect.
 * Reached via an unguessable token (/r/:token) or, for authenticated in-app use,
 * by withdrawal id (/receipt/:id). Shows who was paid, how, the TID, amount,
 * commission, branch, date/time and the processing agent, plus a QR code that
 * resolves back to the same URL and a one-tap PDF download.
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

  // Canonical QR value for this receipt — the public URL plus an authenticity
  // checksum, used by both the on-screen QR and the PDF.
  const qrValue = data ? receiptQrValue(data) : '';
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

  const { isBank, isMoMo, methodLabel } = receiptMethodLabel(data.payout_method);

  const paidAt = data.processed_at ? new Date(data.processed_at) : null;
  const dateStr = paidAt
    ? paidAt.toLocaleString('en-UG', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—';

  const Row = ({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) =>
    value ? (
      <div className="flex items-start justify-between gap-3 py-3">
        <span className="text-sm text-muted-foreground shrink-0">{label}</span>
        <span className={`text-sm font-semibold text-right break-words text-foreground ${mono ? 'font-mono tracking-wide' : ''}`}>{value}</span>
      </div>
    ) : null;

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadPayoutReceiptPdf(data);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/30 py-8 px-4 flex justify-center">
      <div className="w-full max-w-md">
        <div className="relative bg-card rounded-[28px] shadow-xl overflow-hidden border border-border">
          {/* Authenticity e-stamp watermark, stamped across every receipt */}
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center overflow-hidden">
            <WelileStamp watermark scale={0.62} date={data.processed_at} />
          </div>
          {/* Header */}
          <div className="bg-primary text-primary-foreground px-6 pt-8 pb-7 text-center">
            <div className="mb-3 flex justify-center">
              <div className="inline-flex items-start gap-0.5 rounded-2xl bg-white px-5 py-3 shadow-sm">
                <img src={welileWordmark} alt="Welile" className="h-9 w-auto" />
                <span className="mt-0.5 text-[13px] font-bold leading-none text-primary">™</span>
              </div>
            </div>
            <p className="text-[15px] opacity-90">Digital Transaction Receipt</p>
            <p className="text-sm font-bold tracking-wide mt-2">STATUS : COMPLETED</p>
          </div>

          {/* Body */}
          <div className="px-6 py-6">
            {/* Amount */}
            <div className="text-center pb-5">
              <p className="text-4xl font-extrabold tabular-nums text-foreground">{formatUGX(data.amount || 0)}</p>
              <p className="text-sm text-muted-foreground mt-2">
                {data.transaction_type || 'Cash Withdrawal'} • {methodLabel}
              </p>
            </div>

            <div className="divide-y divide-border border-t border-border">
              <Row label="Transaction Reference" value={data.receipt_number} mono />
              <Row label="Transaction ID (TID)" value={data.reference} mono />
              <Row label="Customer" value={data.recipient_name} />

              {isBank && (
                <>
                  <Row label="Bank" value={data.bank_name} />
                  <Row label="Account Number" value={data.bank_account_number} mono />
                  <Row label="Account Name" value={data.bank_account_name} />
                </>
              )}

              {isMoMo && (
                <>
                  {data.mobile_money_provider && <Row label="Provider" value={data.mobile_money_provider} />}
                  <Row label="Phone Number" value={data.mobile_money_number} mono />
                  <Row label="Registered Name" value={data.mobile_money_name} />
                </>
              )}

              <Row label="Merchant Agent" value={data.processor_name} />
              <Row label="Merchant Branch" value={data.merchant_branch} />
              <Row label="Date & Time" value={dateStr} />
            </div>

            {/* QR code */}
            <div className="mt-6 flex flex-col items-center gap-2">
              <div className="rounded-xl bg-white p-3 border border-border">
                <QRCodeCanvas value={qrValue} size={150} includeMargin={false} />
              </div>
              <p className="text-xs text-primary font-medium inline-flex items-center gap-1.5">
                <ScanLine className="h-3.5 w-3.5" /> Scan to verify this receipt
              </p>
              {checksumVerified && (
                <p className="text-xs text-emerald-600 font-semibold inline-flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" /> Authenticity verified
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="mt-6 text-center">
              <p className="text-sm font-bold text-foreground">Powered by Welile Receipts</p>
              <p className="text-[12px] text-muted-foreground mt-1">
                This receipt was generated electronically. No signature is required.
              </p>
              <p className="text-[12px] text-muted-foreground mt-1">
                Verify at <span className="text-primary font-semibold">welileapp.com</span>
              </p>
            </div>
          </div>
        </div>

        {/* Download (functional action, outside the receipt card) */}
        <button
          onClick={downloadPdf}
          disabled={downloading}
          className="mt-4 w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-4 py-3 text-sm font-semibold disabled:opacity-60"
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          {downloading ? 'Preparing PDF…' : 'Download PDF receipt'}
        </button>
      </div>
    </div>
  );
}

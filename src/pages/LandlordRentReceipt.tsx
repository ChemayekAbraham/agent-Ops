import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { QRCodeCanvas } from 'qrcode.react';
import { AlertTriangle, CheckCircle2, Download, Printer, Phone, Share2, RotateCcw } from 'lucide-react';
import welileWordmark from '@/assets/welile-wordmark.png';
import ScreenLoader from '@/components/common/ScreenLoader';
import { toast } from 'sonner';
import {
  downloadLandlordReceiptPdf,
  formatReceiptDateTime,
  landlordReceiptStatusLabel,
  landlordReceiptUrl,
  type LandlordReceiptData,
} from '@/lib/landlordReceiptPdf';

interface LandlordRentReceiptProps {
  /** Preloaded receipt (used by the /r/:code dispatcher to avoid a second fetch). */
  preloaded?: LandlordReceiptData | null;
}

function DetailCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-muted-foreground mb-[3px]">{label}</div>
      <div
        className={`text-sm font-semibold break-words ${accent ? 'text-primary' : 'text-foreground'}`}
        style={{ overflowWrap: 'anywhere' }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Public landlord rent-payment receipt. Opens straight from the SMS link
 * (/r/:code) with no sign-in, shows only display-safe payment facts (never
 * float balances or operational data), and prints cleanly on A4.
 */
export default function LandlordRentReceipt({ preloaded = null }: LandlordRentReceiptProps) {
  const { code } = useParams<{ code?: string }>();
  const [data, setData] = useState<LandlordReceiptData | null>(preloaded);
  const [loading, setLoading] = useState(!preloaded);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (preloaded || !code) return;
    let active = true;
    (async () => {
      try {
        const { data: res, error: rpcErr } = await supabase.rpc('get_landlord_payout_receipt' as any, {
          p_code: code,
        });
        if (!active) return;
        if (rpcErr) throw rpcErr;
        if (!res) setError('Receipt not found');
        else setData(res as unknown as LandlordReceiptData);
      } catch (e: any) {
        if (active) setError(e?.message ?? 'Failed to load receipt');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [code, preloaded]);

  const publicUrl = useMemo(
    () => (data ? landlordReceiptUrl(data.receipt_code) : ''),
    [data],
  );

  if (loading) return <ScreenLoader className="bg-muted/30" />;

  if (error || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-muted/30 p-6 text-center">
        <AlertTriangle className="h-10 w-10 text-muted-foreground mb-3" />
        <p className="text-lg font-semibold">Receipt not found</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">
          This receipt link is invalid or is no longer active. If you received it by SMS, please contact Welile
          support.
        </p>
        <a
          href="tel:+256748747134"
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
        >
          <Phone className="h-4 w-4" /> Call +256 748 747134
        </a>
      </div>
    );
  }

  const reversed = data.status !== 'completed';

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await downloadLandlordReceiptPdf(data);
    } catch {
      toast.error('Could not build the PDF receipt');
    } finally {
      setDownloading(false);
    }
  };

  const handleShare = async () => {
    const text = `Welile Rent Payment Receipt ${data.receipt_number}\n${formatUGX(data.amount)} paid to ${data.landlord_name} for ${data.tenant_name}\n${publicUrl}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Welile Rent Payment Receipt', text, url: publicUrl });
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Receipt link copied');
    } catch {
      toast.error('Could not share the receipt');
    }
  };

  return (
    <div className="min-h-screen bg-muted/40 py-6 px-3 print:bg-background print:py-0">
      <div className="mx-auto w-full max-w-md overflow-hidden rounded-3xl border border-border/60 bg-card shadow-sm print:border-0 print:shadow-none">
        {/* Header */}
        <div className="px-6 pt-6 pb-5">
          <div className="flex items-start justify-between gap-3">
            <img src={welileWordmark} alt="Welile" className="h-6 w-auto" />
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                reversed ? 'bg-destructive/10' : 'bg-emerald-500/10'
              }`}
            >
              {reversed ? (
                <RotateCcw className="h-3.5 w-3.5 text-destructive" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
              )}
              <span
                className={`whitespace-nowrap text-xs font-bold ${
                  reversed ? 'text-destructive' : 'text-emerald-700'
                }`}
              >
                {landlordReceiptStatusLabel(data.status)}
              </span>
            </div>
          </div>
          <h1 className="mt-3.5 text-[15px] font-bold tracking-tight text-foreground">Rent Payment Receipt</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Receipt No. {data.receipt_number} &nbsp;·&nbsp; {formatReceiptDateTime(data.paid_at)}
          </p>
        </div>

        {/* Amount */}
        <div className="bg-primary/5 px-6 pb-7 pt-8 text-center">
          <div className="text-xs font-bold uppercase tracking-[1.6px] text-primary/70">Amount Paid</div>
          <div className="mt-2.5 text-[38px] font-extrabold leading-none tracking-tight text-primary">
            {formatUGX(data.amount)}
          </div>
          <p className="mt-3.5 text-[14.5px] leading-[22px] text-muted-foreground">
            Rent successfully paid to <span className="font-bold text-foreground">{data.landlord_name}</span>
            <br />
            for <span className="font-bold text-foreground">{data.tenant_name}</span>
          </p>
        </div>

        {/* Details */}
        <div className="border-t border-border/60 px-6 py-6">
          <div className="mb-4 text-[11px] font-bold uppercase tracking-[1px] text-muted-foreground">
            Payment Details
          </div>
          <div className="flex flex-col">
            <div className="grid grid-cols-2 gap-x-4 border-b border-dashed border-border py-3">
              <DetailCell label="Landlord" value={data.landlord_name || '—'} />
              <DetailCell label="Tenant" value={data.tenant_name || '—'} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 border-b border-dashed border-border py-3">
              <DetailCell label="Rent Period" value={data.rent_period || '—'} />
              <DetailCell label="House Type" value={data.house_type || '—'} />
            </div>
            <div className="border-b border-dashed border-border py-3">
              <DetailCell label="Property Address" value={data.property_address || '—'} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 border-b border-dashed border-border py-3">
              <DetailCell label="Amount Paid" value={formatUGX(data.amount)} accent />
              <DetailCell label="Payment Date" value={formatReceiptDateTime(data.paid_at)} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 border-b border-dashed border-border py-3">
              <DetailCell label="Processed By" value={data.processed_by_name || '—'} />
              <DetailCell label="Processor Role" value={data.processor_role || '—'} />
            </div>
            <div className="grid grid-cols-2 gap-x-4 border-b border-dashed border-border py-3">
              <DetailCell label="Payment Method" value={data.payment_method || '—'} />
              <DetailCell label="Transaction Reference" value={data.transaction_reference || '—'} />
            </div>
            <div className="py-3">
              <DetailCell label="Receipt Number" value={data.receipt_number} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border/60 bg-muted/30 px-6 pb-7 pt-5">
          <p className="mb-5 text-center text-[12.5px] leading-[19px] text-muted-foreground">
            This receipt confirms that Welile recorded the above rent payment as successfully disbursed to the
            landlord.
          </p>

          <div className="mb-5 flex gap-2.5 print:hidden">
            <button
              onClick={handleDownload}
              disabled={downloading}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-1.5 py-3 disabled:opacity-60"
            >
              <Download className="h-[18px] w-[18px] text-primary" />
              <span className="text-[11.5px] font-semibold">{downloading ? 'Building…' : 'Download'}</span>
            </button>
            <button
              onClick={handleShare}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-1.5 py-3"
            >
              <Share2 className="h-[18px] w-[18px] text-primary" />
              <span className="text-[11.5px] font-semibold">Share</span>
            </button>
            <button
              onClick={() => window.print()}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-1.5 py-3"
            >
              <Printer className="h-[18px] w-[18px] text-primary" />
              <span className="text-[11.5px] font-semibold">Print</span>
            </button>
          </div>

          <div className="mb-4 flex flex-col items-center gap-2.5 rounded-2xl border border-border bg-card p-[18px]">
            <QRCodeCanvas value={publicUrl} size={104} includeMargin={false} />
            <div className="text-[11.5px] text-muted-foreground">Scan to verify this receipt</div>
            <div className="text-xs font-semibold text-primary">{publicUrl.replace('https://', '')}</div>
          </div>

          <a
            href="tel:+256748747134"
            className="mb-4 flex items-center justify-center gap-2 rounded-xl bg-primary py-[13px] print:hidden"
          >
            <Phone className="h-4 w-4 text-primary-foreground" />
            <span className="text-[13.5px] font-bold text-primary-foreground">Need help? Call +256 748 747134</span>
          </a>

          <div className="text-center text-[11.5px] tracking-[0.3px] text-muted-foreground/70">welileapp.com</div>
        </div>
      </div>
    </div>
  );
}

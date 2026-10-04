import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

import { Share2, Download, MapPin, Home, User, TrendingUp, Calendar } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';

interface TenantBehaviorData {
  tenantName: string;
  tenantPhone: string;
  landlordName: string;
  propertyAddress: string;
  houseCategory: string;
  rentAmount: number;
  totalRepayment: number;
  amountRepaid: number;
  durationDays: number;
  status: string;
  createdAt: string;
  onTimePayments: number;
  latePayments: number;
  missedPayments: number;
}

interface TenantBehaviorCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: TenantBehaviorData | null;
}

export function TenantBehaviorCard({ open, onOpenChange, data }: TenantBehaviorCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  if (!data) return null;

  const progressPct = data.totalRepayment > 0
    ? Math.min(100, Math.round((data.amountRepaid / data.totalRepayment) * 100))
    : 0;
  const owing = Math.max(0, data.totalRepayment - data.amountRepaid);
  const totalPayments = data.onTimePayments + data.latePayments + data.missedPayments;
  const onTimePct = totalPayments > 0 ? Math.round((data.onTimePayments / totalPayments) * 100) : 0;

  const getBehaviorGrade = () => {
    if (onTimePct >= 90) return { grade: 'A', label: 'Excellent', color: 'text-success bg-success/15' };
    if (onTimePct >= 70) return { grade: 'B', label: 'Good', color: 'text-primary bg-primary/15' };
    if (onTimePct >= 50) return { grade: 'C', label: 'Fair', color: 'text-yellow-600 bg-yellow-500/15' };
    return { grade: 'D', label: 'Needs Improvement', color: 'text-destructive bg-destructive/15' };
  };

  const behavior = getBehaviorGrade();

  const exportCard = async (mode: 'download' | 'share') => {
    if (!cardRef.current) return;
    setExporting(true);
    try {
      // ~200 KB rasteriser — pulled in only when the user exports the card.
      const { default: html2canvas } = await import('html2canvas');
      const canvas = await html2canvas(cardRef.current, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
      });
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Failed to generate image');

      if (mode === 'share' && navigator.share) {
        const file = new File([blob], `${data.tenantName.replace(/\s/g, '_')}_behavior.png`, { type: 'image/png' });
        await navigator.share({ files: [file], title: `${data.tenantName} — Payment Behavior` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${data.tenantName.replace(/\s/g, '_')}_behavior.png`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('Card downloaded');
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto p-3">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Tenant Behavior Card
          </DialogTitle>
        </DialogHeader>

        {/* Exportable card */}
        <div ref={cardRef} className="bg-background rounded-2xl border border-border p-4 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
              {data.tenantName.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm truncate">{data.tenantName}</p>
              <p className="text-xs text-muted-foreground">{data.tenantPhone}</p>
            </div>
            <div className={`px-3 py-1.5 rounded-xl text-center ${behavior.color}`}>
              <p className="text-xl font-black leading-none">{behavior.grade}</p>
              <p className="text-[9px] font-bold mt-0.5">{behavior.label}</p>
            </div>
          </div>

          {/* Property info */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-muted/40 rounded-lg p-2.5">
              <p className="text-[9px] text-muted-foreground flex items-center gap-1"><User className="h-2.5 w-2.5" /> Landlord</p>
              <p className="text-xs font-semibold truncate">{data.landlordName}</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-2.5">
              <p className="text-[9px] text-muted-foreground flex items-center gap-1"><Home className="h-2.5 w-2.5" /> House Type</p>
              <p className="text-xs font-semibold truncate">{data.houseCategory || 'N/A'}</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-2.5 col-span-2">
              <p className="text-[9px] text-muted-foreground flex items-center gap-1"><MapPin className="h-2.5 w-2.5" /> Location</p>
              <p className="text-xs font-semibold truncate">{data.propertyAddress}</p>
            </div>
          </div>

          {/* Financial summary */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-muted/40 rounded-lg p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Rent</p>
              <p className="text-xs font-bold font-mono">{formatUGX(data.rentAmount)}</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Paid</p>
              <p className="text-xs font-bold font-mono text-success">{formatUGX(data.amountRepaid)}</p>
            </div>
            <div className="bg-muted/40 rounded-lg p-2 text-center">
              <p className="text-[9px] text-muted-foreground">Owes</p>
              <p className={`text-xs font-bold font-mono ${owing > 0 ? 'text-destructive' : 'text-success'}`}>
                {owing > 0 ? formatUGX(owing) : '✓'}
              </p>
            </div>
          </div>

          {/* Progress */}
          <div>
            <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
              <span>{data.durationDays} day plan</span>
              <span className="font-bold">{progressPct}% complete</span>
            </div>
            <div className="h-3 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  progressPct >= 100 ? 'bg-success' : progressPct >= 50 ? 'bg-primary' : 'bg-destructive'
                }`}
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Payment behavior stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-success/10 rounded-lg p-2 text-center">
              <p className="text-lg font-black text-success">{data.onTimePayments}</p>
              <p className="text-[9px] text-muted-foreground font-semibold">On Time</p>
            </div>
            <div className="bg-yellow-500/10 rounded-lg p-2 text-center">
              <p className="text-lg font-black text-yellow-600">{data.latePayments}</p>
              <p className="text-[9px] text-muted-foreground font-semibold">Late</p>
            </div>
            <div className="bg-destructive/10 rounded-lg p-2 text-center">
              <p className="text-lg font-black text-destructive">{data.missedPayments}</p>
              <p className="text-[9px] text-muted-foreground font-semibold">Missed</p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-1 border-t border-border/40">
            <div className="flex items-center gap-1">
              <Calendar className="h-3 w-3 text-muted-foreground" />
              <p className="text-[9px] text-muted-foreground">Since {format(new Date(data.createdAt), 'MMM yyyy')}</p>
            </div>
            <p className="text-[9px] text-muted-foreground font-bold">Welile Receipts</p>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Button
            variant="outline"
            onClick={() => exportCard('download')}
            disabled={exporting}
            className="h-11"
          >
            <Download className="h-4 w-4 mr-1.5" />
            Download
          </Button>
          <Button
            onClick={() => exportCard('share')}
            disabled={exporting}
            className="h-11"
          >
            <Share2 className="h-4 w-4 mr-1.5" />
            Share
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

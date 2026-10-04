import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { CalendarIcon, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';

export interface RenewablePortfolio {
  id: string;
  portfolio_code: string;
  account_name: string | null;
  investment_amount: number;
  roi_percentage: number;
  status: string;
  created_at: string;
  maturity_date?: string | null;
  duration_months?: number;
  payout_day?: number | null;
  investor_id?: string | null;
}

interface RenewPortfolioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolio: RenewablePortfolio | null;
  onSuccess: () => void;
}

const DURATION_OPTIONS = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
  { value: '18', label: '18 months' },
  { value: '24', label: '24 months' },
];

export function RenewPortfolioDialog({ open, onOpenChange, portfolio, onSuccess }: RenewPortfolioDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  // Form state
  const [duration, setDuration] = useState('12');
  const [roiPercentage, setRoiPercentage] = useState('');
  const [startDate, setStartDate] = useState<Date>(new Date());
  const [topUpAmount, setTopUpAmount] = useState('');
  const [reason, setReason] = useState('');

  // Reset form when portfolio changes
  useEffect(() => {
    if (portfolio && open) {
      setDuration(String(portfolio.duration_months || 12));
      setRoiPercentage(String(portfolio.roi_percentage));
      setStartDate(new Date());
      setTopUpAmount('');
      setReason('');
    }
  }, [portfolio, open]);

  const handleRenew = async () => {
    if (!portfolio || !user) return;
    const trimmedReason = reason.trim();
    if (trimmedReason.length < 10) {
      toast({ title: 'Audit reason must be at least 10 characters', variant: 'destructive' });
      return;
    }

    const newRoi = parseFloat(roiPercentage);
    if (isNaN(newRoi) || newRoi <= 0 || newRoi > 100) {
      toast({ title: 'ROI must be between 0.1% and 100%', variant: 'destructive' });
      return;
    }

    const newDuration = parseInt(duration);
    const topUp = topUpAmount ? parseFloat(topUpAmount) : 0;
    if (topUp < 0) {
      toast({ title: 'Top-up amount cannot be negative', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      const maturity = new Date(startDate);
      maturity.setMonth(maturity.getMonth() + newDuration);

      const nextRoi = new Date(startDate);
      nextRoi.setMonth(nextRoi.getMonth() + 1);
      if (portfolio.payout_day) nextRoi.setDate(portfolio.payout_day);

      const newAmount = portfolio.investment_amount + topUp;

      // Update the portfolio
      const { error } = await supabase.from('investor_portfolios').update({
        created_at: startDate.toISOString(),
        maturity_date: maturity.toISOString().split('T')[0],
        next_roi_date: nextRoi.toISOString().split('T')[0],
        total_roi_earned: 0,
        roi_percentage: newRoi,
        duration_months: newDuration,
        investment_amount: newAmount,
        status: 'active',
      }).eq('id', portfolio.id);

      if (error) throw error;

      // Record renewal history
      await supabase.from('portfolio_renewals').insert({
        portfolio_id: portfolio.id,
        renewed_by: user.id,
        reason: trimmedReason,
        old_created_at: portfolio.created_at,
        new_created_at: startDate.toISOString(),
        old_maturity_date: portfolio.maturity_date || null,
        new_maturity_date: maturity.toISOString().split('T')[0],
        old_roi_percentage: portfolio.roi_percentage,
        new_roi_percentage: newRoi,
        old_duration_months: portfolio.duration_months || 12,
        new_duration_months: newDuration,
        top_up_amount: topUp,
      });

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'renew_portfolio',
        table_name: 'investor_portfolios',
        record_id: portfolio.id,
        metadata: {
          reason: trimmedReason,
          old_created_at: portfolio.created_at,
          new_created_at: startDate.toISOString(),
          old_maturity_date: portfolio.maturity_date,
          new_maturity_date: maturity.toISOString().split('T')[0],
          old_roi: portfolio.roi_percentage,
          new_roi: newRoi,
          old_duration: portfolio.duration_months || 12,
          new_duration: newDuration,
          top_up_amount: topUp,
          new_total_amount: newAmount,
          portfolio_code: portfolio.portfolio_code,
        },
      });

      toast({ title: 'Portfolio renewed successfully' });

      // Fire-and-forget renewal confirmation email to the partner
      try {
        if (portfolio.investor_id) {
          const { data: partnerProfile } = await supabase
            .from('profiles')
            .select('email, full_name')
            .eq('id', portfolio.investor_id)
            .maybeSingle();
          const recipientEmail = partnerProfile?.email || null;
          const isRealEmail =
            !!recipientEmail &&
            !recipientEmail.endsWith('@welile.user') &&
            !recipientEmail.endsWith('@noapp.welile.user');
          if (isRealEmail) {
            const fmtDate = (d: Date) =>
              d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
            await supabase.functions.invoke('send-transactional-email', {
              body: {
                templateName: 'portfolio-renewal',
                recipientEmail,
                idempotencyKey: `portfolio-renewal-${portfolio.id}-${startDate.getTime()}`,
                templateData: {
                  partner_name: partnerProfile?.full_name || 'Partner',
                  portfolio_name: portfolio.account_name || portfolio.portfolio_code,
                  portfolio_id: portfolio.portfolio_code,
                  amount: newAmount,
                  old_principal: portfolio.investment_amount,
                  new_principal: newAmount,
                  return_rate: `${newRoi}%`,
                  renewal_date: fmtDate(startDate),
                  maturity_date: fmtDate(maturity),
                  duration: `${newDuration} months`,
                  currency: 'UGX',
                  company_name: 'Welile',
                  logo_url: 'https://welileapp.com/welile-logo.png',
                  unsubscribe_url: 'https://welile.com/unsubscribe',
                  terms_url: 'https://welileapp.com/partners-terms',
                  privacy_url: 'https://welileapp.com/privacy',
                },
              },
            });
          }
        }
      } catch (emailErr) {
        console.warn('[portfolio-renewal] email dispatch failed (non-blocking):', emailErr);
      }

      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast({ title: 'Renewal failed', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const displayName = portfolio?.account_name || portfolio?.portfolio_code || '';
  const topUp = topUpAmount ? parseFloat(topUpAmount) : 0;
  const newTotal = (portfolio?.investment_amount || 0) + (isNaN(topUp) ? 0 : topUp);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-amber-600" /> Renew Portfolio
          </DialogTitle>
          <DialogDescription>
            Renew <strong>{displayName}</strong> — resets the cycle, ROI earned to zero, and sets the portfolio to active.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Current summary */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-1 text-xs">
            <p><span className="text-muted-foreground">Current Amount:</span> <strong>{formatUGX(portfolio?.investment_amount || 0)}</strong></p>
            <p><span className="text-muted-foreground">Current ROI:</span> <strong>{portfolio?.roi_percentage}%</strong></p>
            <p><span className="text-muted-foreground">Duration:</span> <strong>{portfolio?.duration_months || 12} months</strong></p>
            <p><span className="text-muted-foreground">Started:</span> <strong>{portfolio?.created_at ? format(new Date(portfolio.created_at), 'PPP') : '—'}</strong></p>
          </div>

          {/* New Start Date */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">New Start Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    'w-full justify-start text-left font-normal h-9 text-sm',
                    !startDate && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {startDate ? format(startDate, 'PPP') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={startDate}
                  onSelect={d => d && setStartDate(d)}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Duration & ROI */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">New Duration</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DURATION_OPTIONS.map(d => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">New ROI %</Label>
              <Input
                type="number"
                min={0.1}
                max={100}
                step={0.1}
                value={roiPercentage}
                onChange={e => setRoiPercentage(e.target.value)}
                className="h-9"
                placeholder="e.g. 20"
              />
            </div>
          </div>

          {/* Top-up Amount */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Top-up Amount (optional)</Label>
            <Input
              type="number"
              min={0}
              value={topUpAmount}
              onChange={e => setTopUpAmount(e.target.value)}
              className="h-9"
              placeholder="0"
            />
            {topUp > 0 && (
              <p className="text-[11px] text-muted-foreground">
                New total: <strong>{formatUGX(newTotal)}</strong>
              </p>
            )}
          </div>

          {/* Audit Reason */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Audit Reason <span className="text-muted-foreground">(min 10 chars)</span></Label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Partner requested renewal for another 12-month cycle with same terms..."
              className="min-h-[60px] text-sm"
            />
            <p className="text-[10px] text-muted-foreground">{reason.trim().length}/10 characters minimum</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleRenew}
            disabled={saving || reason.trim().length < 10}
            className="bg-amber-600 hover:bg-amber-700 text-white"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Confirm Renewal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

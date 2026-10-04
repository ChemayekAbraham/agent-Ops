import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolio: { id: string; portfolio_code: string; maturity_date: string | null; account_name: string | null } | null;
  onSuccess: () => void;
}

export function ChangeMaturityDateDialog({ open, onOpenChange, portfolio, onSuccess }: Props) {
  const { toast } = useToast();
  const [date, setDate] = useState<Date | undefined>(
    portfolio?.maturity_date ? new Date(portfolio.maturity_date) : undefined
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!portfolio || !date || reason.trim().length < 5) {
      toast({ title: 'Please select a date and provide a reason (min 5 chars)', variant: 'destructive' });
      return;
    }

    setSaving(true);
    const newMaturity = format(date, 'yyyy-MM-dd');

    const { error } = await supabase.from('investor_portfolios')
      .update({ maturity_date: newMaturity })
      .eq('id', portfolio.id);

    if (error) {
      toast({ title: 'Failed to update maturity date', variant: 'destructive' });
      setSaving(false);
      return;
    }

    // Log in portfolio_renewals as audit
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('portfolio_renewals').insert({
      portfolio_id: portfolio.id,
      renewed_by: user?.id || 'system',
      reason: `Maturity date changed: ${reason}`,
      old_maturity_date: portfolio.maturity_date,
      new_maturity_date: newMaturity,
      old_created_at: new Date().toISOString(),
      new_created_at: new Date().toISOString(),
      old_duration_months: 0,
      new_duration_months: 0,
      old_roi_percentage: 0,
      new_roi_percentage: 0,
      top_up_amount: 0,
    });

    toast({ title: `Maturity date updated to ${format(date, 'dd MMM yyyy')}` });
    setSaving(false);
    onOpenChange(false);
    setReason('');
    onSuccess();
  };

  // Reset date when portfolio changes
  if (portfolio?.maturity_date && !date) {
    setDate(new Date(portfolio.maturity_date));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setDate(undefined); setReason(''); } onOpenChange(v); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Change Maturity Date</DialogTitle>
          <p className="text-xs text-muted-foreground">
            {portfolio?.account_name || portfolio?.portfolio_code}
          </p>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">New Maturity Date</label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn('w-full justify-start text-left font-normal', !date && 'text-muted-foreground')}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {date ? format(date, 'PPP') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Reason for change</label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Partner requested extension..."
              className="min-h-[60px] text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !date || reason.trim().length < 5}>
            {saving ? 'Saving...' : 'Update Date'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

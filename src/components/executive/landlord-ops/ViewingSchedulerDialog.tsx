import { useState } from 'react';
import { format } from 'date-fns';
import { CalendarIcon, Loader2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: { id: string; full_name: string; phone: string };
  house: { id: string; title: string; address: string; agent_id: string; landlord_id: string | null };
  agent: { id: string; full_name: string; phone: string };
  onSuccess: () => void;
}

const TIME_SLOTS = [
  '08:00 AM', '09:00 AM', '10:00 AM', '11:00 AM',
  '12:00 PM', '01:00 PM', '02:00 PM', '03:00 PM',
  '04:00 PM', '05:00 PM', '06:00 PM',
];

export function ViewingSchedulerDialog({ open, onOpenChange, tenant, house, agent, onSuccess }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [date, setDate] = useState<Date>();
  const [time, setTime] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [sendSms, setSendSms] = useState(true);

  const handleSchedule = async () => {
    if (!date || !time || !user) {
      toast({ title: 'Pick date & time', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from('property_viewings').insert({
        house_listing_id: house.id,
        tenant_id: tenant.id,
        agent_id: agent.id,
        landlord_id: house.landlord_id,
        scheduled_date: format(date, 'yyyy-MM-dd'),
        scheduled_time: time,
        status: 'scheduled',
        notes,
        assigned_by: user.id,
      });
      if (error) throw error;

      // Send SMS notifications
      if (sendSms) {
        try {
          await supabase.functions.invoke('viewing-confirmation-sms', {
            body: {
              type: 'scheduled',
              tenant_name: tenant.full_name,
              tenant_phone: tenant.phone,
              agent_name: agent.full_name,
              agent_phone: agent.phone,
              house_title: house.title,
              house_address: house.address,
              viewing_date: format(date, 'PPP'),
              viewing_time: time,
            },
          });
        } catch {
          // SMS is non-blocking
        }
      }

      toast({
        title: '📅 Viewing Scheduled!',
        description: `${tenant.full_name} → ${house.title} on ${format(date, 'PPP')} at ${time}. Agent: ${agent.full_name}`,
      });

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'viewing_scheduled',
        table_name: 'property_viewings',
        record_id: house.id,
        metadata: {
          tenant_id: tenant.id,
          tenant_name: tenant.full_name,
          agent_id: agent.id,
          agent_name: agent.full_name,
          house_title: house.title,
          scheduled_date: format(date, 'yyyy-MM-dd'),
          scheduled_time: time,
        },
      });

      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast({ title: 'Failed to schedule', description: err.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">📅 Schedule Property Viewing</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Summary */}
          <div className="rounded-xl bg-muted/50 p-3 space-y-1 text-xs">
            <p><span className="font-semibold">Tenant:</span> {tenant.full_name} ({tenant.phone})</p>
            <p><span className="font-semibold">Property:</span> {house.title} — {house.address}</p>
            <p><span className="font-semibold">Agent:</span> {agent.full_name} ({agent.phone})</p>
          </div>

          {/* Date */}
          <div className="space-y-1.5">
            <Label className="text-xs">Viewing Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn('w-full justify-start text-left font-normal text-xs h-9', !date && 'text-muted-foreground')}>
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {date ? format(date, 'PPP') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={date}
                  onSelect={setDate}
                  disabled={(d) => d < new Date()}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Time */}
          <div className="space-y-1.5">
            <Label className="text-xs">Time Slot</Label>
            <Select value={time} onValueChange={setTime}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Select time" />
              </SelectTrigger>
              <SelectContent>
                {TIME_SLOTS.map(t => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Ask landlord about water supply..." className="text-xs h-16 resize-none" />
          </div>

          {/* SMS toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={sendSms} onChange={e => setSendSms(e.target.checked)} className="rounded" />
            <span className="text-xs text-muted-foreground">Send SMS notification to all parties</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} className="text-xs">Cancel</Button>
          <Button onClick={handleSchedule} disabled={saving || !date || !time} className="gap-1.5 text-xs">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Schedule & Notify
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

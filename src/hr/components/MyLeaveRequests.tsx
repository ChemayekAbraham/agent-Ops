import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Send } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

const LEAVE_TYPES = ['annual', 'sick', 'personal', 'maternity', 'paternity'] as const;
type LeaveType = (typeof LEAVE_TYPES)[number];

interface LeaveRow {
  id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days_count: number;
  reason: string;
  status: string;
  review_note: string | null;
}

function dayCount(start: string, end: string) {
  if (!start || !end) return 0;
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  return Math.round((e - s) / 86400000) + 1;
}

const statusStyles: Record<string, string> = {
  pending: 'bg-warning/20 text-warning',
  approved: 'bg-success/20 text-success',
  rejected: 'bg-destructive/20 text-destructive',
};

/**
 * Employee-facing leave request provision for the "My space" window.
 * Submissions land straight in the HR Leave Management tab.
 */
export default function MyLeaveRequests() {
  const [userId, setUserId] = useState<string | null>(null);
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [leaveType, setLeaveType] = useState<LeaveType>('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const days = useMemo(() => dayCount(startDate, endDate), [startDate, endDate]);

  const load = async (uid: string) => {
    const { data } = await supabase
      .from('leave_requests')
      .select('id, leave_type, start_date, end_date, days_count, reason, status, review_note')
      .eq('employee_id', uid)
      .order('created_at', { ascending: false })
      .limit(10);
    setRows((data ?? []) as LeaveRow[]);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? null;
      if (cancelled || !uid) return;
      setUserId(uid);
      await load(uid);
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    if (!userId) return;
    if (!startDate || !endDate || days <= 0) {
      toast.error('Pick a valid start and end date');
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Please give a reason of at least 10 characters');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from('leave_requests').insert({
        employee_id: userId,
        leave_type: leaveType,
        start_date: startDate,
        end_date: endDate,
        days_count: days,
        reason: reason.trim(),
        status: 'pending',
      });
      if (error) throw error;
      toast.success('Leave request sent to HR');
      setReason('');
      setStartDate('');
      setEndDate('');
      setOpen(false);
      await load(userId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not send leave request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <CalendarDays className="h-4 w-4" /> My leave
        </CardTitle>
        <Button size="sm" variant={open ? 'outline' : 'default'} onClick={() => setOpen((v) => !v)}>
          {open ? 'Cancel' : 'Request leave'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {open && (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label className="text-xs">Leave type</Label>
                <Select value={leaveType} onValueChange={(v) => setLeaveType(v as LeaveType)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAVE_TYPES.map((t) => (
                      <SelectItem key={t} value={t} className="text-xs capitalize">
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">First day</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last day</Label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="h-9 text-xs"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason (min 10 characters)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="min-h-[70px] text-xs"
                placeholder="Why do you need this leave?"
              />
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                {days > 0 ? `${days} day${days === 1 ? '' : 's'}` : 'Select your dates'}
              </p>
              <Button size="sm" onClick={submit} disabled={saving} className="gap-1">
                <Send className="h-3 w-3" /> {saving ? 'Sending…' : 'Send to HR'}
              </Button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No leave requests yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold capitalize text-foreground">
                    {r.leave_type} · {r.days_count} day{r.days_count === 1 ? '' : 's'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {new Date(r.start_date).toLocaleDateString()} –{' '}
                    {new Date(r.end_date).toLocaleDateString()}
                  </p>
                  {r.review_note && (
                    <p className="text-[11px] italic text-muted-foreground">HR: {r.review_note}</p>
                  )}
                </div>
                <Badge className={statusStyles[r.status] || ''}>{r.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
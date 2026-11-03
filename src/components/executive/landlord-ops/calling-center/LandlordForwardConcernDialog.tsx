import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DEFAULT_CONCERN_DUE_HOURS,
  useConcernStaffOptions,
  useForwardConcern,
} from '@/hooks/useCallingConcerns';
import { Send } from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceKind?: 'outbound_call' | 'received_call';
  defaultSubjectId?: string | null;
  defaultSubjectName?: string;
  defaultSubjectPhone?: string | null;
  defaultDistrict?: string | null;
  defaultAgentName?: string | null;
  defaultCategory?: string;
  defaultSummary?: string;
  defaultDetails?: string | null;
  cycleRowId?: string | null;
  feedbackId?: string | null;
  receivedCallId?: string | null;
}

export function LandlordForwardConcernDialog({
  open,
  onOpenChange,
  sourceKind = 'outbound_call',
  defaultSubjectId,
  defaultSubjectName = '',
  defaultSubjectPhone = '',
  defaultDistrict = '',
  defaultAgentName = '',
  defaultSummary = '',
  defaultDetails = '',
  cycleRowId = null,
  feedbackId = null,
  receivedCallId = null,
}: Props) {
  const staff = useConcernStaffOptions();
  const forward = useForwardConcern();

  const [subjectName, setSubjectName] = useState(defaultSubjectName);
  const [priority, setPriority] = useState<string>('normal');
  const [summary, setSummary] = useState(defaultSummary);
  const [details, setDetails] = useState(defaultDetails ?? '');
  const [assignedTo, setAssignedTo] = useState<string>('');
  const [dueHours, setDueHours] = useState<number>(DEFAULT_CONCERN_DUE_HOURS);

  useEffect(() => {
    if (open) {
      setSubjectName(defaultSubjectName);
      setPriority('normal');
      setSummary(defaultSummary);
      const metaParts = [
        defaultSubjectPhone ? `Phone: ${defaultSubjectPhone}` : null,
        defaultDistrict ? `District: ${defaultDistrict}` : null,
        defaultAgentName ? `Agent: ${defaultAgentName}` : null,
        defaultDetails || null,
      ].filter(Boolean);
      setDetails(metaParts.join('\n'));
      const firstStaff = staff.data?.[0]?.user_id ?? '';
      setAssignedTo(firstStaff);
      setDueHours(DEFAULT_CONCERN_DUE_HOURS);
    }
  }, [
    open,
    defaultSubjectName,
    defaultSubjectPhone,
    defaultDistrict,
    defaultAgentName,
    defaultSummary,
    defaultDetails,
    staff.data,
  ]);

  const handleSubmit = async () => {
    if (!summary.trim()) {
      toast.error('Enter a summary for the issue.');
      return;
    }
    if (!assignedTo) {
      toast.error('Choose a staff member to forward this issue to.');
      return;
    }
    try {
      await forward.mutateAsync({
        source_kind: receivedCallId ? 'received_call' : sourceKind,
        title: summary.trim(),
        forwarded_to: assignedTo,
        context: details.trim() || null,
        priority,
        feedback_id: feedbackId,
        received_call_id: receivedCallId,
        cycle_row_id: cycleRowId,
        caller_name: subjectName.trim() || 'Landlord',
        caller_user_id: defaultSubjectId ?? null,
        subject_type: 'landlord',
        due_hours: dueHours,
      });
      toast.success('Landlord issue forwarded for review.');
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message || 'Could not forward issue');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4 text-primary" /> Forward Landlord Issue for Review
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <Label className="text-xs">Landlord Name *</Label>
              <Input
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                placeholder="Full name"
              />
            </div>
            <div>
              <Label className="text-xs">Priority *</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <div>
              <Label className="text-xs">Forward to Staff Reviewer *</Label>
              <Select value={assignedTo} onValueChange={setAssignedTo}>
                <SelectTrigger><SelectValue placeholder="Choose reviewer" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {(staff.data ?? []).map((r) => (
                    <SelectItem key={r.user_id} value={r.user_id}>
                      {r.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Response Target (Hours)</Label>
              <Select value={String(dueHours)} onValueChange={(v) => setDueHours(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="4">4 hours</SelectItem>
                  <SelectItem value="8">8 hours</SelectItem>
                  <SelectItem value="12">12 hours</SelectItem>
                  <SelectItem value="24">24 hours</SelectItem>
                  <SelectItem value="48">48 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label className="text-xs">One-line Summary *</Label>
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Landlord reports mobile money payout number changed"
            />
          </div>

          <div>
            <Label className="text-xs">Full Context & Call Notes</Label>
            <Textarea
              rows={4}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="What the landlord explained, Rent Plan or house affected, and suggested resolution…"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={forward.isPending || !summary.trim() || !assignedTo}
          >
            {forward.isPending ? 'Forwarding…' : 'Forward Issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Target } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface PartnerOpsTargetEditorProps {
  leadUserId: string;
  onSaved?: () => void;
}

const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function PartnerOpsTargetEditor({ leadUserId, onSaved }: PartnerOpsTargetEditorProps) {
  const { user, roles } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(currentMonthValue());
  const [metricKey, setMetricKey] = useState<'notes_approved' | 'agents_onboarded'>('notes_approved');
  const [targetValue, setTargetValue] = useState('');
  const [amberLag, setAmberLag] = useState('10');
  const [redLag, setRedLag] = useState('20');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const canSetTarget = (roles || []).some((r) => r === 'ceo' || r === 'super_admin');
  if (!canSetTarget) return null;

  const handleSave = async () => {
    const target = Number(targetValue);
    if (!Number.isInteger(target) || target <= 0) {
      toast({ title: 'Enter a positive whole number target', variant: 'destructive' });
      return;
    }
    if (!month) {
      toast({ title: 'Pick a month', variant: 'destructive' });
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from('partner_ops_targets')
      .upsert(
        {
          lead_user_id: leadUserId,
          metric_key: metricKey,
          period_month: `${month}-01`,
          target_value: target,
          amber_lag_points: Number(amberLag) || 0,
          red_lag_points: Number(redLag) || 0,
          note: note.trim() || null,
          set_by: user?.id ?? null,
          set_at: new Date().toISOString(),
        },
        { onConflict: 'lead_user_id,metric_key,period_month' },
      );
    setSaving(false);

    if (error) {
      toast({ title: 'Could not save target', description: error.message, variant: 'destructive' });
      return;
    }

    toast({ title: 'Target saved' });
    setOpen(false);
    onSaved?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Target className="h-3 w-3" />
          Set target
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set monthly target</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="pot-metric">Metric</Label>
            <Select value={metricKey} onValueChange={(v) => setMetricKey(v as typeof metricKey)}>
              <SelectTrigger id="pot-metric">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notes_approved">Approved notes</SelectItem>
                <SelectItem value="agents_onboarded">Proxy agents onboarded</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pot-month">Month</Label>
            <Input id="pot-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pot-target">
              Target ({metricKey === 'agents_onboarded' ? 'proxy agents onboarded' : 'approved notes'})
            </Label>
            <Input
              id="pot-target"
              type="number"
              min={1}
              step={1}
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              placeholder="e.g. 40"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="pot-amber">Amber lag points</Label>
              <Input id="pot-amber" type="number" value={amberLag} onChange={(e) => setAmberLag(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pot-red">Red lag points</Label>
              <Input id="pot-red" type="number" value={redLag} onChange={(e) => setRedLag(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pot-note">Note (optional)</Label>
            <Textarea id="pot-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save target'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PartnerOpsTargetEditor;
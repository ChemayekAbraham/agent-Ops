import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RateRow {
  id: string;
  payee_role: string;
  amount: number;
  effective_from: string;
  reason: string | null;
}

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'agent', label: 'Agent' },
  { value: 'lead', label: 'Lead' },
];

const localNowValue = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function PartnerNoteRateEditor() {
  const { user, roles } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [payeeRole, setPayeeRole] = useState('agent');
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(localNowValue());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const canChange = (roles || []).some((r) => r === 'ceo' || r === 'cfo' || r === 'super_admin');

  const { data: rates, refetch } = useQuery({
    queryKey: ['partner-note-rates'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('partner_note_rates')
        .select('id, payee_role, amount, effective_from, reason')
        .lte('effective_from', new Date().toISOString())
        .order('effective_from', { ascending: false });
      if (error) throw error;
      const current: Record<string, RateRow> = {};
      ((data || []) as RateRow[]).forEach((row) => {
        if (!current[row.payee_role]) current[row.payee_role] = row;
      });
      return current;
    },
  });

  const handleSave = async () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast({ title: 'Enter a positive amount', variant: 'destructive' });
      return;
    }
    if (reason.trim().length < 10) {
      toast({ title: 'Reason must be at least 10 characters', variant: 'destructive' });
      return;
    }
    if (!effectiveFrom) {
      toast({ title: 'Pick an effective date', variant: 'destructive' });
      return;
    }
    setSaving(true);
    const { error } = await supabase.from('partner_note_rates').insert({
      payee_role: payeeRole,
      amount: value,
      effective_from: new Date(effectiveFrom).toISOString(),
      reason: reason.trim(),
      set_by: user?.id ?? null,
    });
    setSaving(false);

    if (error) {
      toast({ title: 'Could not save rate', description: error.message, variant: 'destructive' });
      return;
    }

    toast({ title: 'Rate recorded' });
    setOpen(false);
    setAmount('');
    setReason('');
    setEffectiveFrom(localNowValue());
    refetch();
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Rates apply from their effective date onward. Past payments are not affected.
      </p>
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Note bonus rates</h3>
            {canChange && (
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-xs">Change rate</Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Change bonus rate</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label>Payee role</Label>
                      <Select value={payeeRole} onValueChange={setPayeeRole}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="pnr-amount">New amount (UGX)</Label>
                      <Input
                        id="pnr-amount"
                        type="number"
                        min={1}
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="e.g. 2000"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="pnr-eff">Effective from</Label>
                      <Input
                        id="pnr-eff"
                        type="datetime-local"
                        value={effectiveFrom}
                        onChange={(e) => setEffectiveFrom(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="pnr-reason">Reason</Label>
                      <Textarea
                        id="pnr-reason"
                        rows={3}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why is this rate changing?"
                      />
                      <p className={reason.trim().length < 10 ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'}>
                        {reason.trim().length}/10 characters minimum
                      </p>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
                    <Button onClick={handleSave} disabled={saving || reason.trim().length < 10}>
                      {saving ? 'Saving…' : 'Save rate'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {ROLES.map((r) => {
              const row = rates?.[r.value];
              return (
                <div key={r.value} className="rounded-md border border-border p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</p>
                  <p className="text-sm font-semibold text-foreground">
                    {row ? formatUGX(Number(row.amount || 0)) : 'Not set'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {row ? `In force since ${format(new Date(row.effective_from), 'd MMM yyyy, HH:mm')}` : 'No rate on record'}
                  </p>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PartnerNoteRateEditor;
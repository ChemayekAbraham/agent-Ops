import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface Office {
  office_key: 'coo' | 'ceo' | 'cfo';
  office_code: string;
  holder_id: string;
  holder_name: string | null;
  holder_since: string;
  can_transfer: boolean;
}

interface Candidate { user_id: string; full_name: string | null }

const OFFICE_NAMES: Record<string, string> = {
  coo: 'Chief Operating Officer',
  ceo: 'Chief Executive Officer',
  cfo: 'Chief Financial Officer',
};

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'Africa/Kampala' });
}

export function RequisitionOfficesCard() {
  const [offices, setOffices] = useState<Office[]>([]);
  const [target, setTarget] = useState<Office | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [newHolder, setNewHolder] = useState('');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('staff_requisition_offices_list' as never);
    if (!error && Array.isArray(data)) setOffices(data as unknown as Office[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openTransfer = async (office: Office) => {
    setTarget(office);
    setNewHolder('');
    setReason('');
    setCandidates([]);
    setLoadingCandidates(true);
    const { data, error } = await supabase.rpc(
      'staff_requisition_office_candidates' as never,
      { p_office: office.office_key } as never,
    );
    setLoadingCandidates(false);
    if (error) { toast.error(error.message); return; }
    setCandidates(Array.isArray(data) ? (data as unknown as Candidate[]) : []);
  };

  const confirm = async () => {
    if (!target) return;
    setWorking(true);
    const { data, error } = await supabase.rpc(
      'staff_requisition_office_transfer' as never,
      { p_office: target.office_key, p_new_holder: newHolder, p_reason: reason.trim() } as never,
    );
    setWorking(false);
    if (error) { toast.error(error.message); return; }
    const name = candidates.find((c) => c.user_id === newHolder)?.full_name ?? 'the new holder';
    toast.success(`${target.office_code} transferred to ${name} — ${Number(data ?? 0)} pending approvals moved.`);
    setTarget(null);
    void load();
  };

  if (offices.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="mb-3 text-sm font-semibold">Approval offices</h3>
      <div className="divide-y divide-border">
        {offices.map((o) => (
          <div key={o.office_key} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                <span className="font-mono text-xs text-muted-foreground">{o.office_code}</span>{' '}
                {OFFICE_NAMES[o.office_key] ?? o.office_key.toUpperCase()}
              </p>
              <p className="text-xs text-muted-foreground">
                {o.holder_name || 'Unnamed holder'} • since {fmtDay(o.holder_since)}
              </p>
            </div>
            {o.can_transfer && (
              <Button size="sm" variant="outline" onClick={() => void openTransfer(o)}>Transfer</Button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !working) setTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer {target?.office_code}</DialogTitle>
            <DialogDescription>
              Current holder: {target?.holder_name || '—'}. Pending approvals for this office move to the new holder.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={newHolder} onValueChange={setNewHolder} disabled={loadingCandidates}>
              <SelectTrigger>
                <SelectValue placeholder={loadingCandidates ? 'Loading…' : 'Choose the new holder'} />
              </SelectTrigger>
              <SelectContent>
                {candidates.length === 0 && !loadingCandidates && (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">No eligible people</div>
                )}
                {candidates.map((c) => (
                  <SelectItem key={c.user_id} value={c.user_id}>{c.full_name || c.user_id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for the transfer (at least 10 characters)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={working}>Cancel</Button>
            <Button
              onClick={() => void confirm()}
              disabled={working || !newHolder || reason.trim().length < 10}
            >
              {working && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm transfer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default RequisitionOfficesCard;

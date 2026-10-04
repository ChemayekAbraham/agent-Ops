import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Store } from 'lucide-react';
import type { ServiceCenterQualification } from '@/hooks/useServiceCenterQualification';
import { UgDistrictSelect, type UgDistrictValue } from '@/components/location/UgDistrictSelect';
import { useUgDistricts, findUgDistrictByName } from '@/hooks/useUgLocations';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentId: string;
  qualification: ServiceCenterQualification;
  onSubmitted: () => void;
}

export function ServiceCenterRequestDialog({ open, onOpenChange, agentId, qualification, onSubmitted }: Props) {
  const [loading, setLoading] = useState(false);
  const { data: districts } = useUgDistricts();
  const [ugDistrict, setUgDistrict] = useState<UgDistrictValue | null>(null);
  const [form, setForm] = useState({
    name: '',
    phone: '',
    location: '',
    district: '',
    preferred: '',
    reason: '',
    note: '',
    ready: false,
  });

  useEffect(() => {
    if (!open || !agentId) return;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('full_name, phone, district, town, city, village')
        .eq('id', agentId)
        .maybeSingle();
      if (data) {
        setForm((f) => ({
          ...f,
          name: f.name || data.full_name || '',
          phone: f.phone || data.phone || '',
          district: f.district || data.district || '',
          location: f.location || [data.village, data.town || data.city].filter(Boolean).join(', '),
        }));
      }
    })();
  }, [open, agentId]);

  // Best-effort: upgrade the saved typed district to an official row for pre-fill.
  useEffect(() => {
    if (ugDistrict || !form.district) return;
    const match = findUgDistrictByName(districts, form.district);
    if (match) setUgDistrict({ id: match.id, name: match.name, region: match.region ?? null });
  }, [districts, form.district, ugDistrict]);

  const submit = async () => {
    if (!form.ready) { toast.error('Please confirm you are ready to operate the service center'); return; }
    if (!form.preferred.trim() || !form.reason.trim()) { toast.error('Preferred location and reason are required'); return; }
    if (!ugDistrict) { toast.error('Select your district'); return; }
    setLoading(true);
    try {
      const { error } = await (supabase.rpc as any)('submit_service_center_request', {
        p_agent_name: form.name.trim(),
        p_agent_phone: form.phone.trim(),
        p_agent_location: form.location.trim() || null,
        p_district: ugDistrict.name,
        p_ug_district_id: ugDistrict.id,
        p_preferred_location: form.preferred.trim(),
        p_reason: form.reason.trim(),
        p_ready: true,
        p_supporting_note: form.note.trim() || null,
      });
      if (error) throw error;
      toast.success('Your service center request is under review.');
      onOpenChange(false);
      onSubmitted();
    } catch (e: any) {
      toast.error(e?.message || 'Could not submit your request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="h-4 w-4 text-primary" /> Request Free Service Center
          </DialogTitle>
          <DialogDescription>
            Qualification allows you to submit this request. It does not guarantee immediate approval.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground grid grid-cols-3 gap-2">
            <div><div className="text-base font-bold text-foreground tabular-nums">{qualification.qualifying_sub_agents}</div>Active sub-agents</div>
            <div><div className="text-base font-bold text-foreground tabular-nums">{qualification.main_agent_active_tenants}</div>Your tenants</div>
            <div><div className="text-base font-bold text-foreground tabular-nums">{qualification.network_active_tenants}</div>Network tenants</div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Agent name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone number</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label>Your location</Label>
              <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <UgDistrictSelect
              value={ugDistrict}
              onChange={setUgDistrict}
              required
              legacyText={form.district}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Preferred service center location *</Label>
            <Input
              placeholder="Trading centre, street or landmark"
              value={form.preferred}
              onChange={(e) => setForm({ ...form, preferred: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Reason for requesting the service center *</Label>
            <Textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Supporting note (optional)</Label>
            <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={form.ready} onCheckedChange={(v) => setForm({ ...form, ready: !!v })} />
            <span>I confirm I am ready to operate the service center.</span>
          </label>

          <Button className="w-full" onClick={submit} disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Submit request
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ServiceCenterRequestDialog;
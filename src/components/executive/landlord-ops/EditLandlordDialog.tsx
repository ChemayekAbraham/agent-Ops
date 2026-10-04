import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';
import { LandlordAgreementUploader } from '@/components/landlord/agreement/LandlordAgreementUploader';

interface LandlordData {
  id: string;
  name: string;
  phone: string;
  property_address?: string;
  mobile_money_name?: string | null;
  mobile_money_number?: string | null;
  bank_name?: string | null;
  account_number?: string | null;
  monthly_rent?: number | null;
  has_smartphone?: boolean | null;
  number_of_houses?: number | null;
  verified?: boolean | null;
  caretaker_name?: string | null;
  caretaker_phone?: string | null;
  tin?: string | null;
  electricity_meter_number?: string | null;
  water_meter_number?: string | null;
  village?: string | null;
  district?: string | null;
  region?: string | null;
}

interface Props {
  landlord: LandlordData | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function EditLandlordDialog({ landlord, open, onClose, onSaved }: Props) {
  const { user } = useAuth();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<Record<string, any>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [showAgreementUpload, setShowAgreementUpload] = useState(false);

  // Fetch fresh data from DB whenever landlord changes or dialog opens
  useEffect(() => {
    if (!open || !landlord?.id) return;
    
    const fetchLandlord = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('landlords')
          .select('id, name, phone, mobile_money_name, mobile_money_number, bank_name, account_number, bank_branch, bank_account_name, monthly_rent, has_smartphone, number_of_houses, caretaker_name, caretaker_phone, tin, electricity_meter_number, water_meter_number, village, district, region, property_address')
          .eq('id', landlord.id)
          .single();

        if (error) throw error;
        if (data) {
          const row = data as any;
          setForm({
            name: data.name || '',
            phone: data.phone || '',
            mobile_money_name: data.mobile_money_name || '',
            mobile_money_number: data.mobile_money_number || '',
            bank_name: data.bank_name || '',
            account_number: data.account_number || '',
            bank_branch: row.bank_branch || '',
            bank_account_name: row.bank_account_name || '',

            monthly_rent: data.monthly_rent || '',
            has_smartphone: data.has_smartphone ?? false,
            number_of_houses: data.number_of_houses || '',
            caretaker_name: data.caretaker_name || '',
            caretaker_phone: data.caretaker_phone || '',
            tin: data.tin || '',
            electricity_meter_number: data.electricity_meter_number || '',
            water_meter_number: data.water_meter_number || '',
            village: data.village || '',
            district: data.district || '',
            region: data.region || '',
            property_address: data.property_address || '',
          });
        }
      } catch (err: any) {
        toast.error('Failed to load landlord data');
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    fetchLandlord();
  }, [open, landlord?.id]);

  const handleSave = async () => {
    if (!landlord || !user) return;
    if (!form.name?.trim() || !form.phone?.trim()) {
      toast.error('Name and phone are required');
      return;
    }
    setSaving(true);
    try {
      const updates: Record<string, any> = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        mobile_money_name: form.mobile_money_name?.trim() || null,
        mobile_money_number: form.mobile_money_number?.trim() || null,
        bank_name: form.bank_name?.trim() || null,
        account_number: form.account_number?.trim() || null,
        bank_branch: form.bank_branch?.trim() || null,
        bank_account_name: form.bank_account_name?.trim() || null,

        monthly_rent: form.monthly_rent ? Number(form.monthly_rent) : null,
        has_smartphone: form.has_smartphone,
        number_of_houses: form.number_of_houses ? Number(form.number_of_houses) : null,
        caretaker_name: form.caretaker_name?.trim() || null,
        caretaker_phone: form.caretaker_phone?.trim() || null,
        tin: form.tin?.trim() || null,
        electricity_meter_number: form.electricity_meter_number?.trim() || null,
        water_meter_number: form.water_meter_number?.trim() || null,
        village: form.village?.trim() || null,
        district: form.district?.trim() || null,
        region: form.region?.trim() || null,
      };

      const { error } = await supabase.from('landlords').update(updates).eq('id', landlord.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'landlord_profile_edited',
        table_name: 'landlords',
        record_id: landlord.id,
        metadata: { updated_fields: Object.keys(updates), editor_role: 'landlord_ops' },
      });

      toast.success('Landlord profile updated successfully');
      onSaved();
      onClose();
    } catch (err: any) {
      if (err?.code === '23514' || /signed addendum|renewal/i.test(err?.message || '')) {
        setShowAgreementUpload(true);
        toast.error('Upload a signed addendum or renewal before changing these details.');
      } else {
        toast.error(err.message || 'Failed to update landlord');
      }
    } finally {
      setSaving(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <Dialog open={open && !showConfirm} onOpenChange={(o) => { if (!o && !showConfirm) onClose(); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Edit Landlord Profile</DialogTitle>
          </DialogHeader>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading landlord data…</span>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Basic Info */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Basic Info</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Name *</Label>
                    <Input value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Full name" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phone *</Label>
                    <Input value={form.phone || ''} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="07XXXXXXXX" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Village</Label>
                    <Input value={form.village || ''} onChange={e => setForm(f => ({ ...f, village: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">District</Label>
                    <Input value={form.district || ''} onChange={e => setForm(f => ({ ...f, district: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Region</Label>
                    <Input value={form.region || ''} onChange={e => setForm(f => ({ ...f, region: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Financial */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Financial</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">MoMo Name</Label>
                    <Input value={form.mobile_money_name || ''} onChange={e => setForm(f => ({ ...f, mobile_money_name: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">MoMo Number</Label>
                    <Input value={form.mobile_money_number || ''} onChange={e => setForm(f => ({ ...f, mobile_money_number: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Bank Name</Label>
                    <Input value={form.bank_name || ''} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Account Number</Label>
                    <Input value={form.account_number || ''} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Branch</Label>
                    <Input value={form.bank_branch || ''} onChange={e => setForm(f => ({ ...f, bank_branch: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Bank Account Name</Label>
                    <Input value={form.bank_account_name || ''} onChange={e => setForm(f => ({ ...f, bank_account_name: e.target.value }))} />
                  </div>

                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Monthly Rent (UGX)</Label>
                    <Input type="number" value={form.monthly_rent || ''} onChange={e => setForm(f => ({ ...f, monthly_rent: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">TIN</Label>
                    <Input value={form.tin || ''} onChange={e => setForm(f => ({ ...f, tin: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Property */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Property</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Number of Houses</Label>
                    <Input type="number" value={form.number_of_houses || ''} onChange={e => setForm(f => ({ ...f, number_of_houses: e.target.value }))} />
                  </div>
                  <div className="flex items-center gap-2 pt-5">
                    <Switch checked={form.has_smartphone || false} onCheckedChange={v => setForm(f => ({ ...f, has_smartphone: v }))} />
                    <Label className="text-xs">Has Smartphone</Label>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Electricity Meter</Label>
                    <Input value={form.electricity_meter_number || ''} onChange={e => setForm(f => ({ ...f, electricity_meter_number: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Water Meter</Label>
                    <Input value={form.water_meter_number || ''} onChange={e => setForm(f => ({ ...f, water_meter_number: e.target.value }))} />
                  </div>
                </div>
              </div>

              {/* Caretaker */}
              <div className="space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Caretaker</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Caretaker Name</Label>
                    <Input value={form.caretaker_name || ''} onChange={e => setForm(f => ({ ...f, caretaker_name: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Caretaker Phone</Label>
                    <Input value={form.caretaker_phone || ''} onChange={e => setForm(f => ({ ...f, caretaker_phone: e.target.value }))} />
                  </div>
                </div>
              </div>

              <Button
                onClick={() => {
                  if (!form.name?.trim() || !form.phone?.trim()) {
                    toast.error('Name and phone are required');
                    return;
                  }
                  setShowConfirm(true);
                }}
                disabled={saving}
                className="w-full"
              >
                <Save className="h-4 w-4 mr-2" />
                Save Changes
              </Button>
            </div>
          )}

          {showAgreementUpload && landlord && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 text-xs text-muted-foreground">
                Save the signed version first, then apply the matching landlord profile change.
              </p>
              <LandlordAgreementUploader
                landlordId={landlord.id}
                landlordName={form.name || landlord.name}
                landlordPhone={form.phone || landlord.phone}
                propertyAddress={form.property_address || landlord.property_address}
                monthlyRent={form.monthly_rent ? Number(form.monthly_rent) : landlord.monthly_rent}
                kind="addendum"
                initialDetails={form}
                onSubmitted={() => {
                  setShowAgreementUpload(false);
                  toast.success('Signed addendum saved. Apply the profile change again.');
                }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Save Confirmation */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Changes</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to save changes to <strong>{form.name}</strong>'s profile? This will update their record in the system.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {saving ? 'Saving…' : 'Confirm Save'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

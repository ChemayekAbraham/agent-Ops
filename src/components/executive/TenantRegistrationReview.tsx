import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  ArrowLeft, Pencil, Save, X, User, Home, Shield, FileText,
  Phone, MapPin, CreditCard, Droplets, Zap, Loader2, Image as ImageIcon,
} from 'lucide-react';
import { toast } from 'sonner';

interface Props {
  tenantId: string;
  tenantName: string;
  onBack: () => void;
}

interface FieldDef {
  key: string;
  label: string;
  icon?: React.ElementType;
  readOnly?: boolean;
}

const profileFields: FieldDef[] = [
  { key: 'full_name', label: 'Full Name', icon: User },
  { key: 'phone', label: 'Phone', icon: Phone },
  { key: 'email', label: 'Email', readOnly: true },
  { key: 'city', label: 'City', icon: MapPin },
  { key: 'country', label: 'Country' },
  { key: 'national_id', label: 'National ID', icon: CreditCard },
  { key: 'mobile_money_number', label: 'MoMo Number' },
  { key: 'mobile_money_provider', label: 'MoMo Provider' },
];

const landlordFields: FieldDef[] = [
  { key: 'name', label: 'Name', icon: User },
  { key: 'phone', label: 'Phone', icon: Phone },
  { key: 'property_address', label: 'Property Address', icon: Home },
  { key: 'bank_name', label: 'Bank Name', icon: CreditCard },
  { key: 'account_number', label: 'Account Number' },
  { key: 'mobile_money_number', label: 'MoMo Number' },
  { key: 'mobile_money_name', label: 'MoMo Name' },
  { key: 'caretaker_name', label: 'Caretaker Name' },
  { key: 'caretaker_phone', label: 'Caretaker Phone' },
  { key: 'electricity_meter_number', label: 'Electricity Meter', icon: Zap },
  { key: 'water_meter_number', label: 'Water Meter', icon: Droplets },
  { key: 'village', label: 'Village' },
  { key: 'district', label: 'District' },
];

const lc1Fields: FieldDef[] = [
  { key: 'name', label: 'Name', icon: Shield },
  { key: 'phone', label: 'Phone', icon: Phone },
  { key: 'village', label: 'Village', icon: MapPin },
];

const requestFields: FieldDef[] = [
  { key: 'house_category', label: 'House Category', icon: Home },
  { key: 'tenant_water_meter', label: 'Tenant Water Meter', icon: Droplets },
  { key: 'tenant_electricity_meter', label: 'Tenant Electricity Meter', icon: Zap },
];

type SectionKey = 'profile' | 'landlord' | 'lc1' | 'request';

export function TenantRegistrationReview({ tenantId, tenantName, onBack }: Props) {
  const queryClient = useQueryClient();
  const [editingSection, setEditingSection] = useState<SectionKey | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [reasonDialog, setReasonDialog] = useState<{ open: boolean; section: SectionKey | null }>({ open: false, section: null });
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-registration', tenantId],
    queryFn: async () => {
      // Get latest rent request for this tenant
      const { data: reqData } = await supabase
        .from('rent_requests')
        .select('id, landlord_id, lc1_id, house_category, tenant_water_meter, tenant_electricity_meter, house_image_urls, tenant_photo_url, status, created_at, updated_at, resubmitted_at, last_resubmitted_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const [profileRes, landlordRes, lc1Res, docsRes] = await Promise.all([
        supabase.from('profiles')
          .select('full_name, phone, email, city, country, national_id, mobile_money_number, mobile_money_provider')
          .eq('id', tenantId)
          .maybeSingle(),
        reqData?.landlord_id
          ? supabase.from('landlords')
              .select('id, name, phone, property_address, bank_name, account_number, mobile_money_number, mobile_money_name, caretaker_name, caretaker_phone, electricity_meter_number, water_meter_number, village, district')
              .eq('id', reqData.landlord_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        reqData?.lc1_id
          ? supabase.from('lc1_chairpersons')
              .select('id, name, phone, village')
              .eq('id', reqData.lc1_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        // Authoritative photo custody: what the agent actually uploaded from the
        // tenant profile sheet lives in tenant_documents, not in the rent request
        // snapshot (which can be stale after a re-upload).
        supabase.rpc('get_tenant_documents' as any, { p_tenant_id: tenantId }),
      ]);

      const docRows: any[] = Array.isArray(docsRes?.data) ? (docsRes.data as any[]) : [];
      const currentHouseDocs = docRows
        .filter(d => d.doc_type === 'house_image' && d.is_current !== false && d.public_url)
        .sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
      const currentPassport = docRows.find(d => d.doc_type === 'tenant_passport' && d.is_current !== false && d.public_url);

      // Precedence: the newest evidence wins. When the request was resubmitted
      // after the current document generation was registered, the request
      // snapshot is the latest submission and must be what the reviewer sees.
      const resubmittedAt = reqData?.last_resubmitted_at ?? reqData?.resubmitted_at ?? null;
      const newestDocAt = currentHouseDocs.reduce<number>((max, d) => {
        const t = d.created_at ? new Date(d.created_at).getTime() : 0;
        return t > max ? t : max;
      }, 0);
      const requestPhotos = (reqData?.house_image_urls as string[] | null) ?? [];
      const requestIsNewer =
        !!resubmittedAt && requestPhotos.length > 0 && new Date(resubmittedAt).getTime() > newestDocAt;

      const useDocs = currentHouseDocs.length > 0 && !requestIsNewer;

      return {
        profile: profileRes.data,
        landlord: landlordRes.data,
        lc1: lc1Res.data,
        request: reqData,
        houseImages: useDocs ? currentHouseDocs.map(d => d.public_url as string) : requestPhotos,
        houseImagesFromDocs: useDocs,
        passportUrl: (currentPassport?.public_url as string | undefined) ?? reqData?.tenant_photo_url ?? null,
      };
    },

  });


  const startEdit = (section: SectionKey) => {
    const sectionData = data?.[section] as Record<string, any> | null;
    if (!sectionData) return;
    const fields = { profile: profileFields, landlord: landlordFields, lc1: lc1Fields, request: requestFields }[section];
    const vals: Record<string, string> = {};
    fields.forEach(f => {
      if (!f.readOnly) vals[f.key] = String(sectionData[f.key] ?? '');
    });
    setEditValues(vals);
    setEditingSection(section);
  };

  const cancelEdit = () => {
    setEditingSection(null);
    setEditValues({});
  };

  const promptSave = () => {
    setReason('');
    setReasonDialog({ open: true, section: editingSection });
  };

  const handleSave = async () => {
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    const section = reasonDialog.section;
    if (!section || !data) return;

    setSaving(true);
    try {
      const oldData = data[section] as Record<string, any>;
      const changes: Record<string, { old: any; new: any }> = {};
      const updatePayload: Record<string, any> = {};

      Object.entries(editValues).forEach(([key, val]) => {
        const oldVal = String(oldData?.[key] ?? '');
        if (val !== oldVal) {
          changes[key] = { old: oldVal, new: val };
          updatePayload[key] = val || null;
        }
      });

      if (Object.keys(updatePayload).length === 0) {
        toast.info('No changes detected');
        setSaving(false);
        return;
      }

      // Determine table and ID
      let table: string;
      let recordId: string;
      if (section === 'profile') {
        table = 'profiles';
        recordId = tenantId;
      } else if (section === 'landlord') {
        table = 'landlords';
        recordId = (data.landlord as any)?.id;
      } else if (section === 'lc1') {
        table = 'lc1_chairpersons';
        recordId = (data.lc1 as any)?.id;
      } else {
        table = 'rent_requests';
        recordId = data.request?.id || '';
      }

      if (!recordId) {
        toast.error('Record not found');
        setSaving(false);
        return;
      }

      const { error } = await supabase
        .from(table as any)
        .update(updatePayload)
        .eq('id', recordId);

      if (error) throw error;

      // Audit log
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: user?.id || '',
        action_type: 'tenant_registration_edited',
        entity_type: table,
        entity_id: recordId,
        reason: reason.trim(),
        metadata: {
          tenant_id: tenantId,
          tenant_name: tenantName,
          section,
          changes,
        },
      });

      toast.success('Registration updated successfully');
      setReasonDialog({ open: false, section: null });
      setEditingSection(null);
      setEditValues({});
      queryClient.invalidateQueries({ queryKey: ['tenant-registration', tenantId] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const renderSection = (
    title: string,
    icon: React.ElementType,
    sectionKey: SectionKey,
    fields: FieldDef[],
    sectionData: Record<string, any> | null | undefined,
  ) => {
    const Icon = icon;
    const isEditing = editingSection === sectionKey;
    const hasData = !!sectionData;

    return (
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10">
                <Icon className="h-4 w-4 text-primary" />
              </div>
              <CardTitle className="text-sm">{title}</CardTitle>
            </div>
            {hasData && !isEditing && (
              <Button variant="ghost" size="sm" className="h-8 px-2 gap-1.5 text-xs" onClick={() => startEdit(sectionKey)}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
            )}
            {isEditing && (
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" className="h-8 px-2 gap-1 text-xs" onClick={cancelEdit}>
                  <X className="h-3.5 w-3.5" /> Cancel
                </Button>
                <Button size="sm" className="h-8 px-3 gap-1 text-xs" onClick={promptSave}>
                  <Save className="h-3.5 w-3.5" /> Save
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {!hasData ? (
            <p className="text-sm text-muted-foreground py-2">No data available</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
              {fields.map((f) => {
                const FieldIcon = f.icon;
                const value = sectionData[f.key];
                return (
                  <div key={f.key} className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
                      {FieldIcon && <FieldIcon className="h-3 w-3" />}
                      {f.label}
                    </Label>
                    {isEditing && !f.readOnly ? (
                      <Input
                        value={editValues[f.key] ?? ''}
                        onChange={(e) => setEditValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                        className="h-9 text-sm"
                      />
                    ) : (
                      <p className="text-sm font-medium text-foreground truncate">
                        {value || <span className="text-muted-foreground/60">—</span>}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-3">
      <Button variant="ghost" onClick={onBack} className="h-10 px-3 gap-2 text-sm font-semibold -ml-1">
        <ArrowLeft className="h-4 w-4" /> Back · {tenantName}
      </Button>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-32 bg-muted animate-pulse rounded-xl" />)}
        </div>
      ) : (
        <>
          {/* Request status badge */}
          {data?.request && (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {String(data.request.status || '').replace(/_/g, ' ')}
              </Badge>
              {(data?.houseImages?.length ?? 0) > 0 && (
                <Badge variant="secondary" className="text-xs gap-1">
                  <ImageIcon className="h-3 w-3" />
                  {data!.houseImages.length} photo(s)
                </Badge>
              )}
            </div>
          )}

          {/* Tenant passport photo */}
          {data?.passportUrl && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <User className="h-4 w-4 text-primary" /> Tenant Passport Photo
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <a href={data.passportUrl} target="_blank" rel="noopener noreferrer" className="inline-block">
                  <img
                    src={data.passportUrl}
                    alt={`Tenant ${tenantName}`}
                    className="h-40 w-32 rounded-lg object-cover border border-border hover:ring-2 hover:ring-primary/50 transition-all"
                  />
                </a>
                <p className="text-[10px] text-muted-foreground mt-2">
                  Captured by the agent at registration. Click to enlarge.
                </p>
              </CardContent>
            </Card>
          )}

          {/* House images gallery — the agent's current uploads from the tenant profile sheet */}
          {(data?.houseImages?.length ?? 0) > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <ImageIcon className="h-4 w-4 text-primary" /> House Photos
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-3 sm:flex sm:overflow-x-auto gap-2 pb-1">
                  {data!.houseImages.map((url: string, i: number) => (
                    <a key={`${url}-${i}`} href={url} target="_blank" rel="noopener noreferrer" className="sm:shrink-0">
                      <img
                        src={url}
                        alt={`House ${i + 1}`}
                        loading="lazy"
                        className="h-20 w-full sm:w-20 rounded-lg object-cover border border-border hover:ring-2 hover:ring-primary/50 transition-all"
                      />
                    </a>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2">
                  {data!.houseImagesFromDocs
                    ? 'Current photos the agent uploaded on the tenant profile sheet.'
                    : 'From the rent request snapshot — no current uploads on file for this tenant.'}
                </p>
              </CardContent>
            </Card>
          )}


          {renderSection('Tenant Profile', User, 'profile', profileFields, data?.profile)}
          {renderSection('Landlord Information', Home, 'landlord', landlordFields, data?.landlord)}
          {renderSection('LC1 Chairperson', Shield, 'lc1', lc1Fields, data?.lc1)}
          {renderSection('Rent Request Details', FileText, 'request', requestFields, data?.request)}
        </>
      )}

      {/* Audit reason dialog */}
      <Dialog open={reasonDialog.open} onOpenChange={(open) => !saving && setReasonDialog({ open, section: open ? reasonDialog.section : null })}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reason for Edit</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-sm">Why are you editing this information? (min 10 chars)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Correcting phone number per tenant call..."
              className="h-10"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">{reason.trim().length}/10 characters minimum</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonDialog({ open: false, section: null })} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || reason.trim().length < 10}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Saving...</> : 'Confirm & Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

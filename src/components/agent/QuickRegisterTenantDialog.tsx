import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Loader2, UserPlus, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ExistingTenantPhoneNotice } from '@/components/agent/ExistingTenantPhoneNotice';
import { useExistingTenantByPhone, type ExistingTenantMatch } from '@/hooks/useExistingTenantByPhone';
import {
  joinPersonName,
  splitPersonName,
  validatePersonNameParts,
  type PersonNameParts,
} from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { collectAgentSignupTelemetry } from '@/lib/agentSignupTelemetry';
import { NationalIdConsentDialog } from '@/components/shared/NationalIdConsentDialog';

interface QuickRegisterTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefillPhone?: string;
  /** Called with the new tenant's phone after successful registration */
  onRegistered?: (phone: string) => void;
}

/**
 * Lightweight tenant registration used inline when an agent attempts
 * a payment for a phone number that is not yet on the platform.
 * Captures the minimum required to create the profile (name, phone, national ID).
 */
export function QuickRegisterTenantDialog({
  open,
  onOpenChange,
  prefillPhone,
  onRegistered,
}: QuickRegisterTenantDialogProps) {
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const setFullName = (next: string) => setNameParts(splitPersonName(next));
  const [phone, setPhone] = useState('');
  const [nationalId, setNationalId] = useState('');
  const [nationalIdName, setNationalIdName] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Consent flow state for borrowed National ID
  const [consentModalOpen, setConsentModalOpen] = useState(false);
  const [consentStage, setConsentStage] = useState<'awaiting_owner_phone' | 'awaiting_code'>('awaiting_owner_phone');
  const [consentDeclarationId, setConsentDeclarationId] = useState<string | null>(null);
  const [consentErrorMessage, setConsentErrorMessage] = useState<string | null>(null);
  const [consentOwnerPhone, setConsentOwnerPhone] = useState('');
  const [consentSubmitting, setConsentSubmitting] = useState(false);

  // Live fraud guard: reveal if this phone is already registered.
  const { match: existingTenantByPhone, checking: checkingTenantPhone } =
    useExistingTenantByPhone(phone);
  const useExistingTenantMatch = (m: ExistingTenantMatch) => {
    if (m.full_name) setFullName(m.full_name);
    if (m.national_id) setNationalId(m.national_id.toUpperCase());
    toast.success(`Using ${m.full_name || 'existing tenant'}'s record`);
  };

  useEffect(() => {
    if (open) {
      setPhone(prefillPhone?.trim() || '');
      setFullName('');
      setNationalId('');
      setNationalIdName('');
      setConsentModalOpen(false);
      setConsentDeclarationId(null);
      setConsentErrorMessage(null);
      setConsentOwnerPhone('');
      setDone(false);
    }
  }, [open, prefillPhone]);

  const submitRegistration = async (consentParams?: {
    id_owner_phone?: string;
    consent_declaration_id?: string;
    consent_code?: string;
  }) => {
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Please enter a real full name');
      return;
    }

    if (consentParams) {
      setConsentSubmitting(true);
      setConsentErrorMessage(null);
    } else {
      setLoading(true);
    }

    try {
      const payload: Record<string, unknown> = {
        full_name: nameCheck.fullName,
        phone: phone.trim(),
        national_id: nationalId.trim().toUpperCase(),
        national_id_name: nationalIdName.trim() || undefined,
        telemetry: await collectAgentSignupTelemetry('/agent/quick-register-tenant', 'tenant'),
        ...(consentParams?.id_owner_phone ? { id_owner_phone: consentParams.id_owner_phone } : {}),
        ...(consentParams?.consent_declaration_id ? { consent_declaration_id: consentParams.consent_declaration_id } : {}),
        ...(consentParams?.consent_code ? { consent_code: consentParams.consent_code } : {}),
      };

      const res = await supabase.functions.invoke('register-tenant', { body: payload });

      let parsedBody: Record<string, unknown> | null = null;
      if (res.error?.context) {
        try {
          parsedBody = (await res.error.context.clone().json()) as Record<string, unknown>;
        } catch {
          try {
            parsedBody = (await res.error.context.json()) as Record<string, unknown>;
          } catch (_e) {
            parsedBody = null;
          }
        }
      }
      if (!parsedBody && res.data) parsedBody = res.data as Record<string, unknown>;

      if (parsedBody?.code === 'id_owner_consent_required') {
        const nextStage =
          (parsedBody.stage as 'awaiting_owner_phone' | 'awaiting_code') ||
          (parsedBody.declaration_id ? 'awaiting_code' : 'awaiting_owner_phone');
        setConsentStage(nextStage);
        if (parsedBody.declaration_id) setConsentDeclarationId(String(parsedBody.declaration_id));
        if (consentParams?.id_owner_phone) setConsentOwnerPhone(consentParams.id_owner_phone);
        setConsentErrorMessage(typeof parsedBody.error === 'string' ? parsedBody.error : null);
        setConsentModalOpen(true);
        return;
      }

      if (parsedBody?.code === 'registration_restricted') {
        const r = (parsedBody.restriction ?? {}) as Record<string, unknown>;
        const detail = [
          `Active tenants: ${r.active_tenants ?? '—'} (restriction starts at ${r.min_active_tenants ?? '—'})`,
          `Last month you collected ${r.previous_month_performance_pct ?? '—'}% of what was due`,
          `Required: ${r.required_performance_pct ?? '—'}%`,
        ].join(' · ');
        setConsentModalOpen(false);
        toast.error(
          typeof parsedBody.error === 'string' ? parsedBody.error : 'You cannot add a new tenant right now',
          { description: detail, duration: 15000 },
        );
        return;
      }

      if (res.error || (parsedBody && parsedBody.error)) {
        const msg =
          (typeof parsedBody?.error === 'string' && parsedBody.error) ||
          res.error?.message ||
          'Failed to register tenant';
        if (consentParams) {
          setConsentErrorMessage(msg);
        } else {
          toast.error(msg);
        }
        return;
      }

      setConsentModalOpen(false);
      setDone(true);
      if ((res.data as Record<string, unknown>)?.existing) {
        toast.info(`${fullName.trim()} is already registered`, {
          description: 'Using the existing tenant record to proceed.',
        });
      } else {
        toast.success(`${fullName.trim()} registered successfully`);
      }
      onRegistered?.(phone.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to register tenant';
      toast.error(msg);
    } finally {
      setLoading(false);
      setConsentSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !phone.trim() || !nationalId.trim()) {
      toast.error('Please fill in name, phone and national ID');
      return;
    }
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Please enter a real full name');
      return;
    }
    if (nationalId.trim().length < 10) {
      toast.error('National ID must be 10–14 characters');
      return;
    }

    await submitRegistration();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            Quick Register Tenant
          </DialogTitle>
          <DialogDescription>
            Add this tenant to the platform so you can process their payment.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <p className="font-semibold">{fullName} is now on the platform</p>
            <p className="text-sm text-muted-foreground">
              You can now retry the payment using {phone}.
            </p>
            <Button onClick={() => onOpenChange(false)} className="w-full h-12">
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <PersonNameFields
              idPrefix="qr"
              value={nameParts}
              onChange={setNameParts}
              disabled={loading}
            />

            <div className="space-y-2">
              <Label htmlFor="qr-phone">Phone Number</Label>
              <PhoneInput
                id="qr-phone"
                placeholder="e.g. 0700123456"
                value={phone}
                onChange={(v) => setPhone(v)}
                onContactPicked={({ name }) => {
                  if (name && !fullName.trim()) setFullName(name);
                }}
                disabled={loading}
                className="h-12"
              />
              <ExistingTenantPhoneNotice
                match={existingTenantByPhone}
                checking={checkingTenantPhone}
                onUse={useExistingTenantMatch}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="qr-nid">National ID</Label>
              <Input
                id="qr-nid"
                placeholder="10–14 alphanumeric characters"
                value={nationalId}
                onChange={(e) => setNationalId(e.target.value.toUpperCase())}
                disabled={loading}
                className="h-12 font-mono uppercase"
                maxLength={14}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="qr-nid-name">Name on National ID</Label>
                <span className="text-[10px] text-muted-foreground">Optional</span>
              </div>
              <Input
                id="qr-nid-name"
                placeholder="Name exactly as printed on ID"
                value={nationalIdName}
                onChange={(e) => setNationalIdName(e.target.value)}
                disabled={loading}
                className="h-12"
              />
              <p className="text-[11px] text-muted-foreground">
                Only needed if using someone else&apos;s ID
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 h-12"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button type="submit" className="flex-1 h-12" disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Register Tenant'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>

      <NationalIdConsentDialog
        open={consentModalOpen}
        onOpenChange={setConsentModalOpen}
        stage={consentStage}
        declarationId={consentDeclarationId}
        errorMessage={consentErrorMessage}
        idOwnerName={nationalIdName}
        registrantName={fullName}
        initialOwnerPhone={consentOwnerPhone}
        submitting={consentSubmitting}
        onSubmitPhone={async (ownerPhone) => {
          setConsentOwnerPhone(ownerPhone);
          await submitRegistration({ id_owner_phone: ownerPhone });
        }}
        onSubmitCode={async (consentCode) => {
          await submitRegistration({
            id_owner_phone: consentOwnerPhone,
            consent_declaration_id: consentDeclarationId || undefined,
            consent_code: consentCode,
          });
        }}
        onResendCode={async () => {
          await submitRegistration({ id_owner_phone: consentOwnerPhone });
        }}
      />
    </Dialog>
  );
}

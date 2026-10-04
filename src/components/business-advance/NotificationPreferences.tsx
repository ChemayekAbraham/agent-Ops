import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Bell, Mail, MessageSquare, Loader2, Pencil, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { z } from 'zod';

const phoneSchema = z
  .string()
  .trim()
  .min(7, { message: 'Phone number is too short' })
  .max(20, { message: 'Phone number is too long' })
  .regex(/^\+?[0-9\s-]+$/, { message: 'Use digits only, optionally starting with +' });

const emailSchema = z
  .string()
  .trim()
  .email({ message: 'Enter a valid email address' })
  .max(255, { message: 'Email is too long' });

/**
 * Compact notification-preferences card letting a tenant toggle SMS and/or
 * email alerts for Business Advance status changes. Persists to
 * `profiles.business_advance_notify_sms` / `business_advance_notify_email`
 * which the `notify-business-advance-status` edge function reads before
 * dispatching each channel.
 */
export function BusinessAdvanceNotificationPreferences({ userId }: { userId: string }) {
  const [loading, setLoading] = useState(true);
  const [sms, setSms] = useState(true);
  const [email, setEmail] = useState(true);
  const [emailAddr, setEmailAddr] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [saving, setSaving] = useState<'sms' | 'email' | null>(null);
  const [editing, setEditing] = useState<'phone' | 'email' | null>(null);
  const [phoneInput, setPhoneInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [savingContact, setSavingContact] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('business_advance_notify_sms, business_advance_notify_email, email, phone')
        .eq('id', userId)
        .maybeSingle();
      if (!alive) return;
      if (!error && data) {
        setSms(data.business_advance_notify_sms !== false);
        setEmail(data.business_advance_notify_email !== false);
        setEmailAddr((data as any).email ?? null);
        setPhone((data as any).phone ?? null);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [userId]);

  const startEdit = (field: 'phone' | 'email') => {
    if (field === 'phone') setPhoneInput(phone ?? '');
    if (field === 'email') setEmailInput(emailAddr ?? '');
    setEditing(field);
  };

  const saveContact = async (field: 'phone' | 'email') => {
    const raw = field === 'phone' ? phoneInput : emailInput;
    const parsed = field === 'phone' ? phoneSchema.safeParse(raw) : emailSchema.safeParse(raw);
    if (!parsed.success) {
      toast.error('Invalid input', { description: parsed.error.issues[0]?.message ?? 'Please check the value.' });
      return;
    }
    const value = parsed.data;
    setSavingContact(true);
    const flagCol = field === 'phone' ? 'business_advance_notify_sms' : 'business_advance_notify_email';
    const { error } = await supabase
      .from('profiles')
      .update({ [field]: value, [flagCol]: true })
      .eq('id', userId);
    setSavingContact(false);
    if (error) {
      toast.error(`Could not save ${field === 'phone' ? 'phone number' : 'email'}`, {
        description: error.message.includes('duplicate')
          ? 'That value is already in use by another account.'
          : 'Please try again in a moment.',
      });
      return;
    }
    if (field === 'phone') {
      setPhone(value);
      setSms(true);
      toast.success('Phone number saved', { description: `SMS alerts turned on for ${value}.` });
    } else {
      setEmailAddr(value);
      setEmail(true);
      toast.success('Email saved', { description: `Email alerts turned on for ${value}.` });
    }
    setEditing(null);
  };

  const update = async (field: 'sms' | 'email', value: boolean) => {
    // Guard: cannot enable a channel that has no destination on file
    if (value && field === 'sms' && !phone) {
      toast.error('No phone number on file', {
        description: 'Add a phone number to your profile before turning on SMS alerts.',
        action: {
          label: 'Open profile',
          onClick: () => { window.location.href = '/profile'; },
        },
      });
      return;
    }
    if (value && field === 'email' && !emailAddr) {
      toast.error('No email address on file', {
        description: 'Add an email to your profile before turning on email alerts.',
        action: {
          label: 'Open profile',
          onClick: () => { window.location.href = '/profile'; },
        },
      });
      return;
    }

    const col = field === 'sms' ? 'business_advance_notify_sms' : 'business_advance_notify_email';
    setSaving(field);
    // optimistic
    if (field === 'sms') setSms(value); else setEmail(value);
    const { error } = await supabase.from('profiles').update({ [col]: value }).eq('id', userId);
    setSaving(null);
    if (error) {
      toast.error('Could not save preference', {
        description: `We couldn't update your ${field === 'sms' ? 'SMS' : 'email'} alert setting. Please try again.`,
      });
      if (field === 'sms') setSms(!value); else setEmail(!value);
    } else {
      const channelLabel = field === 'sms' ? 'SMS alerts' : 'Email alerts';
      const destination = field === 'sms' ? phone : emailAddr;
      toast.success(value ? `${channelLabel} turned on` : `${channelLabel} turned off`, {
        description: value
          ? `We'll notify you${destination ? ` at ${destination}` : ''} when your Business Advance moves between stages.`
          : `You won't receive ${field === 'sms' ? 'SMS' : 'email'} updates for Business Advance stage changes.`,
      });
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-muted/30 p-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading preferences…
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <Bell className="h-3.5 w-3.5 text-primary" /> Notification preferences
      </div>
      <p className="text-[11px] text-muted-foreground leading-snug">
        Choose how we alert you when your Business Advance moves between stages.
      </p>

      <div className="flex items-center justify-between gap-3 pt-1">
        <Label htmlFor="ba-notify-sms" className="flex items-center gap-2 text-xs font-medium cursor-pointer">
          <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span>
            SMS
            {phone
              ? <span className="block text-[10px] text-muted-foreground font-normal">{phone}</span>
              : <span className="block text-[10px] text-amber-600 font-normal">Add a phone number to enable</span>}
          </span>
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => startEdit('phone')}
            disabled={editing === 'phone'}
          >
            <Pencil className="h-3 w-3 mr-1" /> {phone ? 'Edit' : 'Add'}
          </Button>
          <Switch
            id="ba-notify-sms"
            checked={sms}
            disabled={saving === 'sms' || !phone}
            onCheckedChange={(v) => update('sms', v)}
          />
        </div>
      </div>
      {editing === 'phone' && (
        <div className="flex items-center gap-1.5 pl-5">
          <Input
            type="tel"
            inputMode="tel"
            autoFocus
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="+256 7XX XXX XXX"
            maxLength={20}
            className="h-8 text-xs"
          />
          <Button type="button" size="sm" className="h-8 px-2" disabled={savingContact} onClick={() => saveContact('phone')}>
            {savingContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={savingContact} onClick={() => setEditing(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="ba-notify-email" className="flex items-center gap-2 text-xs font-medium cursor-pointer">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <span>
            Email
            {emailAddr
              ? <span className="block text-[10px] text-muted-foreground font-normal">{emailAddr}</span>
              : <span className="block text-[10px] text-amber-600 font-normal">Add an email to enable</span>}
          </span>
        </Label>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => startEdit('email')}
            disabled={editing === 'email'}
          >
            <Pencil className="h-3 w-3 mr-1" /> {emailAddr ? 'Edit' : 'Add'}
          </Button>
          <Switch
            id="ba-notify-email"
            checked={email}
            disabled={saving === 'email' || !emailAddr}
            onCheckedChange={(v) => update('email', v)}
          />
        </div>
      </div>
      {editing === 'email' && (
        <div className="flex items-center gap-1.5 pl-5">
          <Input
            type="email"
            inputMode="email"
            autoFocus
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@example.com"
            maxLength={255}
            className="h-8 text-xs"
          />
          <Button type="button" size="sm" className="h-8 px-2" disabled={savingContact} onClick={() => saveContact('email')}>
            {savingContact ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={savingContact} onClick={() => setEditing(null)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

export default BusinessAdvanceNotificationPreferences;
import { useState, useEffect, useRef, lazy, Suspense, Component, ReactNode, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Helmet } from 'react-helmet-async';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, User, Phone, Mail, Save, Loader2, Camera, Shield, Home, Users, Wallet, Building2, Check, Type, Vibrate, LogIn, Volume2, Scale, Lock, Eye, EyeOff, Settings as SettingsIcon, Palette, ShieldCheck, Zap, Smartphone, Clock, Wind, Bell, ChevronRight, ChevronDown, Accessibility } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';



import { useHapticSettings, hapticIntensityOptions } from '@/hooks/useHapticSettings';
import { useReducedMotion, reducedMotionOptions } from '@/hooks/useCombinedSettings';
import { hapticSelection } from '@/lib/haptics';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { toast } from 'sonner';
import { publishAvatarUpdate } from '@/lib/avatarSync';
import { ThemeModeSelector } from '@/components/settings/ThemeModeSelector';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useFontSize, fontSizeOptions } from '@/hooks/useFontSize';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { LiquidToggle as Switch, GooeyFilter } from '@/components/ui/liquid-toggle';
import { useAppPreferences } from '@/hooks/useAppPreferences';
import { playNotificationSound } from '@/lib/notificationSound';
import { cn } from '@/lib/utils';
import { useOtpVerification } from '@/hooks/useOtpVerification';
import { normalizeE164OrNull } from '@/lib/phoneUtils';
import { joinPersonName, splitPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import PersonNameFields from '@/components/shared/PersonNameFields';
import NameCompletionReminder from '@/components/notifications/NameCompletionReminder';
import { OtpVerificationStep } from '@/components/auth/OtpVerificationStep';


const DiagnosticsSection = lazy(() => import('@/components/settings/DiagnosticsSection'));
const PinSecuritySection = lazy(() => import('@/components/settings/PinSecuritySection'));
const BiometricSecuritySection = lazy(() => import('@/components/settings/BiometricSecuritySection'));
const DeviceSessionsSection = lazy(() => import('@/components/settings/DeviceSessionsSection'));
const TwoFactorSection = lazy(() => import('@/components/settings/TwoFactorSection'));
const TrustPrivacySection = lazy(() => import('@/components/settings/TrustPrivacySection'));
const ResidenceAddressForm = lazy(() => import('@/components/profile/ResidenceAddressForm'));
const EmailEditor = lazy(() => import('@/components/profile/EmailEditor'));
const MobileMoneyNameCard = lazy(() => import('@/components/settings/MobileMoneyNameCard'));
const NationalIdCard = lazy(() => import('@/components/settings/NationalIdCard'));
const IdentityPhotoCapture = lazy(() => import('@/components/wallet/IdentityPhotoCapture'));
const AccountLinkingCard = lazy(() => import('@/components/settings/AccountLinkingCard'));


const ArchivedPdfsCard = lazy(() =>
  import('@/components/settings/ArchivedPdfsCard').then((m) => ({ default: m.ArchivedPdfsCard })),
);

const PushNotificationButton = lazy(() => import('@/components/PushNotificationButton').then(m => ({ default: m.PushNotificationButton })));
import { TenantNotificationPreferencesCard } from '@/components/tenant/TenantNotificationPreferencesCard';

/**
 * Chunk prefetch map — dynamic imports are module-cached, so calling these
 * ahead of time warms the chunk and makes tab switches instant (no skeleton).
 */
const SECTION_PREFETCH: Record<string, Array<() => Promise<unknown>>> = {
  account: [
    () => import('@/components/profile/EmailEditor'),
    () => import('@/components/profile/ResidenceAddressForm'),
    () => import('@/components/settings/MobileMoneyNameCard'),
    () => import('@/components/settings/NationalIdCard'),
    () => import('@/components/wallet/IdentityPhotoCapture'),
    () => import('@/components/wallet/WalletCard'),
    () => import('@/components/settings/AccountLinkingCard'),
    () => import('@/components/settings/ArchivedPdfsCard'),
  ],
  appearance: [],
  notifications: [
    () => import('@/components/PushNotificationButton'),
  ],
  security: [
    () => import('@/components/settings/PinSecuritySection'),
    () => import('@/components/settings/BiometricSecuritySection'),
    () => import('@/components/settings/TwoFactorSection'),
    () => import('@/components/settings/DeviceSessionsSection'),
    () => import('@/components/settings/TrustPrivacySection'),
  ],
  legal: [() => import('@/components/settings/LegalSection')],
  advanced: [() => import('@/components/settings/DiagnosticsSection')],
};

const prefetched = new Set<string>();
function prefetchSection(id: string) {
  if (prefetched.has(id)) return;
  prefetched.add(id);
  (SECTION_PREFETCH[id] ?? []).forEach((load) => { void load().catch(() => {}); });
}



class SectionBoundary extends Component<{ children: ReactNode; name: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: Error) { console.warn(`[Settings/${this.props.name}] failed:`, error.message); }
  render() {
    if (this.state.hasError) {
      return (
        <Card className="border-destructive/20 bg-destructive/5 rounded-2xl">
          <CardContent className="py-6 text-center">
            <p className="text-sm text-muted-foreground">This section couldn't load.</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => this.setState({ hasError: false })}>Try again</Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}

function SectionSkeleton() {
  return (
    <div className="py-6 space-y-3 px-1">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-10 w-full rounded-xl" />
      <Skeleton className="h-10 w-full rounded-xl" />
    </div>
  );
}

function LazySection({ children, name }: { children: ReactNode; name: string }) {
  return (
    <SectionBoundary name={name}>
      <Suspense fallback={<SectionSkeleton />}>{children}</Suspense>
    </SectionBoundary>
  );
}

/** iOS-style grouped container: rows separated by hairline dividers. */
function SettingsGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-2xl border border-border/40 bg-card overflow-hidden divide-y divide-border/40', className)}>
      {children}
    </div>
  );
}

/** A single tappable (or static) row inside a SettingsGroup. */
function SettingsLinkRow({
  icon: Icon,
  label,
  helper,
  onClick,
  trailing,
  chevron,
}: {
  icon?: typeof User;
  label: string;
  helper?: string;
  onClick?: () => void;
  trailing?: ReactNode;
  chevron?: boolean;
}) {
  const inner = (
    <>
      {Icon && <Icon className="h-4 w-4 text-primary shrink-0" />}
      <div className="flex-1 min-w-0 text-left">
        <p className="text-sm font-semibold truncate">{label}</p>
        {helper && <p className="text-xs text-muted-foreground truncate">{helper}</p>}
      </div>
      {trailing}
      {(chevron ?? !!onClick) && <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
    </>
  );
  const base = 'w-full flex items-center gap-3 px-4 py-3 min-h-[48px]';
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(base, 'transition-colors hover:bg-muted/40 active:bg-muted/60 touch-manipulation')}>
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}

/** Section heading used above grouped rows. */
function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="px-1 text-base font-semibold tracking-tight">{children}</h2>;
}

interface Profile { id: string; full_name: string; email: string; phone: string; avatar_url: string | null; }
type SettingsSection = 'account' | 'appearance' | 'notifications' | 'accessibility' | 'security' | 'legal' | 'advanced';

const SECTIONS: { id: SettingsSection; label: string; icon: typeof User; helper: string }[] = [
  { id: 'account', label: 'Personal Information', icon: User, helper: 'Profile, contact, withdrawal and sign-in' },
  { id: 'appearance', label: 'Appearance', icon: Palette, helper: 'Theme and display' },
  { id: 'notifications', label: 'Notifications', icon: Bell, helper: 'Push alerts and sounds' },
  { id: 'accessibility', label: 'Accessibility', icon: Accessibility, helper: 'Text size, motion, vibration and contrast' },
  { id: 'security', label: 'Safety', icon: ShieldCheck, helper: 'PIN, biometrics, devices and alerts' },
  { id: 'legal', label: 'Legal', icon: Scale, helper: 'Agreements and policy documents' },
  { id: 'advanced', label: 'More', icon: SettingsIcon, helper: 'Diagnostics and advanced tools' },
];

type AccountTab = 'profile' | 'contact' | 'withdrawal' | 'access' | 'vault';

const ACCOUNT_TABS: { id: AccountTab; label: string; helper: string; icon: typeof User }[] = [
  { id: 'profile', label: 'Profile', helper: 'Photo, name and phone number', icon: User },
  { id: 'contact', label: 'Contact', helper: 'Email address and notifications', icon: Mail },
  { id: 'withdrawal', label: 'Withdrawal & Identity', helper: 'Mobile money, National ID and verification', icon: Wallet },
  { id: 'access', label: 'Sign-in', helper: 'Linked accounts and sign-in methods', icon: ShieldCheck },
  { id: 'vault', label: 'Vault', helper: 'Offline PDF documents', icon: Lock },
];

export default function Settings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, roles, loading: authLoading, role } = useAuth();
  const { fontSize, setFontSize } = useFontSize();
  const { intensity: hapticIntensity, setIntensity: setHapticIntensity } = useHapticSettings();
  const { reducedMotion, setReducedMotion } = useReducedMotion();
  // Reflects what is actually applied to the page (the app also switches this
  // on automatically for low-end phones), not just what the user last picked.
  const [reduceGraphics, setReduceGraphics] = useState<boolean>(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('no-backdrop-blur')
  );
  const { preferences, updatePreference } = useAppPreferences();
  
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  // Name is captured in parts but stored/submitted as the same single string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const fullName = joinPersonName(nameParts);
  const [phone, setPhone] = useState('');
  const otp = useOtpVerification();
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** Mirrors the edge-function + DB normalizer exactly for client-side preview.
   * Returns '' when the number is malformed so the preview/validation can warn. */
  const previewNormalizePhone = (raw: string): string => normalizeE164OrNull(raw) ?? '';

  /** Pretty-print E.164 like +256 783 673 998 when possible */
  const formatPhonePreview = (e164: string): string => {
    const ug = e164.match(/^\+(256)(\d{3})(\d{3})(\d{3})$/);
    if (ug) return `+${ug[1]} ${ug[2]} ${ug[3]} ${ug[4]}`;
    const gen = e164.match(/^(\+\d{1,4})(\d{3})(\d{3})(\d+)$/);
    if (gen) return `${gen[1]} ${gen[2]} ${gen[3]} ${gen[4]}`;
    return e164;
  };

  const normalizedPreview = useMemo(() => normalizeE164OrNull(phone) ?? '', [phone]);
  // True when the user has typed something that isn't a valid phone number.
  const phoneInvalid = useMemo(
    () => phone.trim().length > 0 && normalizeE164OrNull(phone) === null,
    [phone],
  );
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get('section') as SettingsSection | null;
  const openSection: SettingsSection | null =
    sectionParam && SECTIONS.some(s => s.id === sectionParam) ? sectionParam : null;
  const activeSection: SettingsSection = openSection ?? 'account';
  const setActiveSection = (id: SettingsSection) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', id);
    setSearchParams(next);
  };
  const closeSection = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('section');
    next.delete('tab');
    setSearchParams(next);
  };
  const tabParam = searchParams.get('tab');
  const openAccountTab: AccountTab | null =
    tabParam === 'verification' || tabParam === 'identity'
      ? 'withdrawal'
      : tabParam && ACCOUNT_TABS.some(t => t.id === tabParam)
        ? (tabParam as AccountTab)
        : null;
  const accountTab: AccountTab = openAccountTab ?? 'profile';
  const setAccountTab = (id: AccountTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('section', 'account');
    next.set('tab', id);
    setSearchParams(next);
  };
  const closeAccountTab = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next);
  };
  const [deferredReady, setDeferredReady] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  
  const [textSizeOpen, setTextSizeOpen] = useState(false);
  const [vibrationOpen, setVibrationOpen] = useState(false);
  const [motionOpen, setMotionOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);




  useEffect(() => { if (!authLoading && !user) navigate('/auth'); }, [user, authLoading, navigate]);
  useEffect(() => { if (user) fetchProfile(); }, [user]);
  useEffect(() => { const t = setTimeout(() => setDeferredReady(true), 300); return () => clearTimeout(t); }, []);

  // Warm every section's lazy chunks shortly after mount so tab switches are instant.
  useEffect(() => {
    const ids = Object.keys(SECTION_PREFETCH);
    const idle = (cb: () => void) =>
      typeof (window as any).requestIdleCallback === 'function'
        ? (window as any).requestIdleCallback(cb, { timeout: 1500 })
        : window.setTimeout(cb, 400);
    const handle = idle(() => ids.forEach(prefetchSection));
    return () => {
      if (typeof (window as any).cancelIdleCallback === 'function') (window as any).cancelIdleCallback(handle);
      else clearTimeout(handle);
    };
  }, []);


  const fetchProfile = async () => {
    if (!user) return;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) { console.error('Error fetching profile:', error); setLoading(false); return; }
    if (data) { setProfile(data as Profile); setNameParts(splitPersonName(data.full_name)); setPhone(data.phone); }
    setLoading(false);
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (!file.type.startsWith('image/')) { toast.error('Please upload an image file'); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error('Image must be less than 5MB'); return; }
    setUploadingAvatar(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;
      await supabase.storage.from('avatars').remove([filePath]);
      const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const avatarUrl = `${publicUrl}?t=${Date.now()}`;
      const { error: updateError } = await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', user.id);
      if (updateError) throw updateError;
      setProfile(prev => prev ? { ...prev, avatar_url: avatarUrl } : null);
      // Repaint every other view showing this face (own profile, ops queues,
      // audit logs, public profiles) and any other open tab, immediately.
      publishAvatarUpdate(user.id, avatarUrl);
      toast.success('Profile photo updated everywhere!');
    } catch (error) { console.error('Error uploading avatar:', error); toast.error('Failed to upload photo'); }
    finally { setUploadingAvatar(false); }
  };

  const handleSave = async () => {
    if (!user || !profile) return;
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) { toast.error(nameCheck.error || 'Full name is required'); return; }
    if (!phone.trim()) { toast.error('Phone number is required'); return; }
    if (normalizeE164OrNull(phone) === null) {
      toast.error('Please enter a valid phone number (e.g. 0771234567 or +256771234567)');
      return;
    }
    setSaving(true);
    const trimmedName = nameCheck.fullName;
    const trimmedPhone = phone.trim();
    const phoneChanged = trimmedPhone !== (profile.phone ?? '').trim();
    if (phoneChanged && !otp.otpVerified) {
      toast.error('Please verify the new phone number with the SMS code first');
      setSaving(false);
      return;
    }
    try {
      // Always update full_name via profiles
      if (trimmedName !== (profile.full_name ?? '').trim()) {
        const { error } = await supabase.from('profiles').update({ full_name: trimmedName }).eq('id', user.id);
        if (error) throw error;
      }
      // Phone changes go through edge function to keep auth.users + profiles in sync
      let savedPhone = trimmedPhone;
      if (phoneChanged) {
        const { data, error } = await invokeEdgeFunction<{ phone?: string; error?: string }>(
          'self-update-phone',
          { body: { phone: trimmedPhone }, silent: true, fallbackMessage: 'Failed to update phone' },
        );
        if (error) throw error;
        savedPhone = data?.phone || trimmedPhone;
        otp.resetOtp();
      }
      toast.success('Profile updated successfully');
      setProfile({ ...profile, full_name: trimmedName, phone: savedPhone });
      setPhone(savedPhone);
      queryClient.invalidateQueries({ queryKey: ['name-completion-status'] });
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const getInitials = (name: string) => name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);


  const hasLegalContent = roles.includes('tenant') || roles.includes('agent') || roles.includes('supporter');
  const visibleSections = useMemo(() => SECTIONS.filter(s => s.id !== 'legal' || hasLegalContent), [hasLegalContent]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-6 max-w-2xl space-y-6">
          <div className="flex items-center gap-4">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-2"><Skeleton className="h-6 w-32" /><Skeleton className="h-4 w-48" /></div>
          </div>
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <GooeyFilter />
      <Helmet>
        <title>Account Settings | Welile</title>
        <meta
          name="description"
          content="Manage your Welile account settings — profile, security, notifications, and app preferences in one place."
        />
        <link rel="canonical" href="https://welileapp.com/settings" />
        <meta property="og:title" content="Account Settings | Welile" />
        <meta
          property="og:description"
          content="Manage your Welile profile, security, and app preferences."
        />
        <meta property="og:url" content="https://welileapp.com/settings" />
      </Helmet>
      <div className="container mx-auto px-4 py-4 max-w-2xl pb-24 [padding-bottom:calc(6rem+env(safe-area-inset-bottom))]">
        {/* Header — minimal: circular back control, large title */}
        <div className="sticky top-0 z-30 bg-background -mx-4 px-4 mb-2">
          <div className="flex items-center justify-between gap-2 pt-2 pb-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (openSection === 'account' && openAccountTab) return closeAccountTab();
                if (openSection) return closeSection();
                navigate(roleToSlug(role));
              }}
              aria-label={openSection ? 'Back' : 'Back'}
              className="h-10 w-10 shrink-0 rounded-full bg-muted/60 hover:bg-muted"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={() => navigate(roleToSlug(role))} aria-label="Home" className="h-10 w-10 shrink-0 rounded-full">
              <Home className="h-5 w-5" />
            </Button>
          </div>

          <h1 className="pb-3 text-[28px] font-semibold leading-tight tracking-tight sm:text-[32px]">
            {openSection === 'account' && openAccountTab
              ? ACCOUNT_TABS.find(tab => tab.id === openAccountTab)?.label
              : openSection
                ? SECTIONS.find(section => section.id === openSection)?.label
                : 'Settings'}
          </h1>

        </div>

        {!openSection ? (
          <div className="min-h-[calc(100vh-9rem)]">
            <div className="divide-y divide-border/60">
              {visibleSections.map(({ id, label, helper, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveSection(id)}
                  onPointerEnter={() => prefetchSection(id)}
                  onPointerDown={() => prefetchSection(id)}
                  onFocus={() => prefetchSection(id)}
                  className="flex min-h-[64px] w-full items-center gap-4 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted/40"
                >
                  <Icon className="h-6 w-6 shrink-0 text-foreground" strokeWidth={1.5} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-base font-normal">{label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{helper}</span>
                  </span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                </button>
              ))}
            </div>
          </div>
        ) : (

          /* Active section content — only the selected section renders */
          <div className="mt-1">
            <SectionBoundary name={activeSection}>
            {activeSection === 'account' && (
              <div>
                {!openAccountTab ? (
                  /* Airbnb-style full-width vertical tabs — each opens its own page */
                  <div className="min-h-[calc(100vh-9rem)] divide-y divide-border/60">
                    {ACCOUNT_TABS.map(({ id, label, helper, icon: Icon }) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setAccountTab(id)}
                        className="flex min-h-[64px] w-full items-center gap-4 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted/40"
                      >
                        <Icon className="h-6 w-6 shrink-0 text-foreground" strokeWidth={1.5} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-normal">{label}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{helper}</span>
                        </span>
                        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-4">

                  {accountTab === 'profile' && (
                    <div className="space-y-4">
                      <SectionHeading>Profile</SectionHeading>
                      <SettingsGroup>
                        <SettingsLinkRow
                          icon={Camera}
                          label={uploadingAvatar ? 'Uploading photo…' : 'Profile photo'}
                          helper="Tap to upload a new picture"
                          onClick={() => fileInputRef.current?.click()}
                          trailing={uploadingAvatar ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : undefined}
                        />
                      </SettingsGroup>
                      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarUpload} />
                      <Card className="border-border/40 rounded-2xl">
                        <CardContent className="pt-5 space-y-3">
                          <NameCompletionReminder />
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Your Name</Label>
                            <PersonNameFields idPrefix="settings" value={nameParts} onChange={setNameParts} disabled={saving} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="phone" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</Label>
                            <div className="relative"><Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input id="phone" type="tel" value={phone} onChange={(e) => { setPhone(e.target.value); if (otp.otpVerified || otp.otpSent) otp.resetOtp(); }} placeholder="e.g. 0783673998" className="pl-10 h-12 rounded-xl" /></div>
                            {normalizedPreview && (
                              <div className="flex items-center gap-2 mt-1">
                                <Check className="h-3 w-3 text-success" />
                                <span className="text-[11px] text-muted-foreground">Will be saved as</span>
                                <code className="text-[11px] font-semibold text-foreground bg-primary/10 px-1.5 py-0.5 rounded-md font-mono tracking-tight">
                                  {formatPhonePreview(normalizedPreview)}
                                </code>
                              </div>
                            )}
                            {phoneInvalid && (
                              <p className="text-[11px] text-destructive mt-1">
                                That doesn't look like a valid phone number. Use a Ugandan number (e.g. 0771234567 / +256771234567) or an international number as +&lt;country code&gt;&lt;number&gt;.
                              </p>
                            )}
                            {profile && phone.trim() !== (profile.phone ?? '').trim() && phone.trim() && !phoneInvalid && (
                              <div className="pt-2">
                                <OtpVerificationStep
                                  phone={phone.trim()}
                                  otpSent={otp.otpSent}
                                  otpVerified={otp.otpVerified}
                                  otpLoading={otp.otpLoading}
                                  otpError={otp.otpError}
                                  sendStatus={otp.sendStatus}
                                  cooldownSeconds={otp.cooldownSeconds}
                                  onSendOtp={() => otp.sendOtp(phone.trim(), { category: 'phone_update' })}
                                  onVerifyOtp={(code) => otp.verifyOtp(phone.trim(), code, { category: 'phone_update' })}
                                  onResendOtp={() => otp.sendOtp(phone.trim(), { category: 'phone_update' })}
                                />
                                <p className="text-[11px] text-muted-foreground mt-2">We'll send a 6-digit code to confirm this number before it replaces your current login phone.</p>
                              </div>
                            )}
                          </div>
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between">
                              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Password</Label>
                              <Button variant="link" size="sm" className="h-auto p-0 text-xs text-primary" onClick={() => setShowPasswordForm(!showPasswordForm)}>{showPasswordForm ? 'Cancel' : 'Change'}</Button>
                            </div>
                            {!showPasswordForm ? (
                              <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input value="••••••••" disabled className="pl-10 h-12 rounded-xl bg-muted/50" /></div>
                            ) : (
                              <div className="space-y-2 p-3 rounded-xl bg-muted/30 border border-border/50">
                                <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input type={showCurrentPassword ? 'text' : 'password'} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" className="pl-10 pr-10 h-11 rounded-xl" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8" onClick={() => setShowCurrentPassword(!showCurrentPassword)}>{showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div>
                                <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input type={showNewPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 6 chars)" className="pl-10 pr-10 h-11 rounded-xl" /><Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8" onClick={() => setShowNewPassword(!showNewPassword)}>{showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button></div>
                                <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} placeholder="Confirm new password" className="pl-10 h-11 rounded-xl" /></div>
                                <Button size="sm" className="w-full gap-2 h-11 rounded-xl" disabled={changingPassword || !currentPassword || !newPassword || !confirmNewPassword} onClick={async () => {
                                  if (newPassword.length < 6) { toast.error('Min 6 characters'); return; }
                                  if (newPassword !== confirmNewPassword) { toast.error("Passwords don't match"); return; }
                                  setChangingPassword(true);
                                  try {
                                    const { error: signInError } = await supabase.auth.signInWithPassword({ email: profile?.email || '', password: currentPassword });
                                    if (signInError) { toast.error('Current password is incorrect'); setChangingPassword(false); return; }
                                    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
                                    if (updateError) toast.error('Failed: ' + updateError.message);
                                    else { supabase.functions.invoke('record-password-change').catch(() => {}); toast.success('Password updated!'); setCurrentPassword(''); setNewPassword(''); setConfirmNewPassword(''); setShowPasswordForm(false); }
                                  } catch { toast.error('An error occurred'); }
                                  setChangingPassword(false);
                                }}>{changingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} Update Password</Button>
                              </div>
                            )}
                          </div>
                          {(() => {
                            const phoneChanged = !!profile && phone.trim() !== (profile.phone ?? '').trim();
                            const blocked = phoneChanged && !otp.otpVerified;
                            return (
                              <Button onClick={handleSave} disabled={saving || blocked} className="w-full gap-2 h-12 rounded-xl text-sm font-bold">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {blocked ? 'Verify phone to save' : 'Save Changes'}</Button>
                            );
                          })()}
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {accountTab === 'contact' && (
                    <div className="space-y-4">
                      <SectionHeading>Contact</SectionHeading>
                      {user && profile && (
                        <LazySection name="EmailEditor">
                          <EmailEditor mode="self" userId={user.id} currentEmail={profile.email} onSaved={(e) => setProfile({ ...profile, email: e })} />
                        </LazySection>
                      )}
                      {user && (
                        <LazySection name="ResidenceAddress"><ResidenceAddressForm userId={user.id} /></LazySection>
                      )}
                    </div>
                  )}

                  {accountTab === 'withdrawal' && (
                    <div className="space-y-6">
                      <div>
                        <SectionHeading>Withdrawal account</SectionHeading>
                        <p className="px-1 text-xs text-muted-foreground mt-0.5">
                          The mobile money destination all your withdrawals are paid to.
                        </p>
                      </div>
                      {user && (
                        <LazySection name="MobileMoneyName">
                          <MobileMoneyNameCard userId={user.id} />
                        </LazySection>
                      )}

                      <div className="pt-2">
                        <SectionHeading>Identity verification</SectionHeading>
                        <p className="px-1 text-xs text-muted-foreground mt-0.5">
                          Financial Ops verifies your payout destination against your National ID before releasing funds.
                        </p>
                      </div>
                      {user && (
                        <LazySection name="NationalIdCard">
                          <NationalIdCard userId={user.id} />
                        </LazySection>
                      )}
                      {user && (
                        <LazySection name="IdentityPhotoCapture">
                          <IdentityPhotoCapture compact={false} />
                        </LazySection>
                      )}
                    </div>
                  )}

                  {accountTab === 'access' && (
                    <div className="space-y-4">
                      <SectionHeading>Sign-in methods</SectionHeading>
                      {user && (
                        <LazySection name="AccountLinking">
                          <AccountLinkingCard />
                        </LazySection>
                      )}
                    </div>
                  )}

                  {accountTab === 'vault' && (
                    <div className="space-y-4">
                      <SectionHeading>Offline PDF vault</SectionHeading>
                      <LazySection name="ArchivedPdfs"><ArchivedPdfsCard /></LazySection>
                    </div>
                  )}
                  </div>
                )}
              </div>
            )}



            {activeSection === 'appearance' && (
              <div className="space-y-4">
                <Card className="border-border/40 rounded-2xl">
                  <CardContent className="pt-5 space-y-5">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Palette className="h-4 w-4 text-primary" />
                      <span className="font-medium text-sm">Dark / Light</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">Change the look of the app across light and dark modes.</p>
                    <ThemeModeSelector />
                  </div>

                  
                  
                  </CardContent>
                </Card>

              </div>
            )}

            {activeSection === 'notifications' && (
              <div className="space-y-4">
                <Card className="border-border/40 rounded-2xl">
                  <CardContent className="pt-5 space-y-5">
                  <Collapsible open={soundOpen} onOpenChange={setSoundOpen} className="space-y-2">
                    <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/50 p-2.5 text-left">
                      <span className="flex items-center gap-2"><Volume2 className="h-4 w-4 text-primary" /><span className="font-medium text-sm">Alert Sounds</span></span>
                      <span className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground">{preferences.notificationSounds ? 'On' : 'Off'}</span>
                        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", soundOpen && "rotate-180")} />
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-3 pt-1">
                      <div className="flex items-center justify-between">
                        <p className="text-sm">Enable sounds</p>
                        <Switch checked={preferences.notificationSounds} onCheckedChange={(c) => { updatePreference('notificationSounds', c); if (c) playNotificationSound(preferences.notificationSoundType); toast.success(c ? 'Sounds on' : 'Sounds off'); }} />
                      </div>
                      {preferences.notificationSounds && (
                        <div className="space-y-3 pl-6 border-l-2 border-primary/20">
                          <div><p className="text-xs text-muted-foreground mb-2">General Sound</p><RadioGroup value={preferences.notificationSoundType} onValueChange={(v) => { updatePreference('notificationSoundType', v as any); playNotificationSound(v as any); }} className="grid grid-cols-3 gap-2">{(['ding', 'pop', 'chime'] as const).map((s) => (<Label key={s} htmlFor={`sound-${s}`} className={cn("flex items-center justify-center p-2 rounded-lg border cursor-pointer capitalize text-xs", preferences.notificationSoundType === s ? 'border-primary bg-primary/10 font-semibold' : 'border-border/50')}><RadioGroupItem value={s} id={`sound-${s}`} className="sr-only" />{s}</Label>))}</RadioGroup></div>
                          <div><p className="text-xs text-muted-foreground mb-2">💰 Opportunity Sound</p><RadioGroup value={preferences.opportunitySoundType} onValueChange={(v) => { updatePreference('opportunitySoundType', v as any); if (v === 'opportunity') import('@/lib/notificationSound').then(m => m.playOpportunitySound('opportunity')); else playNotificationSound(v as any); }} className="grid grid-cols-2 gap-2">{(['opportunity', 'ding', 'pop', 'chime'] as const).map((s) => (<Label key={s} htmlFor={`opp-sound-${s}`} className={cn("flex items-center justify-center p-2 rounded-lg border cursor-pointer capitalize text-xs", preferences.opportunitySoundType === s ? 'border-success bg-success/10 font-semibold' : 'border-border/50')}><RadioGroupItem value={s} id={`opp-sound-${s}`} className="sr-only" />{s === 'opportunity' ? '💰 Money' : s}</Label>))}</RadioGroup></div>
                        </div>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                  <Collapsible open={pushOpen} onOpenChange={setPushOpen} className="space-y-2">
                    <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/50 p-2.5 text-left">
                      <span className="flex items-center gap-2"><Bell className="h-4 w-4 text-primary" /><span className="font-medium text-sm">Push Notifications</span></span>
                      <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", pushOpen && "rotate-180")} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="space-y-2 pt-1">
                      <p className="text-[11px] text-muted-foreground">Get instant alerts on this device for deposits, withdrawals, payouts and rent updates — even when Welile is closed.</p>
                      <Suspense fallback={<Skeleton className="h-10 w-48 rounded-md" />}>
                        <PushNotificationButton className="w-full sm:w-auto gap-2" />
                      </Suspense>
                    </CollapsibleContent>
                  </Collapsible>
                  </CardContent>
                </Card>

                {user?.id && (roles.includes('tenant') || role === 'tenant') && (
                  <TenantNotificationPreferencesCard tenantId={user.id} />
                )}
              </div>
            )}

            {activeSection === 'accessibility' && (
              <div className="space-y-4">
                <Card className="border-border/40 rounded-2xl">
                  <CardContent className="pt-5 space-y-5">
                    <Collapsible open={textSizeOpen} onOpenChange={setTextSizeOpen} className="space-y-2">
                      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/50 p-2.5 text-left">
                        <span className="flex items-center gap-2"><Type className="h-4 w-4 text-primary" /><span className="font-medium text-sm">Text Size</span></span>
                        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", textSizeOpen && "rotate-180")} />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2 pt-1">
                        <p className="text-[11px] text-muted-foreground">Adjust the size of text throughout the app.</p>
                        <RadioGroup value={fontSize} onValueChange={(v) => setFontSize(v as any)} className="space-y-2">
                          {fontSizeOptions.map((opt) => (
                            <Label
                              key={opt.value}
                              htmlFor={opt.value}
                              className={cn(
                                "flex items-center justify-between gap-3 p-3 min-h-[48px] rounded-xl border cursor-pointer transition-colors hover:bg-muted/30",
                                fontSize === opt.value ? 'border-primary bg-primary/10' : 'border-border/50'
                              )}
                            >
                              <div>
                                <p className="font-medium text-sm">{opt.label}</p>
                                <p className="text-[11px] text-muted-foreground">{opt.description}</p>
                              </div>
                              <RadioGroupItem value={opt.value} id={opt.value} />
                            </Label>
                          ))}
                        </RadioGroup>
                      </CollapsibleContent>
                    </Collapsible>

                    <Collapsible open={vibrationOpen} onOpenChange={setVibrationOpen} className="space-y-2">
                      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/50 p-2.5 text-left">
                        <span className="flex items-center gap-2"><Vibrate className="h-4 w-4 text-primary" /><span className="font-medium text-sm">Vibration</span></span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground capitalize">{hapticIntensityOptions.find((o) => o.value === hapticIntensity)?.label ?? hapticIntensity}</span>
                          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", vibrationOpen && "rotate-180")} />
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2 pt-1">
                        <RadioGroup value={hapticIntensity} onValueChange={(v) => { setHapticIntensity(v as any); if (v !== 'off') setTimeout(() => hapticSelection(), 100); }} className="space-y-2">
                          {hapticIntensityOptions.map((opt) => (
                            <Label
                              key={opt.value}
                              htmlFor={`haptic-${opt.value}`}
                              className={cn(
                                "flex items-center justify-between gap-3 p-3 min-h-[48px] rounded-xl border cursor-pointer transition-colors hover:bg-muted/30",
                                hapticIntensity === opt.value ? 'border-primary bg-primary/10' : 'border-border/50'
                              )}
                            >
                              <div>
                                <p className="font-medium text-sm">{opt.label}</p>
                                <p className="text-[11px] text-muted-foreground">{opt.description}</p>
                              </div>
                              <RadioGroupItem value={opt.value} id={`haptic-${opt.value}`} />
                            </Label>
                          ))}
                        </RadioGroup>
                      </CollapsibleContent>
                    </Collapsible>

                    <Collapsible open={motionOpen} onOpenChange={setMotionOpen} className="space-y-2">
                      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/50 p-2.5 text-left">
                        <span className="flex items-center gap-2"><Wind className="h-4 w-4 text-primary" /><span className="font-medium text-sm">Motion</span></span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground capitalize">{reducedMotionOptions.find((o) => o.value === reducedMotion)?.label ?? reducedMotion}</span>
                          <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", motionOpen && "rotate-180")} />
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2 pt-1">
                        <RadioGroup value={reducedMotion} onValueChange={(v) => { setReducedMotion(v as any); toast.success(v === 'reduce' ? 'Animations reduced' : v === 'no-preference' ? 'Animations on' : 'Following system'); }} className="space-y-2">
                          {reducedMotionOptions.map((opt) => (
                            <Label
                              key={opt.value}
                              htmlFor={`motion-${opt.value}`}
                              className={cn(
                                "flex items-center justify-between gap-3 p-3 min-h-[48px] rounded-xl border cursor-pointer transition-colors hover:bg-muted/30",
                                reducedMotion === opt.value ? 'border-primary bg-primary/10' : 'border-border/50'
                              )}
                            >
                              <div>
                                <p className="font-medium text-sm">{opt.label}</p>
                                <p className="text-[11px] text-muted-foreground">{opt.description}</p>
                              </div>
                              <RadioGroupItem value={opt.value} id={`motion-${opt.value}`} />
                            </Label>
                          ))}
                        </RadioGroup>
                      </CollapsibleContent>
                    </Collapsible>

                    <SettingsRow label="Reduce Graphics" description="Fix screen tearing on older phones" icon={Zap}>
                      <Switch
                        checked={reduceGraphics}
                        onCheckedChange={(c) => {
                          setReduceGraphics(c);
                          const root = document.documentElement;
                          if (c) {
                            localStorage.setItem('welile-no-blur', '1');
                            root.classList.add('no-backdrop-blur');
                            root.classList.add('android-compositor-safe');
                            toast.success('Reduced graphics on');
                          } else {
                            // '0' is an explicit opt-out: it also overrides the
                            // automatic low-end/Android detection on next launch.
                            localStorage.setItem('welile-no-blur', '0');
                            root.classList.remove('no-backdrop-blur');
                            root.classList.remove('android-compositor-safe');
                            root.classList.remove('lite-mode');
                            toast.success('Full graphics restored');
                          }
                        }}
                      />
                    </SettingsRow>
                  </CardContent>
                </Card>
              </div>
            )}

            {activeSection === 'security' && (
              <div className="space-y-3">
                <Card className="border-border/40 rounded-2xl">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <LogIn className="h-4 w-4 text-primary" />
                      <div>
                        <CardTitle className="text-sm">Sign-in method</CardTitle>
                        <CardDescription className="text-xs">Pick how the login screen opens for you next time. Password always stays available as a backup.</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <RadioGroup
                      value={preferences.preferredLoginMethod}
                      onValueChange={(v) => { updatePreference('preferredLoginMethod', v as 'otp' | 'password'); toast.success(v === 'otp' ? 'SMS code is now your default' : 'Password is now your default'); }}
                      className="grid grid-cols-1 gap-2"
                    >
                      <Label
                        htmlFor="login-otp"
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-xl border cursor-pointer",
                          preferences.preferredLoginMethod === 'otp' ? 'border-primary bg-primary/10' : 'border-border/50'
                        )}
                      >
                        <RadioGroupItem value="otp" id="login-otp" />
                        <Smartphone className="h-4 w-4 text-primary shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-sm">SMS code first <span className="text-[10px] text-muted-foreground font-normal">(recommended)</span></p>
                          <p className="text-[11px] text-muted-foreground">Get a one-time code on your phone — no password needed</p>
                        </div>
                      </Label>
                      <Label
                        htmlFor="login-password"
                        className={cn(
                          "flex items-center gap-3 p-3 rounded-xl border cursor-pointer",
                          preferences.preferredLoginMethod === 'password' ? 'border-primary bg-primary/10' : 'border-border/50'
                        )}
                      >
                        <RadioGroupItem value="password" id="login-password" />
                        <Lock className="h-4 w-4 text-primary shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium text-sm">Password first</p>
                          <p className="text-[11px] text-muted-foreground">Open straight to phone &amp; password; SMS code stays one tap away</p>
                        </div>
                      </Label>
                    </RadioGroup>
                    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5">
                      <Clock className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-amber-700 dark:text-amber-400">You will be signed out when you close this browser</p>
                        <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70 mt-0.5">Next time you open Welile, you will need to enter a new SMS code to log in again.</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <LazySection name="PinSecurity"><PinSecuritySection /></LazySection>
                <LazySection name="BiometricSecurity"><BiometricSecuritySection /></LazySection>
                <Card className="border-border/40 rounded-2xl">
                  <CardHeader className="pb-2">
                    <div className="flex items-center gap-2">
                      <Bell className="h-4 w-4 text-primary" />
                      <div>
                        <CardTitle className="text-sm">Push notifications</CardTitle>
                        <CardDescription className="text-xs">Get instant alerts for deposits, withdrawals, payouts and rent updates — even when Welile is closed.</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Suspense fallback={<Skeleton className="h-10 w-48 rounded-md" />}>
                      <PushNotificationButton className="w-full sm:w-auto gap-2" />
                    </Suspense>
                  </CardContent>
                </Card>
                <LazySection name="TwoFactor"><TwoFactorSection /></LazySection>
                <LazySection name="DeviceSessions"><DeviceSessionsSection /></LazySection>
                <LazySection name="TrustPrivacy"><TrustPrivacySection /></LazySection>
              </div>
            )}

            {activeSection === 'legal' && hasLegalContent && deferredReady && (
              <LazySection name="Legal"><DeferredLegalSectionInner roles={roles} /></LazySection>
            )}
            {activeSection === 'legal' && (!hasLegalContent || !deferredReady) && <SectionSkeleton />}

            {activeSection === 'advanced' && (
              <div className="space-y-4">
                <LazySection name="Diagnostics"><DiagnosticsSection /></LazySection>
              </div>
            )}
          </SectionBoundary>
          </div>
        )}

        <div className="mt-8 text-center text-xs text-muted-foreground/50 pb-20"><p>Welile v1.11 • SW v11</p></div>
      </div>
    </div>
  );
}

const DeferredLegalSectionInner = lazy(() => import('@/components/settings/LegalSection'));

function SettingsRow({ label, description, icon: Icon, children }: { label: string; description: string; icon?: typeof User; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {Icon && <Icon className="h-4 w-4 text-primary shrink-0" />}
        <div className="min-w-0"><p className="font-medium text-sm">{label}</p><p className="text-xs text-muted-foreground truncate">{description}</p></div>
      </div>
      {children}
    </div>
  );
}

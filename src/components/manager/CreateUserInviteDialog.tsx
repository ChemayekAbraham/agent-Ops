import { useState, useEffect } from 'react';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, UserPlus, Share2, Copy, Check, Eye, EyeOff, Users, Briefcase, Heart, Sparkles, Shield } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useIsMobile } from '@/hooks/use-mobile';
import { ScrollArea } from '@/components/ui/scroll-area';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
interface CreateUserInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type UserRole = 'tenant' | 'agent' | 'supporter' | 'landlord' | 'manager';

const roleConfig: Record<UserRole, { label: string; icon: React.ElementType; description: string; color: string; bgColor: string }> = {
  tenant: {
    label: 'Tenant',
    icon: Users,
    description: 'Rent payer who can request rent assistance',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10 border-blue-500/30',
  },
  landlord: {
    label: 'Landlord',
    icon: Briefcase,
    description: 'Property owner who receives rent payments',
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10 border-emerald-500/30',
  },
  agent: {
    label: 'Agent',
    icon: Briefcase,
    description: 'Field agent who registers tenants & manages deposits',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10 border-amber-500/30',
  },
  supporter: {
    label: 'Supporter',
    icon: Heart,
    description: 'Investor who funds rent requests & earns returns',
    color: 'text-rose-500',
    bgColor: 'bg-rose-500/10 border-rose-500/30',
  },
  manager: {
    label: 'Manager',
    icon: Shield,
    description: 'Full admin access to manage all users & data',
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10 border-purple-500/30',
  },
};

export function CreateUserInviteDialog({ open, onOpenChange }: CreateUserInviteDialogProps) {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedRole, setSelectedRole] = useState<UserRole>('tenant');
  const [formData, setFormData] = useState({
    email: '',
    fullName: '',
    phone: '',
    password: '',
  });
  const [createdInvite, setCreatedInvite] = useState<{
    token: string;
    fullName: string;
    password: string;
    role: UserRole;
    autoActivated?: boolean;
  } | null>(null);
  // Name captured in parts; `formData.fullName` stays the single submitted string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const applyNameParts = (next: PersonNameParts) => {
    setNameParts(next);
    setFormData(prev => ({ ...prev, fullName: joinPersonName(next) }));
  };

  const generatePassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let password = '';
    for (let i = 0; i < 8; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormData(prev => ({ ...prev, password }));
  };

  // Auto-generate password when dialog opens
  useEffect(() => {
    if (open && !formData.password) {
      generatePassword();
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast({ title: 'Error', description: nameCheck.error || 'Enter first and last name', variant: 'destructive' });
      return;
    }
    setIsLoading(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Error', description: 'Not authenticated', variant: 'destructive' });
        return;
      }

      const response = await supabase.functions.invoke('create-supporter-invite', {
        body: { ...formData, role: selectedRole },
      });

      if (response.error || response.data?.error) {
        const errorMsg = await extractEdgeFunctionError(response, 'Failed to create invite. Please try again.');
        throw new Error(errorMsg);
      }

      const wasAutoActivated = response.data.autoActivated === true;

      setCreatedInvite({
        token: response.data.invite.activation_token,
        fullName: response.data.invite.full_name,
        password: formData.password,
        role: selectedRole,
        autoActivated: wasAutoActivated,
      });

      toast({
        title: wasAutoActivated 
          ? `✅ ${roleConfig[selectedRole].label} Account Created!`
          : `✅ ${roleConfig[selectedRole].label} Invite Created!`,
        description: wasAutoActivated
          ? 'User has been added to the system and can sign in immediately.'
          : 'Share the activation link with the user.',
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create invite',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const getShareLink = () => {
    if (!createdInvite) return '';
    const token = encodeURIComponent(createdInvite.token);
    const password = encodeURIComponent(createdInvite.password);
    return `${getPublicOrigin()}/activate-supporter?token=${token}&password=${password}`;
  };

  const getRoleEmoji = (role: UserRole) => {
    switch (role) {
      case 'tenant': return '🏠';
      case 'landlord': return '🏢';
      case 'agent': return '💼';
      case 'supporter': return '💰';
      case 'manager': return '👑';
    }
  };

  const getWhatsAppMessage = () => {
    if (!createdInvite) return '';
    const roleEmoji = getRoleEmoji(createdInvite.role);
    const roleLabel = roleConfig[createdInvite.role].label;
    
    return `${roleEmoji} Welcome to Welile, ${createdInvite.fullName}!

You've been invited to join as a ${roleLabel}!

🔐 Your password: ${createdInvite.password}

👉 Activate your account here:
${getShareLink()}

Just click the link and enter your password to get started!`;
  };

  const handleShareWhatsApp = () => {
    const message = encodeURIComponent(getWhatsAppMessage());
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(getShareLink());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: 'Link copied!' });
  };

  const handleClose = () => {
    setFormData({ email: '', fullName: '', phone: '', password: '' });
    setNameParts({ firstName: '', otherNames: '', lastName: '' });
    setCreatedInvite(null);
    setCopied(false);
    setSelectedRole('tenant');
    onOpenChange(false);
  };

  const RoleIcon = roleConfig[selectedRole].icon;

  const formContent = (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* Role Selection - Large touch targets */}
      <div className="space-y-3">
        <Label className="text-base font-medium">Select Role</Label>
        <div className="grid grid-cols-2 gap-3">
          {(Object.keys(roleConfig) as UserRole[]).map((role) => {
            const config = roleConfig[role];
            const Icon = config.icon;
            const isSelected = selectedRole === role;
            return (
              <button
                key={role}
                type="button"
                onClick={() => setSelectedRole(role)}
                className={`flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all active:scale-95 ${
                  isSelected 
                    ? `${config.bgColor} border-current` 
                    : 'bg-muted/30 border-transparent hover:bg-muted/50'
                }`}
              >
                <Icon className={`h-7 w-7 mb-2 ${isSelected ? config.color : 'text-muted-foreground'}`} />
                <span className={`text-sm font-medium ${isSelected ? config.color : 'text-foreground'}`}>
                  {config.label}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-sm text-muted-foreground text-center">{roleConfig[selectedRole].description}</p>
      </div>

      {/* Form fields with larger inputs */}
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm font-medium">Full Name</Label>
          <PersonNameFields
            idPrefix="manager-invite"
            value={nameParts}
            onChange={applyNameParts}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="email" className="text-sm font-medium">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="user@example.com"
            value={formData.email}
            onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
            required
            className="h-12 text-base"
            autoComplete="off"
            inputMode="email"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="phone" className="text-sm font-medium">Phone Number</Label>
          <Input
            id="phone"
            placeholder="0700000000"
            value={formData.phone}
            onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
            required
            className="h-12 text-base"
            autoComplete="off"
            inputMode="tel"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password" className="text-sm font-medium">Temporary Password</Label>
            <Button 
              type="button" 
              variant="ghost" 
              size="sm" 
              onClick={generatePassword}
              className="h-8 text-xs gap-1"
            >
              <Sparkles className="h-3 w-3" />
              New
            </Button>
          </div>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Password"
              value={formData.password}
              onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
              required
              minLength={6}
              className="h-12 text-base pr-12"
              autoComplete="off"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-10 w-10"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This password will be shared with the user
          </p>
        </div>
      </div>

      <Button type="submit" className="w-full h-12 text-base font-medium" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="h-5 w-5 mr-2 animate-spin" />
            Creating...
          </>
        ) : (
          <>
            <RoleIcon className={`h-5 w-5 mr-2 ${roleConfig[selectedRole].color}`} />
            Create {roleConfig[selectedRole].label}
          </>
        )}
      </Button>
    </form>
  );

  const successContent = createdInvite ? (
    <div className="space-y-5">
      <Card className="bg-muted/50">
        <CardContent className="pt-5 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{getRoleEmoji(createdInvite.role)}</span>
            <div>
              <p className="font-semibold text-lg">{createdInvite.fullName}</p>
              <p className="text-sm text-muted-foreground">{roleConfig[createdInvite.role].label}</p>
            </div>
          </div>

          {createdInvite.autoActivated && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 text-center">
              <p className="text-green-600 font-semibold text-sm">✅ Account Active — User can sign in now</p>
            </div>
          )}

          <div className="bg-background rounded-lg p-3">
            <p className="text-sm text-muted-foreground mb-1">Temporary Password</p>
            <p className="font-mono font-bold text-lg">{createdInvite.password}</p>
          </div>
        </CardContent>
      </Card>

      {!createdInvite.autoActivated && (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Activation Link</Label>
            <div className="flex gap-2">
              <Input value={getShareLink()} readOnly className="h-12 text-sm" />
              <Button variant="outline" size="icon" onClick={handleCopyLink} className="h-12 w-12 shrink-0">
                {copied ? <Check className="h-5 w-5 text-green-500" /> : <Copy className="h-5 w-5" />}
              </Button>
            </div>
          </div>

          <Button 
            onClick={handleShareWhatsApp} 
            className="w-full h-14 text-base font-medium bg-green-600 hover:bg-green-700"
          >
            <Share2 className="h-5 w-5 mr-2" />
            Share on WhatsApp
          </Button>
        </>
      )}

      <Button variant="outline" onClick={handleClose} className="w-full h-12 text-base">
        Create Another
      </Button>

      <Button variant="ghost" onClick={handleClose} className="w-full h-12 text-base">
        Close
      </Button>
    </div>
  ) : null;

  // Use Sheet for mobile, Dialog for desktop
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={handleClose}>
        <SheetContent 
          side="bottom" 
          className="h-[90vh] rounded-t-3xl flex flex-col pb-safe"
        >
          <SheetHeader className="pb-4 flex-shrink-0">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <UserPlus className="h-5 w-5 text-primary" />
              {createdInvite ? (createdInvite.autoActivated ? 'Account Created' : 'Share Activation Link') : 'Create User Account'}
            </SheetTitle>
            <SheetDescription>
              {createdInvite 
                ? (createdInvite.autoActivated ? 'User has been added to the system' : `Share this link with the ${roleConfig[createdInvite.role].label.toLowerCase()}`)
                : 'Create a new user account'}
            </SheetDescription>
          </SheetHeader>
          
          <div 
            className="flex-1 overflow-y-auto overscroll-contain -mx-6 px-6"
            style={{ 
              WebkitOverflowScrolling: 'touch',
              touchAction: 'pan-y'
            }}
          >
            <div className="pb-8">
              {!createdInvite ? formContent : successContent}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            {createdInvite ? (createdInvite.autoActivated ? 'Account Created' : 'Share Activation Link') : 'Create User Account'}
          </DialogTitle>
          <DialogDescription>
            {createdInvite 
              ? (createdInvite.autoActivated ? 'User has been added to the system and can sign in immediately' : `Share this link with the ${roleConfig[createdInvite.role].label.toLowerCase()} to activate their account`)
              : 'Create a new user account and share the activation link'}
          </DialogDescription>
        </DialogHeader>

        <div 
          className="flex-1 overflow-y-auto overscroll-contain -mx-6 px-6"
          style={{ 
            WebkitOverflowScrolling: 'touch'
          }}
        >
          <div className="pb-6">
            {!createdInvite ? formContent : successContent}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState, useEffect, useMemo } from 'react';
import { useCanEditAccess } from '@/hooks/useCanEditAccess';
import DashboardPermissionsTab from './DashboardPermissionsTab';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import PersonNameFields from '@/components/shared/PersonNameFields';
import { joinPersonName, splitPersonName, validatePersonNameParts, type PersonNameParts } from '@/lib/authValidation';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { 
  User, Mail, Phone, Star, Banknote, CheckCircle, XCircle, 
  Calendar, Wallet, TrendingUp, PiggyBank, Clock, Activity,
  ArrowUpRight, ArrowDownLeft, ShoppingCart, Home, CreditCard,
  Send, Download as DownloadIcon, MessageCircle, CalendarDays, X, Filter,
  Shield, Plus, Trash2, UserCog, Loader2, Pencil, AlertTriangle, ToggleLeft, ToggleRight, ChevronLeft,
  FileText, UsersRound, UserPlus, Link2, ShieldAlert, ShieldOff, KeyRound, Eye, EyeOff, ShieldCheck, Copy, RefreshCw
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, formatDistanceToNow, startOfDay, endOfDay, subDays, subWeeks, subMonths, isWithinInterval } from 'date-fns';
import WhatsAppPhoneLink from '@/components/WhatsAppPhoneLink';
// Chat feature removed
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import UserRentSection from './user-details/UserRentSection';
import UserInvestmentsSection from './user-details/UserInvestmentsSection';
import UserTermsSection from './user-details/UserTermsSection';
import UserReferralsSection from './user-details/UserReferralsSection';
import UserActivityTimeline from './user-details/UserActivityTimeline';
import UserEcosystemSection from './user-details/UserEcosystemSection';
import AddBalanceDialog from './AddBalanceDialog';
import FundEditHistory from './FundEditHistory';

type AppRole = 'tenant' | 'agent' | 'landlord' | 'supporter' | 'manager' | 'super_admin' | 'employee' | 'operations' | 'ceo' | 'coo' | 'cfo' | 'cto' | 'cmo' | 'crm' | 'hr' | 'access_admin' | 'rd';

const OPERATIONS_DEPARTMENTS = ['Agent', 'Tenant', 'Landlord', 'Partner'] as const;

const allRoles: { value: AppRole; label: string; description: string; color: string; emoji: string; category: 'standard' | 'internal' | 'executive' }[] = [
  { value: 'tenant', label: 'Tenant', description: 'Can request rent assistance', color: 'bg-primary/20 text-primary', emoji: '🏠', category: 'standard' },
  { value: 'agent', label: 'Agent', description: 'Manages deposits & collections', color: 'bg-warning/20 text-warning', emoji: '💼', category: 'standard' },
  { value: 'landlord', label: 'Landlord', description: 'Receives rent payments', color: 'bg-chart-5/20 text-chart-5', emoji: '🏢', category: 'standard' },
  { value: 'supporter', label: 'Supporter', description: 'Can invest & fund requests', color: 'bg-success/20 text-success', emoji: '💰', category: 'standard' },
  { value: 'manager', label: 'Manager', description: 'Full platform management', color: 'bg-destructive/20 text-destructive', emoji: '👑', category: 'internal' },
  { value: 'super_admin', label: 'Super Admin', description: 'Highest system access', color: 'bg-destructive/20 text-destructive', emoji: '🛡️', category: 'internal' },
  { value: 'employee', label: 'Employee', description: 'Internal staff member', color: 'bg-blue-500/20 text-blue-600', emoji: '🧑‍💼', category: 'internal' },
  { value: 'operations', label: 'Operations', description: 'Operational department access', color: 'bg-orange-500/20 text-orange-600', emoji: '⚙️', category: 'internal' },
  { value: 'ceo', label: 'CEO', description: 'Chief Executive Officer', color: 'bg-amber-500/20 text-amber-600', emoji: '🎯', category: 'executive' },
  { value: 'coo', label: 'COO', description: 'Chief Operating Officer', color: 'bg-teal-500/20 text-teal-600', emoji: '📊', category: 'executive' },
  { value: 'cfo', label: 'CFO', description: 'Chief Financial Officer', color: 'bg-emerald-500/20 text-emerald-600', emoji: '💵', category: 'executive' },
  { value: 'cto', label: 'CTO', description: 'Chief Technology Officer', color: 'bg-violet-500/20 text-violet-600', emoji: '🔧', category: 'executive' },
  { value: 'cmo', label: 'CMO', description: 'Chief Marketing Officer', color: 'bg-pink-500/20 text-pink-600', emoji: '📢', category: 'executive' },
  { value: 'crm', label: 'CRM', description: 'Customer Relationship Manager', color: 'bg-cyan-500/20 text-cyan-600', emoji: '🤝', category: 'executive' },
  { value: 'hr', label: 'HR', description: 'Human Resources Manager', color: 'bg-indigo-500/20 text-indigo-600', emoji: '👥', category: 'internal' },
  { value: 'rd', label: 'R&D', description: 'Research & development team — owns the R&D dashboard', color: 'bg-lime-500/20 text-lime-700', emoji: '🔬', category: 'internal' },
  { value: 'access_admin', label: 'Access Admin', description: 'Can assign staff roles and dashboard access', color: 'bg-destructive/20 text-destructive', emoji: '🛡️', category: 'internal' },
];

interface InvestmentAccount {
  id: string;
  name: string;
  balance: number;
  color: string;
  status: string;
  created_at: string;
}

interface ActivityItem {
  id: string;
  type: 'transaction_sent' | 'transaction_received' | 'deposit' | 'withdrawal' | 'order' | 'rent_request' | 'repayment' | 'loan_repayment';
  amount: number;
  description: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

interface SubAgent {
  id: string;
  sub_agent_id: string;
  created_at: string;
  profile?: {
    full_name: string;
    phone: string;
    avatar_url: string | null;
  };
  tenants_count: number;
}

interface UserDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: string;
    full_name: string;
    email: string;
    phone: string;
    avatar_url: string | null;
    rent_discount_active: boolean;
    monthly_rent: number | null;
    roles: string[];
    average_rating: number | null;
    rating_count: number;
    verified?: boolean;
  } | null;
  onRolesUpdated?: () => void;
  onUserDeleted?: () => void;
  onUserUpdated?: () => void;
  /** Whether the wallet balance can be manually credited/debited from this dialog. Defaults to true. */
  canAdjustBalance?: boolean;
}

export default function UserDetailsDialog({ open, onOpenChange, user, onRolesUpdated, onUserDeleted, onUserUpdated, canAdjustBalance = true }: UserDetailsDialogProps) {
  const isMobile = useIsMobile();
  const { user: actingUser } = useAuth();
  const { canEdit } = useCanEditAccess();
  const [investmentAccounts, setInvestmentAccounts] = useState<InvestmentAccount[]>([]);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [activityLog, setActivityLog] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [dateRange, setDateRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>('all');
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [roleEnabledStatus, setRoleEnabledStatus] = useState<Record<string, boolean>>({});
  const [addingRole, setAddingRole] = useState<AppRole | null>(null);
  const [removingRole, setRemovingRole] = useState<string | null>(null);
  const [togglingRole, setTogglingRole] = useState<string | null>(null);
  const [roleChangeReason, setRoleChangeReason] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  
  // Edit profile state
  const [editForm, setEditForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    monthly_rent: ''
  });
  const [savingProfile, setSavingProfile] = useState(false);
  // Name captured in parts; `editForm.full_name` stays the single saved string.
  const [nameParts, setNameParts] = useState<PersonNameParts>({ firstName: '', otherNames: '', lastName: '' });
  const applyNameParts = (next: PersonNameParts) => {
    setNameParts(next);
    setEditForm(prev => ({ ...prev, full_name: joinPersonName(next) }));
  };
  const [deletingUser, setDeletingUser] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [verificationStatus, setVerificationStatus] = useState<boolean>(false);
  const [approvingUser, setApprovingUser] = useState(false);
  const [rejectingUser, setRejectingUser] = useState(false);
  const [subAgents, setSubAgents] = useState<SubAgent[]>([]);
  const [subAgentsLoading, setSubAgentsLoading] = useState(false);
  const [addBalanceOpen, setAddBalanceOpen] = useState(false);
  const [referralCount, setReferralCount] = useState<number>(0);
  const [referrerInfo, setReferrerInfo] = useState<{ name: string; phone: string; id: string; method: string } | null>(null);
  const [referrerLoading, setReferrerLoading] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [freezingUser, setFreezingUser] = useState(false);
  const [freezeConfirmOpen, setFreezeConfirmOpen] = useState(false);
  const [operationsDepartments, setOperationsDepartments] = useState<string[]>([]);
  const [togglingDept, setTogglingDept] = useState<string | null>(null);
  const [isSellerStatus, setIsSellerStatus] = useState(false);
  const [togglingSellerStatus, setTogglingSellerStatus] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [resettingStaffPassword, setResettingStaffPassword] = useState(false);

  const fetchReferrerInfo = async (userId: string) => {
    setReferrerLoading(true);
    setReferrerInfo(null);
    try {
      // Get user's referrer_id from profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('referrer_id')
        .eq('id', userId)
        .single();

      if (profile?.referrer_id) {
        // Fetch referrer's profile
        const { data: referrer } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .eq('id', profile.referrer_id)
          .single();

        // Check if they came via supporter_invites (invite link) or referral link
        const { data: invite } = await supabase
          .from('supporter_invites')
          .select('id, role, created_by')
          .eq('activated_user_id', userId)
          .maybeSingle();

        const method = invite ? `Invite (${invite.role})` : 'Referral Link';

        if (referrer) {
          setReferrerInfo({
            name: referrer.full_name,
            phone: referrer.phone,
            id: referrer.id,
            method,
          });
        }
      } else {
        // Check if user came via invite without referrer_id
        const { data: invite } = await supabase
          .from('supporter_invites')
          .select('id, role, created_by')
          .eq('activated_user_id', userId)
          .maybeSingle();

        if (invite) {
          const { data: inviter } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .eq('id', invite.created_by)
            .single();

          if (inviter) {
            setReferrerInfo({
              name: inviter.full_name,
              phone: inviter.phone,
              id: inviter.id,
              method: `Invite (${invite.role})`,
            });
          }
        }
      }
    } catch (err) {
      console.error('Error fetching referrer:', err);
    } finally {
      setReferrerLoading(false);
    }
  };

  const fetchOperationsDepartments = async () => {
    if (!user) return;
    try {
      const { data } = await supabase
        .from('operations_departments')
        .select('department')
        .eq('user_id', user.id);
      // DB stores values as `<dept>_ops` (agent_ops, tenant_ops, landlord_ops, partner_ops).
      // Normalize to bare key (agent, tenant, landlord, partner) for UI matching.
      setOperationsDepartments(
        (data || []).map(d =>
          String(d.department || '').trim().toLowerCase().replace(/_ops$/, '')
        )
      );
    } catch (e) {
      console.error('Error fetching ops departments:', e);
    }
  };

  const handleToggleOperationsDept = async (dept: string) => {
    if (!user) return;
    setTogglingDept(dept);
    const key = dept.toLowerCase();
    // DB requires the `_ops` suffix per check constraint.
    const dbValue = `${key}_ops`;
    try {
      if (operationsDepartments.includes(key)) {
        const { error } = await supabase
          .from('operations_departments')
          .delete()
          .eq('user_id', user.id)
          .eq('department', dbValue);
        if (error) throw error;
        setOperationsDepartments(prev => prev.filter(d => d !== key));
        toast.success(`Removed ${dept} department`);
      } else {
        const { error } = await supabase
          .from('operations_departments')
          .insert({ user_id: user.id, department: dbValue });
        if (error) throw error;
        setOperationsDepartments(prev => [...prev, key]);
        toast.success(`Added ${dept} department`);
      }
    } catch (e) {
      console.error('Error toggling dept:', e);
      toast.error('Failed to update department');
    } finally {
      setTogglingDept(null);
    }
  };

  const fetchSellerStatus = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('profiles')
      .select('is_seller')
      .eq('id', user.id)
      .single();
    if (data) setIsSellerStatus(data.is_seller ?? false);
  };

  const handleToggleSellerStatus = async () => {
    if (!user) return;
    setTogglingSellerStatus(true);
    try {
      const newStatus = !isSellerStatus;
      const { error } = await supabase
        .from('profiles')
        .update({ 
          is_seller: newStatus,
          seller_application_status: newStatus ? 'approved' : null
        })
        .eq('id', user.id);
      if (error) throw error;

      // Notify the user
      await supabase.from('notifications').insert({
        user_id: user.id,
        title: newStatus ? '🎉 Selling Rights Granted!' : '🚫 Selling Rights Removed',
        message: newStatus 
          ? 'You can now sell products and services on Welile! Go to your menu to start listing items.'
          : 'Your selling rights have been removed. You can no longer list new products.',
        type: newStatus ? 'success' : 'warning',
      });

      setIsSellerStatus(newStatus);
      toast.success(newStatus 
        ? `${user.full_name} can now sell on Welile` 
        : `Selling rights removed from ${user.full_name}`
      );
      onUserUpdated?.();
    } catch (err) {
      console.error('Error toggling seller status:', err);
      toast.error('Failed to update seller status');
    } finally {
      setTogglingSellerStatus(false);
    }
  };

  useEffect(() => {
    if (open && user) {
      fetchUserDetails();
      fetchUserRolesWithStatus();
      fetchVerificationStatus();
      fetchFrozenStatus();
      fetchReferrerInfo(user.id);
      fetchOperationsDepartments();
      fetchSellerStatus();
      // Fetch subagents if user is an agent
      if (user.roles.includes('agent')) {
        fetchSubAgents();
      }
      setEditForm({
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        monthly_rent: user.monthly_rent?.toString() || ''
      });
      setNameParts(splitPersonName(user.full_name || ''));
      // Fetch referral count
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('referrer_id', user.id)
        .then(({ count }) => setReferralCount(count || 0));
    }
  }, [open, user]);

  const fetchVerificationStatus = async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('profiles')
      .select('verified')
      .eq('id', user.id)
      .single();
    
    if (!error && data) {
      setVerificationStatus(data.verified);
    }
  };

  const fetchFrozenStatus = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('profiles')
      .select('is_frozen')
      .eq('id', user.id)
      .single();
    if (data) setIsFrozen(data.is_frozen);
  };

  const handleToggleFreeze = async () => {
    if (!user) return;
    setFreezingUser(true);
    try {
      const newFrozen = !isFrozen;
      const { error } = await supabase
        .from('profiles')
        .update({
          is_frozen: newFrozen,
          frozen_reason: newFrozen ? 'Your account has been frozen for violating platform policies. Contact support on WhatsApp: +256777607640' : null,
          frozen_at: newFrozen ? new Date().toISOString() : null,
        })
        .eq('id', user.id);
      if (error) throw error;

      if (newFrozen) {
        await supabase.from('notifications').insert({
          user_id: user.id,
          title: '🚫 Account Frozen',
          message: 'Your account has been FROZEN for violating platform policies. All transactions are blocked. Contact support on WhatsApp: +256777607640',
          type: 'warning',
          metadata: { severity: 'critical', support_action_required: true },
        });

        // Notify the user by SMS with the same frozen message (best-effort).
        try {
          await supabase.functions.invoke('notify-account-frozen', {
            body: {
              user_id: user.id,
              message:
                'Your account has been FROZEN for violating platform policies. All transactions are blocked. Contact support on WhatsApp: +256777607640',
            },
          });
        } catch (smsErr) {
          console.error('Freeze SMS failed', smsErr);
        }
      }

      setIsFrozen(newFrozen);
      setFreezeConfirmOpen(false);
      toast.success(newFrozen ? `${user.full_name}'s account has been frozen` : `${user.full_name}'s account has been unfrozen`);
      onUserUpdated?.();
    } catch (err) {
      console.error('Error toggling freeze:', err);
      toast.error('Failed to update account status');
    } finally {
      setFreezingUser(false);
    }
  };

  const fetchSubAgents = async () => {
    if (!user) return;
    setSubAgentsLoading(true);
    
    try {
      // Fetch subagents for this agent
      const { data: subAgentsData, error } = await supabase
        .from('agent_subagents')
        .select('*')
        .eq('parent_agent_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;

      if (!subAgentsData || subAgentsData.length === 0) {
        setSubAgents([]);
        setSubAgentsLoading(false);
        return;
      }

      // Fetch profiles for subagents
      const subAgentIds = subAgentsData.map(sa => sa.sub_agent_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone, avatar_url')
        .in('id', subAgentIds);

      // Count tenants per subagent
      const tenantsCountBySubAgent: Record<string, number> = {};
      for (const subAgentId of subAgentIds) {
        const { count } = await supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .eq('agent_id', subAgentId);
        
        tenantsCountBySubAgent[subAgentId] = count || 0;
      }

      // Combine data
      const enrichedSubAgents: SubAgent[] = subAgentsData.map(sa => ({
        ...sa,
        profile: profiles?.find(p => p.id === sa.sub_agent_id),
        tenants_count: tenantsCountBySubAgent[sa.sub_agent_id] || 0,
      }));

      setSubAgents(enrichedSubAgents);
    } catch (error) {
      console.error('Error fetching subagents:', error);
    } finally {
      setSubAgentsLoading(false);
    }
  };

  const handleApproveUser = async () => {
    if (!user) return;
    setApprovingUser(true);
    
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ verified: true })
        .eq('id', user.id);
      
      if (error) throw error;
      
      setVerificationStatus(true);
      toast.success(`${user.full_name} has been approved and verified`);
      onUserUpdated?.();
    } catch (error) {
      console.error('Error approving user:', error);
      toast.error('Failed to approve user');
    } finally {
      setApprovingUser(false);
    }
  };

  const handleRejectUser = async () => {
    if (!user) return;
    setRejectingUser(true);
    
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ verified: false })
        .eq('id', user.id);
      
      if (error) throw error;
      
      setVerificationStatus(false);
      toast.success(`${user.full_name} verification has been revoked`);
      onUserUpdated?.();
    } catch (error) {
      console.error('Error rejecting user:', error);
      toast.error('Failed to reject user');
    } finally {
      setRejectingUser(false);
    }
  };

  const fetchUserRolesWithStatus = async () => {
    if (!user) return;
    
    const { data, error } = await supabase
      .from('user_roles')
      .select('role, enabled')
      .eq('user_id', user.id);
    
    if (!error && data) {
      const roles = data.map(r => r.role);
      const enabledMap: Record<string, boolean> = {};
      data.forEach(r => {
        enabledMap[r.role] = r.enabled;
      });
      setUserRoles(roles);
      setRoleEnabledStatus(enabledMap);
    }
  };

  const logRoleAudit = async (role: AppRole, enabled: boolean) => {
    if (!user) return;
    try {
      const trimmed = roleChangeReason.trim();
      await supabase.from('audit_logs').insert({
        user_id: actingUser?.id ?? null,
        table_name: 'user_roles',
        record_id: user.id,
        action_type: enabled ? 'staff_role_enabled' : 'staff_role_disabled',
        metadata: {
          target_user_id: user.id,
          role,
          enabled,
          reason: trimmed || null,
          surface: '/platform-users',
        },
      } as any);
    } catch (auditError) {
      console.error('Role audit log failed (role change still applied):', auditError);
    }
  };

  const handleAddRole = async (role: AppRole) => {
    if (!user) return;
    setAddingRole(role);
    
    try {
      const { error } = await supabase
        .from('user_roles')
        .insert({ user_id: user.id, role });
      
      if (error) {
        if (error.code === '23505') {
          toast.error('User already has this role');
        } else {
          throw error;
        }
      } else {
        setUserRoles(prev => [...prev, role]);
        setRoleEnabledStatus(prev => ({ ...prev, [role]: true }));
        await logRoleAudit(role, true);
        toast.success(`Added "${role}" role to ${user.full_name}`);
        setRoleChangeReason('');
        onRolesUpdated?.();
      }
    } catch (error: any) {
      console.error('Error adding role:', error);
      toast.error(error?.message || 'The database refused the change.');
    } finally {
      setAddingRole(null);
    }
  };

  const handleRemoveRole = async (role: AppRole) => {
    if (!user) return;
    
    const activeRolesCount = userRoles.filter(r => roleEnabledStatus[r] !== false).length;
    if (activeRolesCount <= 1) {
      toast.error('User must have at least one role');
      return;
    }
    
    setRemovingRole(role);
    
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({ enabled: false })
        .eq('user_id', user.id)
        .eq('role', role);
      
      if (error) throw error;
      
      setRoleEnabledStatus(prev => ({ ...prev, [role]: false }));
      await logRoleAudit(role, false);
      toast.success(`Removed "${role}" role from ${user.full_name}`);
      setRoleChangeReason('');
      onRolesUpdated?.();
    } catch (error: any) {
      console.error('Error removing role:', error);
      toast.error(error?.message || 'The database refused the change.');
    } finally {
      setRemovingRole(null);
    }
  };

  const handleToggleRoleEnabled = async (role: AppRole) => {
    if (!user) return;
    
    const currentEnabled = roleEnabledStatus[role] ?? true;
    const newEnabled = !currentEnabled;
    
    // Check if this would disable all enabled roles
    const enabledRolesCount = Object.entries(roleEnabledStatus).filter(([r, enabled]) => enabled && r !== role).length;
    if (!newEnabled && enabledRolesCount === 0) {
      toast.error('User must have at least one enabled dashboard');
      return;
    }
    
    setTogglingRole(role);
    
    try {
      const { error } = await supabase
        .from('user_roles')
        .update({ enabled: newEnabled })
        .eq('user_id', user.id)
        .eq('role', role);
      
      if (error) throw error;
      
      setRoleEnabledStatus(prev => ({ ...prev, [role]: newEnabled }));
      await logRoleAudit(role, newEnabled);
      toast.success(newEnabled 
        ? `Enabled "${role}" dashboard for ${user.full_name}` 
        : `Disabled "${role}" dashboard for ${user.full_name}`
      );
      setRoleChangeReason('');
      onRolesUpdated?.();
    } catch (error: any) {
      console.error('Error toggling role:', error);
      toast.error(error?.message || 'The database refused the change.');
    } finally {
      setTogglingRole(null);
    }
  };

  const availableRolesToAdd = allRoles.filter(r => !userRoles.includes(r.value));

  const handleSaveProfile = async () => {
    if (!user) return;
    const nameCheck = validatePersonNameParts(nameParts);
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Enter first and last name');
      return;
    }
    setSavingProfile(true);
    
    try {
      const emailChanged = (editForm.email || '') !== (user.email || '');
      const phoneChanged = (editForm.phone || '') !== (user.phone || '');

      // 1. Non-identity profile fields go straight to profiles
      const { error: profErr } = await supabase
        .from('profiles')
        .update({
          full_name: editForm.full_name,
          monthly_rent: editForm.monthly_rent ? parseFloat(editForm.monthly_rent) : null,
        })
        .eq('id', user.id);
      if (profErr) throw profErr;

      // 2. Identity fields (email, phone) MUST go through auth.admin so the
      //    user can still log in with the new value. Profile mirror happens
      //    inside the edge function.
      if (emailChanged || phoneChanged) {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error('You must be logged in');
        const resp = await supabase.functions.invoke('admin-update-user-identity', {
          body: {
            user_id: user.id,
            ...(emailChanged ? { email: editForm.email } : {}),
            ...(phoneChanged ? { phone: editForm.phone } : {}),
          },
        });
        if (resp.error) {
          const msg = await extractFromErrorObject(resp.error, 'Failed to update login identity');
          throw new Error(msg);
        }
        toast.success('Profile + login credentials updated');
      } else {
        toast.success('Profile updated successfully');
      }
      onUserUpdated?.();
    } catch (error: any) {
      console.error('Error updating profile:', error);
      toast.error('Failed to update profile: ' + (error?.message || error?.code || 'Unknown error'));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleResetPassword = async () => {
    if (!user) return;
    if (!newPassword || newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (newPassword.length > 128) {
      toast.error('Password must be less than 128 characters');
      return;
    }
    setResettingPassword(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        toast.error('You must be logged in to reset passwords');
        return;
      }
      const response = await supabase.functions.invoke('admin-reset-password', {
        body: { user_id: user.id, new_password: newPassword },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (response.error) {
        const msg = await extractFromErrorObject(response.error, 'Failed to reset password');
        throw new Error(msg);
      }
      if (response.data?.error) {
        const errMsg = response.data.error;
        if (errMsg.toLowerCase().includes('weak') || errMsg.toLowerCase().includes('easy to guess')) {
          throw new Error('This password has been found in a data breach and is not allowed. Please choose a stronger, unique password.');
        }
        throw new Error(errMsg);
      }
      toast.success(`Password reset successfully for ${user.full_name}`);
      setNewPassword('');
      setShowPassword(false);
    } catch (error: any) {
      console.error('Error resetting password:', error);
      const msg = error.message || 'Failed to reset password';
      if (msg.toLowerCase().includes('weak') || msg.toLowerCase().includes('easy to guess') || msg.toLowerCase().includes('pwned')) {
        toast.error('This password has been found in a data breach and is not allowed. Please choose a stronger, unique password.');
      } else {
        toast.error(msg);
      }
    } finally {
      setResettingPassword(false);
    }
  };

  const handleResetStaffPassword = async () => {
    if (!user) return;
    setResettingStaffPassword(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) {
        toast.error('You must be logged in');
        return;
      }
      const { error } = await supabase.rpc('reset_staff_access_password', {
        p_user_id: user.id,
        p_reset_by: session.user.id,
      });
      if (error) throw error;
      toast.success(`Manager login password reset to default for ${user.full_name}`);
    } catch (error: any) {
      console.error('Error resetting staff password:', error);
      toast.error(error.message || 'Failed to reset manager login password');
    } finally {
      setResettingStaffPassword(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!user) return;
    setDeletingUser(true);
    
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      
      const reason = window.prompt(`Reason for permanently deleting this user (min 10 characters, recorded in audit log):`)?.trim() || '';
      if (reason.length < 10) { toast.error('A reason of at least 10 characters is required'); return; }
      const response = await supabase.functions.invoke('delete-user', {
        body: { user_id: user.id, reason },
      });
      
      if (response.error) throw new Error(response.error.message || 'Failed to delete user');
      if (response.data?.error) throw new Error(response.data.error);
      
      toast.success(`User "${user.full_name}" has been permanently deleted from the system`);
      setDeleteConfirmOpen(false);
      onOpenChange(false);
      onUserDeleted?.();
    } catch (error: any) {
      console.error('Error deleting user:', error);
      toast.error(error.message || 'Failed to delete user');
    } finally {
      setDeletingUser(false);
    }
  };
  const fetchUserDetails = async () => {
    if (!user) return;
    setLoading(true);

    // investment_accounts table removed
    const accounts: any[] = [];

    // Fetch wallet balance
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();

    setInvestmentAccounts(accounts || []);
    setWalletBalance(wallet?.balance || 0);
    setLoading(false);

    // Fetch activity log in parallel
    fetchActivityLog();
  };

  const fetchActivityLog = async () => {
    if (!user) return;
    setActivityLoading(true);

    const activities: ActivityItem[] = [];

    // Fetch sent transactions
    const { data: sentTransactions } = await supabase
      .from('wallet_transactions')
      .select('id, amount, description, created_at')
      .eq('sender_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    sentTransactions?.forEach(t => {
      activities.push({
        id: `sent-${t.id}`,
        type: 'transaction_sent',
        amount: t.amount,
        description: t.description || 'Money sent',
        created_at: t.created_at
      });
    });

    // Fetch received transactions
    const { data: receivedTransactions } = await supabase
      .from('wallet_transactions')
      .select('id, amount, description, created_at')
      .eq('recipient_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    receivedTransactions?.forEach(t => {
      activities.push({
        id: `received-${t.id}`,
        type: 'transaction_received',
        amount: t.amount,
        description: t.description || 'Money received',
        created_at: t.created_at
      });
    });

    // Fetch deposits
    const { data: deposits } = await supabase
      .from('wallet_deposits')
      .select('id, amount, created_at, deposit_type')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    deposits?.forEach(d => {
      activities.push({
        id: `deposit-${d.id}`,
        type: 'deposit',
        amount: d.amount,
        description: `${d.deposit_type === 'cash' ? 'Cash' : 'Mobile'} deposit`,
        created_at: d.created_at
      });
    });

    // wallet_withdrawals table removed - skip

    // Fetch product orders
    const { data: orders } = await supabase
      .from('product_orders')
      .select('id, total_price, created_at, status')
      .eq('buyer_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    orders?.forEach(o => {
      activities.push({
        id: `order-${o.id}`,
        type: 'order',
        amount: o.total_price,
        description: `Product order (${o.status})`,
        created_at: o.created_at
      });
    });

    // Fetch rent requests
    const { data: rentRequests } = await supabase
      .from('rent_requests')
      .select('id, rent_amount, created_at, status')
      .eq('tenant_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    rentRequests?.forEach(r => {
      activities.push({
        id: `rent-${r.id}`,
        type: 'rent_request',
        amount: r.rent_amount,
        description: `Rent request (${r.status})`,
        created_at: r.created_at
      });
    });

    // repayments table removed - skip

    // Fetch loan repayments
    const { data: loanRepayments } = await supabase
      .from('user_loan_repayments')
      .select('id, amount, created_at')
      .eq('borrower_id', user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    loanRepayments?.forEach(l => {
      activities.push({
        id: `loan-repayment-${l.id}`,
        type: 'loan_repayment',
        amount: l.amount,
        description: 'Loan repayment',
        created_at: l.created_at
      });
    });

    // Sort all activities by date
    activities.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    setActivityLog(activities.slice(0, 30)); // Keep last 30 activities
    setActivityLoading(false);
  };

  const getActivityIcon = (type: ActivityItem['type']) => {
    switch (type) {
      case 'transaction_sent':
        return <ArrowUpRight className="h-4 w-4 text-destructive" />;
      case 'transaction_received':
        return <ArrowDownLeft className="h-4 w-4 text-success" />;
      case 'deposit':
        return <DownloadIcon className="h-4 w-4 text-success" />;
      case 'withdrawal':
        return <Send className="h-4 w-4 text-warning" />;
      case 'order':
        return <ShoppingCart className="h-4 w-4 text-primary" />;
      case 'rent_request':
        return <Home className="h-4 w-4 text-chart-5" />;
      case 'repayment':
      case 'loan_repayment':
        return <CreditCard className="h-4 w-4 text-success" />;
      default:
        return <Activity className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getActivityColor = (type: ActivityItem['type']) => {
    switch (type) {
      case 'transaction_sent':
      case 'withdrawal':
        return 'text-destructive';
      case 'transaction_received':
      case 'deposit':
      case 'repayment':
      case 'loan_repayment':
        return 'text-success';
      case 'order':
        return 'text-primary';
      case 'rent_request':
        return 'text-chart-5';
      default:
        return 'text-foreground';
    }
  };

  // Activity type options for filtering
  const activityTypeOptions = [
    { value: 'all', label: 'All Types' },
    { value: 'transaction_sent', label: 'Sent' },
    { value: 'transaction_received', label: 'Received' },
    { value: 'deposit', label: 'Deposits' },
    { value: 'withdrawal', label: 'Withdrawals' },
    { value: 'order', label: 'Orders' },
    { value: 'rent_request', label: 'Rent Requests' },
    { value: 'repayment', label: 'Repayments' },
    { value: 'loan_repayment', label: 'Loan Repayments' },
  ];

  // Filter activities by date range and type
  const filteredActivityLog = useMemo(() => {
    let filtered = activityLog;
    
    // Filter by activity type
    if (activityTypeFilter !== 'all') {
      filtered = filtered.filter(activity => activity.type === activityTypeFilter);
    }
    
    // Filter by date range
    if (dateRange.from || dateRange.to) {
      filtered = filtered.filter(activity => {
        const activityDate = new Date(activity.created_at);
        
        if (dateRange.from && dateRange.to) {
          return isWithinInterval(activityDate, {
            start: startOfDay(dateRange.from),
            end: endOfDay(dateRange.to)
          });
        }
        
        if (dateRange.from) {
          return activityDate >= startOfDay(dateRange.from);
        }
        
        if (dateRange.to) {
          return activityDate <= endOfDay(dateRange.to);
        }
        
        return true;
      });
    }
    
    return filtered;
  }, [activityLog, dateRange, activityTypeFilter]);

  // Calculate activity summary statistics
  const activitySummary = useMemo(() => {
    const summary = {
      totalDeposits: 0,
      totalWithdrawals: 0,
      totalSent: 0,
      totalReceived: 0,
      totalOrders: 0,
      totalRepayments: 0,
      depositCount: 0,
      withdrawalCount: 0,
      sentCount: 0,
      receivedCount: 0,
      orderCount: 0,
      repaymentCount: 0,
      moneyIn: 0,
      moneyOut: 0,
      netBalance: 0,
    };

    activityLog.forEach(activity => {
      switch (activity.type) {
        case 'deposit':
          summary.totalDeposits += activity.amount;
          summary.depositCount++;
          summary.moneyIn += activity.amount;
          break;
        case 'withdrawal':
          summary.totalWithdrawals += activity.amount;
          summary.withdrawalCount++;
          summary.moneyOut += activity.amount;
          break;
        case 'transaction_sent':
          summary.totalSent += activity.amount;
          summary.sentCount++;
          summary.moneyOut += activity.amount;
          break;
        case 'transaction_received':
          summary.totalReceived += activity.amount;
          summary.receivedCount++;
          summary.moneyIn += activity.amount;
          break;
        case 'order':
          summary.totalOrders += activity.amount;
          summary.orderCount++;
          summary.moneyOut += activity.amount;
          break;
        case 'repayment':
        case 'loan_repayment':
          summary.totalRepayments += activity.amount;
          summary.repaymentCount++;
          summary.moneyOut += activity.amount;
          break;
      }
    });

    summary.netBalance = summary.moneyIn - summary.moneyOut;

    return summary;
  }, [activityLog]);

  const setQuickDateRange = (days: number) => {
    const to = new Date();
    const from = days === 7 ? subWeeks(to, 1) : days === 30 ? subMonths(to, 1) : subDays(to, days);
    setDateRange({ from, to });
  };

  const clearAllFilters = () => {
    setDateRange({ from: undefined, to: undefined });
    setActivityTypeFilter('all');
  };

  const clearDateRange = () => {
    setDateRange({ from: undefined, to: undefined });
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const getRoleBadgeColor = (role: string) => {
    const colors: Record<string, string> = {
      tenant: 'bg-primary/20 text-primary',
      agent: 'bg-warning/20 text-warning',
      supporter: 'bg-success/20 text-success',
      landlord: 'bg-chart-5/20 text-chart-5',
      manager: 'bg-destructive/20 text-destructive'
    };
    return colors[role] || 'bg-muted text-muted-foreground';
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'approved':
        return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>;
      case 'rejected':
        return <Badge className="bg-destructive/20 text-destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge className="bg-warning/20 text-warning"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
  };

  const renderStars = (rating: number) => {
    return (
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star
            key={star}
            className={`h-4 w-4 ${
              star <= rating
                ? 'fill-yellow-400 text-yellow-400'
                : 'text-muted-foreground/30'
            }`}
          />
        ))}
      </div>
    );
  };

  const totalInvested = investmentAccounts
    .filter(a => a.status === 'approved')
    .reduce((sum, a) => sum + a.balance, 0);

  if (!user) return null;

  // Shared verification banner - always visible at top
  const VerificationBanner = () => (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl ${
      verificationStatus 
        ? 'bg-success/10 border border-success/30' 
        : 'bg-destructive/10 border border-destructive/30'
    }`}>
      <div className="flex items-center gap-2 min-w-0">
        {verificationStatus ? (
          <CheckCircle className="h-5 w-5 text-success shrink-0" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
        )}
        <span className={`text-sm font-semibold truncate ${verificationStatus ? 'text-success' : 'text-destructive'}`}>
          {verificationStatus ? 'Verified' : 'Unverified'}
        </span>
      </div>
      {verificationStatus ? (
        <Button
          variant="destructive"
          size="sm"
          onClick={handleRejectUser}
          disabled={rejectingUser}
          className="shrink-0 min-h-[40px] min-w-[100px] font-bold"
        >
          {rejectingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4 mr-1" />}
          Revoke
        </Button>
      ) : (
        <Button
          variant="success"
          size="sm"
          onClick={handleApproveUser}
          disabled={approvingUser}
          className="shrink-0 min-h-[40px] min-w-[120px] font-bold text-base"
        >
          {approvingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-1" />}
          Verify Now
        </Button>
      )}
    </div>
  );

  // Seller Status Banner
  const SellerBanner = () => (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl ${
      isSellerStatus 
        ? 'bg-chart-4/10 border border-chart-4/30' 
        : 'bg-muted border border-border'
    }`}>
      <div className="flex items-center gap-2 min-w-0">
        <ShoppingCart className="h-5 w-5 shrink-0" style={{ color: isSellerStatus ? 'hsl(var(--chart-4))' : 'hsl(var(--muted-foreground))' }} />
        <span className={`text-sm font-semibold truncate ${isSellerStatus ? 'text-chart-4' : 'text-muted-foreground'}`}>
          {isSellerStatus ? '🛒 Verified Seller' : 'Not a Seller'}
        </span>
      </div>
      <Button
        variant={isSellerStatus ? 'destructive' : 'default'}
        size="sm"
        onClick={handleToggleSellerStatus}
        disabled={togglingSellerStatus}
        className="shrink-0 min-h-[40px] min-w-[100px] font-bold"
      >
        {togglingSellerStatus ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : isSellerStatus ? (
          <>
            <ShieldOff className="h-4 w-4 mr-1" />
            Revoke
          </>
        ) : (
          <>
            <ShoppingCart className="h-4 w-4 mr-1" />
            Grant Seller
          </>
        )}
      </Button>
    </div>
  );


  const UserHeader = () => (
    <div className="flex items-center gap-3">
      <Avatar className={`${isMobile ? 'h-14 w-14' : 'h-12 w-12'}`}>
        <AvatarImage src={user.avatar_url || undefined} />
        <AvatarFallback className="text-lg">{getInitials(user.full_name)}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <p className={`${isMobile ? 'text-xl' : 'text-lg'} font-semibold truncate`}>{user.full_name}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {user.roles.map((role) => (
            <Badge key={role} className={`text-xs ${getRoleBadgeColor(role)}`}>
              {role}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );

  // Shared tabs component - now with 8 tabs using horizontal scroll on mobile
  const TabsNavigation = () => (
    <div className={isMobile ? 'overflow-x-auto -mx-4 px-4 pb-2' : ''}>
      <TabsList className={`${isMobile ? 'inline-flex w-auto min-w-full gap-1 h-12' : 'grid w-full grid-cols-9'}`}>
        <TabsTrigger value="overview" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <User className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Overview</span>
        </TabsTrigger>
        <TabsTrigger value="rent" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <Home className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Rent</span>
        </TabsTrigger>
        <TabsTrigger value="invest" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <PiggyBank className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Invest</span>
        </TabsTrigger>
        <TabsTrigger value="referrals" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <div className="relative">
            <UserPlus className="h-4 w-4" />
            {referralCount > 0 && (
              <span className="absolute -top-2 -right-2 bg-primary text-primary-foreground text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5 leading-none">
                {referralCount > 99 ? '99+' : referralCount}
              </span>
            )}
          </div>
          <span className={isMobile ? '' : 'hidden sm:inline'}>Referrals</span>
        </TabsTrigger>
        <TabsTrigger value="terms" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <FileText className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Terms</span>
        </TabsTrigger>
        <TabsTrigger value="activity" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <Activity className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Activity</span>
        </TabsTrigger>
        <TabsTrigger value="roles" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <Shield className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Roles</span>
        </TabsTrigger>
        <TabsTrigger value="permissions" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <ShieldCheck className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Perms</span>
        </TabsTrigger>
        <TabsTrigger value="edit" className={`gap-1.5 ${isMobile ? 'flex-col h-full py-1.5 text-[10px] px-3 shrink-0' : 'gap-2'}`}>
          <Pencil className="h-4 w-4" />
          <span className={isMobile ? '' : 'hidden sm:inline'}>Edit</span>
        </TabsTrigger>
      </TabsList>
    </div>
  );

  // Mobile version uses Sheet for full-screen experience
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[95vh] rounded-t-3xl p-0 flex flex-col overflow-hidden">
          {/* Fixed Header */}
          <SheetHeader className="p-4 pb-0 shrink-0">
            <div className="flex items-center gap-3 mb-3">
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={() => onOpenChange(false)}
                className="h-10 w-10 rounded-full"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <SheetTitle className="flex-1">
                <UserHeader />
              </SheetTitle>
            </div>
          </SheetHeader>

          {/* Sticky Verification & Seller Banners */}
          <div className="px-4 pt-2 shrink-0 space-y-2">
            <VerificationBanner />
            <SellerBanner />
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-4 pt-2 shrink-0">
              <TabsNavigation />
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto overscroll-contain touch-pan-y pb-safe" style={{ WebkitOverflowScrolling: 'touch' }}>
              <TabsContent value="overview" className="mt-0">
                <div className="p-4 space-y-5">
                  {/* Contact Info */}
                  <Card>
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <User className="h-4 w-4 text-primary" />
                        Contact Information
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-4 pt-0">
                      <div className="flex items-center gap-3">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <a href={`mailto:${user.email}`} className="text-sm text-primary hover:underline truncate">
                          {user.email}
                        </a>
                      </div>
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <WhatsAppPhoneLink phone={user.phone} />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Referred By */}
                  <Card className="border-primary/20">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-primary" />
                        Referred By
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {referrerLoading ? (
                        <Skeleton className="h-12 w-full" />
                      ) : referrerInfo ? (
                        <div className="flex items-center gap-3">
                          <Avatar className="h-10 w-10 border">
                            <AvatarFallback className="bg-primary/10 text-primary text-sm font-bold">
                              {referrerInfo.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm truncate">{referrerInfo.name}</p>
                            <p className="text-xs text-muted-foreground">{referrerInfo.phone}</p>
                          </div>
                          <Badge variant="outline" className="shrink-0 text-xs">
                            {referrerInfo.method}
                          </Badge>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">No referrer — signed up directly</p>
                      )}
                  </CardContent>
                  </Card>

                  {/* Tenant Ecosystem */}
                  <UserEcosystemSection userId={user.id} />

                  <div className="grid grid-cols-2 gap-3">
                    <Card
                      className={`p-3 relative group transition-colors ${canAdjustBalance ? 'cursor-pointer hover:border-primary/50' : ''}`}
                      onClick={canAdjustBalance ? () => setAddBalanceOpen(true) : undefined}
                    >
                      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                        <Wallet className="h-3 w-3" />
                        Wallet Balance
                      </div>
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-sm">{formatUGX(walletBalance)}</p>
                        {canAdjustBalance && (
                          <Plus className="h-4 w-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                        )}
                      </div>
                    </Card>
                    <Card className="p-3">
                      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                        <PiggyBank className="h-3 w-3" />
                        Invested
                      </div>
                      <p className="font-semibold text-sm">{formatUGX(totalInvested)}</p>
                    </Card>
                    <Card className="p-3">
                      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                        <Banknote className="h-3 w-3" />
                        Monthly Rent
                      </div>
                      <p className="font-semibold text-sm">{user.monthly_rent ? formatUGX(user.monthly_rent) : 'N/A'}</p>
                    </Card>
                    <Card className="p-3">
                      <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                        <Star className="h-3 w-3" />
                        Rating
                      </div>
                      {user.rating_count > 0 ? (
                        <div className="flex items-center gap-1">
                          {renderStars(user.average_rating || 0)}
                          <span className="text-xs text-muted-foreground">({user.rating_count})</span>
                        </div>
                      ) : (
                        <p className="font-semibold text-sm text-muted-foreground">No ratings</p>
                      )}
                    </Card>
                  </div>

                  {/* Verification Status */}
                  <Card className={`border-2 ${verificationStatus ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'}`}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {verificationStatus ? (
                            <>
                              <div className="p-2 rounded-full bg-success/20 shrink-0">
                                <CheckCircle className="h-5 w-5 text-success" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-success">Verified</p>
                                <p className="text-xs text-muted-foreground truncate">User is approved</p>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="p-2 rounded-full bg-warning/20 shrink-0">
                                <XCircle className="h-5 w-5 text-warning" />
                              </div>
                              <div className="min-w-0">
                                <p className="font-semibold text-warning">Pending</p>
                                <p className="text-xs text-muted-foreground truncate">Needs verification</p>
                              </div>
                            </>
                          )}
                        </div>
                        {!verificationStatus ? (
                          <Button
                            size="sm"
                            variant="default"
                            onClick={handleApproveUser}
                            disabled={approvingUser}
                            className="gap-1 h-10 shrink-0"
                          >
                            {approvingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                            Approve
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={handleRejectUser}
                            disabled={rejectingUser}
                            className="gap-1 h-10 shrink-0"
                          >
                            {rejectingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                            Revoke
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Status Badges */}
                  {user.rent_discount_active && (
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Rent Discount Active
                    </Badge>
                  )}

                  {/* Investment Accounts */}
                  <div>
                    <h3 className="font-semibold flex items-center gap-2 mb-3">
                      <TrendingUp className="h-5 w-5 text-primary" />
                      Investment Accounts ({investmentAccounts.length})
                    </h3>
                    {loading ? (
                      <div className="space-y-3">
                        {[1, 2].map(i => <Skeleton key={i} className="h-20 w-full" />)}
                      </div>
                    ) : investmentAccounts.length === 0 ? (
                      <Card className="p-6 text-center">
                        <PiggyBank className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No investment accounts yet</p>
                      </Card>
                    ) : (
                      <div className="space-y-3">
                        {investmentAccounts.map((account) => (
                          <Card key={account.id} className="overflow-hidden">
                            <div className="h-1" style={{ backgroundColor: account.color }} />
                            <CardContent className="p-4">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="font-medium">{account.name}</p>
                                  <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                                    <Calendar className="h-3 w-3" />
                                    {format(new Date(account.created_at), 'MMM d, yyyy')}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold">{formatUGX(account.balance)}</p>
                                  <div className="mt-1">{getStatusBadge(account.status)}</div>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="rent" className="mt-0">
                <div className="p-4">
                  <UserRentSection userId={user.id} />
                </div>
              </TabsContent>

              <TabsContent value="invest" className="mt-0">
                <div className="p-4">
                  <UserInvestmentsSection userId={user.id} userName={user.full_name} userPhone={user.phone} />
                </div>
              </TabsContent>

              <TabsContent value="referrals" className="mt-0">
                <div className="p-4">
                  <UserReferralsSection userId={user.id} />
                </div>
              </TabsContent>

              <TabsContent value="terms" className="mt-0">
                <div className="p-4">
                  <UserTermsSection userId={user.id} userRoles={userRoles} />
                </div>
              </TabsContent>

              <TabsContent value="permissions" className="mt-0">
                <div className="p-4">
                  <DashboardPermissionsTab userId={user.id} />
                </div>
              </TabsContent>

              <TabsContent value="edit" className="mt-0">
                <div className="p-4 space-y-5">
                  {/* Edit Profile Form */}
                  <Card>
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Pencil className="h-4 w-4 text-primary" />
                        Edit Profile
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="edit-name-mobile">Full Name</Label>
                        <PersonNameFields
                          idPrefix="user-details-mobile"
                          value={nameParts}
                          onChange={applyNameParts}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-email-mobile">Email</Label>
                        <Input
                          id="edit-email-mobile"
                          type="email"
                          value={editForm.email}
                          onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))}
                          placeholder="Enter email"
                          className="h-12 text-base"
                          inputMode="email"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-phone-mobile">Phone</Label>
                        <Input
                          id="edit-phone-mobile"
                          value={editForm.phone}
                          onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))}
                          placeholder="Enter phone number"
                          className="h-12 text-base"
                          inputMode="tel"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="edit-rent-mobile">Monthly Rent (UGX)</Label>
                        <Input
                          id="edit-rent-mobile"
                          type="number"
                          value={editForm.monthly_rent}
                          onChange={(e) => setEditForm(prev => ({ ...prev, monthly_rent: e.target.value }))}
                          placeholder="Enter monthly rent"
                          className="h-12 text-base"
                          inputMode="numeric"
                        />
                      </div>
                      <Button onClick={handleSaveProfile} disabled={savingProfile} className="w-full h-12">
                        {savingProfile ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
                        ) : (
                          <><CheckCircle className="h-4 w-4 mr-2" />Save Changes</>
                        )}
                      </Button>
                    </CardContent>
                  </Card>

                  {/* Reset Password */}
                  <Card className="border-warning/30">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2 text-warning">
                        <KeyRound className="h-4 w-4" />
                        Reset Password
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      <p className="text-xs text-muted-foreground">
                        Set a new password for this user. Common or breached passwords (e.g. <code className="text-[10px] bg-muted px-1 rounded">Welile1234!</code>, <code className="text-[10px] bg-muted px-1 rounded">password123</code>) are blocked. Tap <strong>Generate</strong> for a guaranteed-safe one.
                      </p>
                      <div className="relative">
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Enter new password (min 6 chars)"
                          className="h-12 text-base pr-20"
                        />
                        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                          {newPassword && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              title="Copy password"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(newPassword);
                                  toast.success('Password copied');
                                } catch {
                                  toast.error('Could not copy');
                                }
                              }}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            title={showPassword ? 'Hide' : 'Show'}
                            onClick={() => setShowPassword(!showPassword)}
                          >
                            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          className="h-11"
                          onClick={() => {
                            // Generate a strong, non-pwned password.
                            // Format: Welile-XXXX-####  (random letters + digits, ~80 bits entropy)
                            const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
                            const digits = '23456789';
                            let chunk = '';
                            for (let i = 0; i < 4; i++) chunk += letters[Math.floor(Math.random() * letters.length)];
                            let nums = '';
                            for (let i = 0; i < 4; i++) nums += digits[Math.floor(Math.random() * digits.length)];
                            const generated = `Welile-${chunk}-${nums}`;
                            setNewPassword(generated);
                            setShowPassword(true);
                            toast.success('Strong password generated — tap copy then Reset');
                          }}
                        >
                          <RefreshCw className="h-4 w-4 mr-2" /> Generate
                        </Button>
                        <Button
                          onClick={handleResetPassword}
                          disabled={resettingPassword || !newPassword || newPassword.length < 6}
                          variant="outline"
                          className="h-11 border-warning/40 text-warning hover:bg-warning/10"
                        >
                          {resettingPassword ? (
                            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Resetting...</>
                          ) : (
                            <><KeyRound className="h-4 w-4 mr-2" />Reset</>
                          )}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Reset Manager Login Password */}
                  {userRoles.includes('manager') && (
                    <Card className="border-primary/30">
                      <CardHeader className="py-3">
                        <CardTitle className="text-sm flex items-center gap-2 text-primary">
                          <ShieldCheck className="h-4 w-4" />
                          Manager Login Password
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0 space-y-3">
                        <p className="text-xs text-muted-foreground">Reset the manager portal access password back to the default. The user will be required to set a new one on next login.</p>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="outline"
                              className="w-full h-12 border-primary/40 text-primary hover:bg-primary/10"
                              disabled={resettingStaffPassword}
                            >
                              {resettingStaffPassword ? (
                                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Resetting...</>
                              ) : (
                                <><ShieldCheck className="h-4 w-4 mr-2" />Reset Manager Login Password</>
                              )}
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Reset Manager Login Password?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will reset {user?.full_name}'s manager portal password back to the default. They will need to set a new password on their next manager login.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={handleResetStaffPassword}>Reset Password</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </CardContent>
                    </Card>
                  )}

                  <Separator />

                  {/* Danger Zone */}
                  <Card className="border-destructive/50">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2 text-destructive">
                        <AlertTriangle className="h-4 w-4" />
                        Danger Zone
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      {/* Freeze/Unfreeze */}
                      <AlertDialog open={freezeConfirmOpen} onOpenChange={setFreezeConfirmOpen}>
                        <AlertDialogTrigger asChild>
                          <Button variant={isFrozen ? 'outline' : 'destructive'} className="w-full h-12">
                            {isFrozen ? <><ShieldOff className="h-4 w-4 mr-2" />Unfreeze Account</> : <><ShieldAlert className="h-4 w-4 mr-2" />Freeze Account</>}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{isFrozen ? 'Unfreeze Account?' : '🚫 Freeze Account?'}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {isFrozen
                                ? `This will restore ${user.full_name}'s access to the platform.`
                                : `This will block ${user.full_name} from all transactions, deposits, and withdrawals. They will see a red warning screen.`}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleToggleFreeze} disabled={freezingUser} className={isFrozen ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}>
                              {freezingUser ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                              {isFrozen ? 'Unfreeze' : 'Freeze Account'}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                      {isFrozen && <p className="text-xs text-destructive font-medium text-center">⚠️ This account is currently frozen</p>}
                      {/* Delete */}
                      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                        <AlertDialogTrigger asChild>
                          <Button variant="destructive" className="w-full h-14 text-base font-bold border-2 border-destructive shadow-lg animate-pulse hover:animate-none">
                            <Trash2 className="h-5 w-5 mr-2" />
                            🗑️ DELETE FAKE ACCOUNT
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete User?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete <strong>{user.full_name}</strong> and all their data. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleDeleteUser} disabled={deletingUser} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                              {deletingUser ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</> : <><Trash2 className="h-4 w-4 mr-2" />Delete</>}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </CardContent>
                  </Card>
                </div>
              </TabsContent>

              <TabsContent value="roles" className="mt-0">
                <div className="p-4 space-y-5">
                  <Input
                    value={roleChangeReason}
                    onChange={(e) => setRoleChangeReason(e.target.value)}
                    placeholder="Reason for this change (recorded in the audit log)"
                    className="h-10 text-sm"
                  />
                  {/* All Roles - Unified List */}
                  {!canEdit && (
                    <p className="text-sm text-muted-foreground">You can change standard roles here. Only access administrators can change internal and executive roles.</p>
                  )}
                  {(['standard', 'internal', 'executive'] as const).map(category => {
                    const categoryRoles = allRoles.filter(r => r.category === category);
                    const categoryLabel = category === 'standard' ? 'Standard Roles' : category === 'internal' ? 'Internal Roles' : 'Executive Roles';
                    return (
                      <Card key={category}>
                        <CardHeader className="py-3">
                          <CardTitle className="text-sm flex items-center gap-2">
                            <Shield className="h-4 w-4 text-primary" />
                            {categoryLabel}
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-0">
                          <div className="space-y-2">
                            {categoryRoles.map((role) => {
                              const isAssigned = userRoles.includes(role.value);
                              const isEnabled = roleEnabledStatus[role.value] ?? true;
                              const enabledCount = Object.values(roleEnabledStatus).filter(Boolean).length;
                              const canDisable = enabledCount > 1 || !isEnabled;
                              
                              return (
                                <div key={role.value}>
                                  <div className={`flex items-center justify-between p-3 rounded-xl border-2 transition-all ${
                                    isAssigned 
                                      ? (isEnabled ? 'bg-card border-primary/30' : 'bg-muted/30 border-muted opacity-70')
                                      : 'bg-muted/20 border-dashed border-muted-foreground/20'
                                  }`}>
                                    <div className="flex items-center gap-3 flex-1 min-w-0">
                                      <span className="text-xl">{role.emoji}</span>
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <p className="font-bold text-sm">{role.label}</p>
                                          {isAssigned ? (
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-success/10 text-success border-success/30">Assigned</Badge>
                                          ) : (
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">Not assigned</Badge>
                                          )}
                                        </div>
                                        <p className="text-xs text-muted-foreground">{role.description}</p>
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      {isAssigned ? (
                                        <>
                                          <Button
                                            variant={isEnabled ? "default" : "outline"}
                                            size="sm"
                                            onClick={() => handleToggleRoleEnabled(role.value)}
                                            disabled={togglingRole === role.value || (!canDisable && isEnabled) || (!canEdit && role.category !== 'standard')}
                                            className={`h-9 w-9 p-0 rounded-lg ${isEnabled ? 'bg-success hover:bg-success/90' : ''}`}
                                          >
                                            {togglingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : isEnabled ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                                          </Button>
                                          <Button
                                            variant="destructive"
                                            size="sm"
                                            onClick={() => handleRemoveRole(role.value)}
                                            disabled={removingRole === role.value || userRoles.length <= 1 || (!canEdit && role.category !== 'standard')}
                                            className="h-9 w-9 p-0 rounded-lg"
                                          >
                                            {removingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                          </Button>
                                        </>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() => handleAddRole(role.value)}
                                          disabled={addingRole === role.value || (!canEdit && role.category !== 'standard')}
                                          className="h-9 px-3 rounded-lg border-success/40 text-success hover:bg-success/10"
                                        >
                                          {addingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4 mr-1" /> Add</>}
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                  {/* Operations Sub-Departments */}
                                  {role.value === 'operations' && isAssigned && (
                                    <div className="ml-8 mt-2 p-3 rounded-xl bg-muted/30 border border-dashed space-y-2">
                                      <p className="text-xs font-semibold text-muted-foreground mb-2">Operations Departments</p>
                                      {OPERATIONS_DEPARTMENTS.map(dept => {
                                        const isActive = operationsDepartments.includes(dept.toLowerCase());
                                        return (
                                          <div key={dept} className={`flex items-center justify-between p-2 rounded-lg border ${isActive ? 'bg-card border-primary/20' : 'bg-muted/20 border-transparent'}`}>
                                            <div className="flex items-center gap-2">
                                              <span className="text-sm">{dept === 'Agent' ? '💼' : dept === 'Tenant' ? '🏠' : dept === 'Landlord' ? '🏢' : '💰'}</span>
                                              <span className="text-sm font-medium">{dept}</span>
                                              {isActive && <Badge variant="outline" className="text-[10px] px-1 py-0 bg-success/10 text-success border-success/30">Active</Badge>}
                                            </div>
                                            <Button
                                              variant={isActive ? "default" : "outline"}
                                              size="sm"
                                              onClick={() => handleToggleOperationsDept(dept)}
                                              disabled={togglingDept === dept}
                                              className={`h-7 w-7 p-0 rounded-md ${isActive ? 'bg-success hover:bg-success/90' : 'border-muted'}`}
                                            >
                                              {togglingDept === dept ? <Loader2 className="h-3 w-3 animate-spin" /> : isActive ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                                            </Button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}

                  {/* Sub-Agents Section - Only for agents */}
                  {userRoles.includes('agent') && (
                    <Card className="border-warning/30">
                      <CardHeader className="py-3">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <UsersRound className="h-4 w-4 text-warning" />
                          Sub-Agents ({subAgents.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        {subAgentsLoading ? (
                          <div className="space-y-2">
                            {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}
                          </div>
                        ) : subAgents.length === 0 ? (
                          <div className="text-center py-6">
                            <UsersRound className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                            <p className="text-sm text-muted-foreground">No sub-agents registered</p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {subAgents.map((subAgent) => (
                              <div key={subAgent.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/50 border">
                                <div className="flex items-center gap-3">
                                  <Avatar className="h-10 w-10 border">
                                    <AvatarImage src={subAgent.profile?.avatar_url || undefined} />
                                    <AvatarFallback className="bg-warning/20 text-warning text-sm font-bold">
                                      {subAgent.profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?'}
                                    </AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <p className="font-medium text-sm">{subAgent.profile?.full_name || 'Unknown'}</p>
                                    <p className="text-xs text-muted-foreground">{subAgent.profile?.phone}</p>
                                  </div>
                                </div>
                                <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                                  {subAgent.tenants_count} tenant{subAgent.tenants_count !== 1 ? 's' : ''}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="activity" className="mt-0">
                <div className="p-4 space-y-6">
                  <FundEditHistory userId={user.id} userName={user.full_name} />
                  <Separator />
                  <UserActivityTimeline userId={user.id} userName={user.full_name} />
                </div>
              </TabsContent>
            </div>
          </Tabs>

          {canAdjustBalance && (
            <AddBalanceDialog
              open={addBalanceOpen}
              onOpenChange={setAddBalanceOpen}
              userId={user.id}
              userName={user.full_name}
              currentBalance={walletBalance}
              onSuccess={fetchUserDetails}
            />
          )}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] p-0 flex flex-col overflow-hidden">
        <DialogHeader className="p-6 pb-0 shrink-0">
          <DialogTitle>
            <UserHeader />
          </DialogTitle>
        </DialogHeader>

        {/* Sticky Verification & Seller Banners */}
        <div className="px-6 pt-2 shrink-0 space-y-2">
          <VerificationBanner />
          <SellerBanner />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="px-6 pt-4 shrink-0">
            <TabsNavigation />
          </div>

          <div className="flex-1 overflow-y-auto min-h-0" style={{ WebkitOverflowScrolling: 'touch' }}>
            <TabsContent value="overview" className="mt-0">
              <div className="p-6 pt-4 space-y-6">
                {/* Contact Info */}
                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <User className="h-4 w-4 text-primary" />
                      Contact Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-0">
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <a href={`mailto:${user.email}`} className="text-sm text-primary hover:underline">
                        {user.email}
                      </a>
                    </div>
                    <div className="flex items-center gap-3">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <WhatsAppPhoneLink phone={user.phone} />
                    </div>
                    <div className="flex items-center gap-3 md:col-span-2">
                      
                    </div>
                  </CardContent>
                </Card>

                {/* Referred By */}
                <Card className="border-primary/20">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-primary" />
                      Referred By
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    {referrerLoading ? (
                      <Skeleton className="h-12 w-full" />
                    ) : referrerInfo ? (
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10 border">
                          <AvatarFallback className="bg-primary/10 text-primary text-sm font-bold">
                            {referrerInfo.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm truncate">{referrerInfo.name}</p>
                          <p className="text-xs text-muted-foreground">{referrerInfo.phone}</p>
                        </div>
                        <Badge variant="outline" className="shrink-0 text-xs">
                          {referrerInfo.method}
                        </Badge>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No referrer — signed up directly</p>
                    )}
                  </CardContent>
                </Card>

                {/* Tenant Ecosystem */}
                <UserEcosystemSection userId={user.id} />

                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Card
                    className={`p-3 relative group transition-colors ${canAdjustBalance ? 'cursor-pointer hover:border-primary/50' : ''}`}
                    onClick={canAdjustBalance ? () => setAddBalanceOpen(true) : undefined}
                  >
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Wallet className="h-3 w-3" />Wallet Balance</div>
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-sm">{formatUGX(walletBalance)}</p>
                      {canAdjustBalance && (
                        <Plus className="h-4 w-4 text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
                      )}
                    </div>
                  </Card>
                  <Card className="p-3">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><PiggyBank className="h-3 w-3" />Invested</div>
                    <p className="font-semibold text-sm">{formatUGX(totalInvested)}</p>
                  </Card>
                  <Card className="p-3">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Banknote className="h-3 w-3" />Monthly Rent</div>
                    <p className="font-semibold text-sm">{user.monthly_rent ? formatUGX(user.monthly_rent) : 'N/A'}</p>
                  </Card>
                  <Card className="p-3">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Star className="h-3 w-3" />Rating</div>
                    {user.rating_count > 0 ? (
                      <div className="flex items-center gap-1">{renderStars(user.average_rating || 0)}<span className="text-xs text-muted-foreground">({user.rating_count})</span></div>
                    ) : (
                      <p className="font-semibold text-sm text-muted-foreground">No ratings</p>
                    )}
                  </Card>
                </div>

                {/* Verification Status */}
                <Card className={`border-2 ${verificationStatus ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3">
                        {verificationStatus ? (
                          <>
                            <div className="p-2 rounded-full bg-success/20"><CheckCircle className="h-5 w-5 text-success" /></div>
                            <div><p className="font-semibold text-success">Verified User</p><p className="text-xs text-muted-foreground">Approved and can access all features</p></div>
                          </>
                        ) : (
                          <>
                            <div className="p-2 rounded-full bg-warning/20"><XCircle className="h-5 w-5 text-warning" /></div>
                            <div><p className="font-semibold text-warning">Pending Verification</p><p className="text-xs text-muted-foreground">This user needs to be verified</p></div>
                          </>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {!verificationStatus ? (
                          <Button size="sm" variant="default" onClick={handleApproveUser} disabled={approvingUser} className="gap-2">
                            {approvingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}Approve
                          </Button>
                        ) : (
                          <Button size="sm" variant="destructive" onClick={handleRejectUser} disabled={rejectingUser} className="gap-2">
                            {rejectingUser ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}Revoke
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {user.rent_discount_active && (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
                    <CheckCircle className="h-3 w-3 mr-1" />Rent Discount Active
                  </Badge>
                )}

                <Separator />

                {/* Investment Accounts */}
                <div>
                  <h3 className="font-semibold flex items-center gap-2 mb-4"><TrendingUp className="h-5 w-5 text-primary" />Investment Accounts ({investmentAccounts.length})</h3>
                  {loading ? (
                    <div className="space-y-3">{[1, 2].map(i => <Skeleton key={i} className="h-20 w-full" />)}</div>
                  ) : investmentAccounts.length === 0 ? (
                    <Card className="p-6 text-center"><PiggyBank className="h-10 w-10 mx-auto text-muted-foreground mb-2" /><p className="text-muted-foreground">No investment accounts yet</p></Card>
                  ) : (
                    <div className="space-y-3">
                      {investmentAccounts.map((account) => (
                        <Card key={account.id} className="overflow-hidden">
                          <div className="h-1" style={{ backgroundColor: account.color }} />
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between">
                              <div><p className="font-medium">{account.name}</p><div className="flex items-center gap-2 text-xs text-muted-foreground mt-1"><Calendar className="h-3 w-3" />Created {format(new Date(account.created_at), 'MMM d, yyyy')}</div></div>
                              <div className="text-right"><p className="font-semibold">{formatUGX(account.balance)}</p><div className="mt-1">{getStatusBadge(account.status)}</div></div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="rent" className="mt-0">
              <div className="p-6 pt-4">
                <UserRentSection userId={user.id} />
              </div>
            </TabsContent>

            <TabsContent value="invest" className="mt-0">
              <div className="p-6 pt-4">
                <UserInvestmentsSection userId={user.id} userName={user.full_name} userPhone={user.phone} />
              </div>
            </TabsContent>

            <TabsContent value="referrals" className="mt-0">
              <div className="p-6 pt-4">
                <UserReferralsSection userId={user.id} />
              </div>
            </TabsContent>

            <TabsContent value="terms" className="mt-0">
              <div className="p-6 pt-4">
                <UserTermsSection userId={user.id} userRoles={userRoles} />
              </div>
            </TabsContent>

            <TabsContent value="permissions" className="mt-0">
              <div className="p-6 pt-4">
                <DashboardPermissionsTab userId={user.id} />
              </div>
            </TabsContent>

            <TabsContent value="edit" className="mt-0">
              <div className="p-6 pt-4 space-y-6">
                <Card>
                  <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2"><Pencil className="h-4 w-4 text-primary" />Edit Profile</CardTitle></CardHeader>
                  <CardContent className="pt-0 space-y-4">
                    <div className="space-y-2"><Label>Full Name</Label><PersonNameFields idPrefix="user-details" value={nameParts} onChange={applyNameParts} /></div>
                    <div className="space-y-2"><Label htmlFor="edit-email">Email</Label><Input id="edit-email" type="email" value={editForm.email} onChange={(e) => setEditForm(prev => ({ ...prev, email: e.target.value }))} placeholder="Enter email" /></div>
                    <div className="space-y-2"><Label htmlFor="edit-phone">Phone</Label><Input id="edit-phone" value={editForm.phone} onChange={(e) => setEditForm(prev => ({ ...prev, phone: e.target.value }))} placeholder="Enter phone number" /></div>
                    <div className="space-y-2"><Label htmlFor="edit-rent">Monthly Rent (UGX)</Label><Input id="edit-rent" type="number" value={editForm.monthly_rent} onChange={(e) => setEditForm(prev => ({ ...prev, monthly_rent: e.target.value }))} placeholder="Enter monthly rent amount" /></div>
                    <Button onClick={handleSaveProfile} disabled={savingProfile} className="w-full">{savingProfile ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</> : <><CheckCircle className="h-4 w-4 mr-2" />Save Changes</>}</Button>
                  </CardContent>
                </Card>
                {/* Reset Password */}
                <Card className="border-warning/30">
                  <CardHeader className="py-3">
                    <CardTitle className="text-sm flex items-center gap-2 text-warning">
                      <KeyRound className="h-4 w-4" />
                      Reset Password
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <p className="text-xs text-muted-foreground">Set a new password for this user. They will use it on their next login.</p>
                    <div className="relative">
                      <Input
                        type={showPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="Enter new password (min 6 chars)"
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 p-0"
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </Button>
                    </div>
                    <Button
                      onClick={handleResetPassword}
                      disabled={resettingPassword || !newPassword || newPassword.length < 6}
                      variant="outline"
                      className="w-full border-warning/40 text-warning hover:bg-warning/10"
                    >
                      {resettingPassword ? (
                        <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Resetting...</>
                      ) : (
                        <><KeyRound className="h-4 w-4 mr-2" />Reset Password</>
                      )}
                    </Button>
                  </CardContent>
                </Card>

                {/* Reset Manager Login Password */}
                {userRoles.includes('manager') && (
                  <Card className="border-primary/30">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2 text-primary">
                        <ShieldCheck className="h-4 w-4" />
                        Manager Login Password
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      <p className="text-xs text-muted-foreground">Reset manager portal password to default.</p>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="outline"
                            className="w-full border-primary/40 text-primary hover:bg-primary/10"
                            disabled={resettingStaffPassword}
                          >
                            {resettingStaffPassword ? (
                              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Resetting...</>
                            ) : (
                              <><ShieldCheck className="h-4 w-4 mr-2" />Reset Manager Login Password</>
                            )}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Reset Manager Login Password?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will reset {user?.full_name}'s manager portal password back to the default. They will need to set a new password on their next manager login.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={handleResetStaffPassword}>Reset Password</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </CardContent>
                  </Card>
                )}

                <Separator />
                <Card className="border-destructive/50">
                  <CardHeader className="py-3"><CardTitle className="text-sm flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" />Danger Zone</CardTitle></CardHeader>
                  <CardContent className="pt-0 space-y-3">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant={isFrozen ? 'outline' : 'destructive'} className="w-full">
                          {isFrozen ? <><ShieldOff className="h-4 w-4 mr-2" />Unfreeze Account</> : <><ShieldAlert className="h-4 w-4 mr-2" />Freeze Account</>}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{isFrozen ? 'Unfreeze Account?' : '🚫 Freeze Account?'}</AlertDialogTitle>
                          <AlertDialogDescription>{isFrozen ? `Restore ${user.full_name}'s access.` : `Block ${user.full_name} from all transactions. They will see a red warning.`}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={handleToggleFreeze} disabled={freezingUser} className={isFrozen ? '' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}>
                            {freezingUser ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}{isFrozen ? 'Unfreeze' : 'Freeze'}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    {isFrozen && <p className="text-xs text-destructive font-medium text-center">⚠️ This account is currently frozen</p>}
                    <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
                      <AlertDialogTrigger asChild><Button variant="destructive" className="w-full h-14 text-base font-bold border-2 border-destructive shadow-lg animate-pulse hover:animate-none"><Trash2 className="h-5 w-5 mr-2" />🗑️ DELETE FAKE ACCOUNT</Button></AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader><AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle><AlertDialogDescription>This will permanently delete <strong>{user.full_name}</strong> and all their data. This action cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction onClick={handleDeleteUser} disabled={deletingUser} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{deletingUser ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Deleting...</> : <><Trash2 className="h-4 w-4 mr-2" />Delete User</>}</AlertDialogAction></AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="roles" className="mt-0">
              <div className="p-6 pt-4 space-y-6">
                <Input
                  value={roleChangeReason}
                  onChange={(e) => setRoleChangeReason(e.target.value)}
                  placeholder="Reason for this change (recorded in the audit log)"
                  className="h-9 text-sm"
                />
                {/* All Roles - Unified List by Category */}
                {!canEdit && (
                  <p className="text-sm text-muted-foreground">You can change standard roles here. Only access administrators can change internal and executive roles.</p>
                )}
                {(['standard', 'internal', 'executive'] as const).map(category => {
                  const categoryRoles = allRoles.filter(r => r.category === category);
                  const categoryLabel = category === 'standard' ? 'Standard Roles' : category === 'internal' ? 'Internal Roles' : 'Executive Roles';
                  return (
                    <Card key={category}>
                      <CardHeader className="py-3">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Shield className="h-4 w-4 text-primary" />
                          {categoryLabel}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="pt-0">
                        <div className="space-y-2">
                          {categoryRoles.map((role) => {
                            const isAssigned = userRoles.includes(role.value);
                            const isEnabled = roleEnabledStatus[role.value] ?? true;
                            const enabledCount = Object.values(roleEnabledStatus).filter(Boolean).length;
                            const canDisable = enabledCount > 1 || !isEnabled;
                            
                            return (
                              <div key={role.value}>
                                <div className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                                  isAssigned 
                                    ? (isEnabled ? 'bg-card border-border' : 'bg-muted/30 border-muted opacity-70')
                                    : 'bg-muted/20 border-dashed border-muted-foreground/20'
                                }`}>
                                  <div className="flex items-center gap-3 flex-1 min-w-0">
                                    <span className="text-lg">{role.emoji}</span>
                                    <Badge className={`${role.color} ${!isAssigned ? 'opacity-50' : ''}`}>{role.label}</Badge>
                                    <div className="flex flex-col min-w-0">
                                      <span className="text-xs text-muted-foreground truncate">{role.description}</span>
                                      {isAssigned && (
                                        <span className={`text-xs font-medium ${isEnabled ? 'text-success' : 'text-destructive'}`}>
                                          {isEnabled ? '✓ Active' : '✗ Disabled'}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    {isAssigned ? (
                                      <>
                                        <Button variant="ghost" size="sm" onClick={() => handleToggleRoleEnabled(role.value)} disabled={togglingRole === role.value || (!canDisable && isEnabled) || (!canEdit && role.category !== 'standard')} className={`h-8 px-3 ${isEnabled ? 'text-success hover:bg-success/10' : 'text-muted-foreground hover:bg-muted'}`}>
                                          {togglingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : isEnabled ? <ToggleRight className="h-5 w-5" /> : <ToggleLeft className="h-5 w-5" />}
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => handleRemoveRole(role.value)} disabled={removingRole === role.value || userRoles.length <= 1 || (!canEdit && role.category !== 'standard')} className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8 p-0">
                                          {removingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                                        </Button>
                                      </>
                                    ) : (
                                      <Button variant="ghost" size="sm" onClick={() => handleAddRole(role.value)} disabled={addingRole === role.value || (!canEdit && role.category !== 'standard')} className="text-success hover:text-success hover:bg-success/10">
                                        {addingRole === role.value ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Plus className="h-4 w-4 mr-1" /> Add</>}
                                      </Button>
                                    )}
                                  </div>
                                </div>
                                {/* Operations Sub-Departments */}
                                {role.value === 'operations' && isAssigned && (
                                  <div className="ml-10 mt-2 p-3 rounded-xl bg-muted/30 border border-dashed space-y-2">
                                    <p className="text-xs font-semibold text-muted-foreground mb-2">Operations Departments</p>
                                    <div className="grid grid-cols-2 gap-2">
                                      {OPERATIONS_DEPARTMENTS.map(dept => {
                                        const isActive = operationsDepartments.includes(dept.toLowerCase());
                                        return (
                                          <div key={dept} className={`flex items-center justify-between p-2 rounded-lg border ${isActive ? 'bg-card border-primary/20' : 'bg-muted/20 border-transparent'}`}>
                                            <div className="flex items-center gap-2">
                                              <span className="text-sm">{dept === 'Agent' ? '💼' : dept === 'Tenant' ? '🏠' : dept === 'Landlord' ? '🏢' : '💰'}</span>
                                              <span className="text-sm font-medium">{dept}</span>
                                            </div>
                                            <Button
                                              variant={isActive ? "default" : "outline"}
                                              size="sm"
                                              onClick={() => handleToggleOperationsDept(dept)}
                                              disabled={togglingDept === dept}
                                              className={`h-7 w-7 p-0 rounded-md ${isActive ? 'bg-success hover:bg-success/90' : 'border-muted'}`}
                                            >
                                              {togglingDept === dept ? <Loader2 className="h-3 w-3 animate-spin" /> : isActive ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
                                            </Button>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}

                {/* Sub-Agents Section */}
                {userRoles.includes('agent') && (
                  <Card className="border-warning/30">
                    <CardHeader className="py-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <UsersRound className="h-4 w-4 text-warning" />
                        Sub-Agents ({subAgents.length})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-0">
                      {subAgentsLoading ? (
                        <div className="space-y-2">
                          {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}
                        </div>
                      ) : subAgents.length === 0 ? (
                        <div className="text-center py-6">
                          <UsersRound className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
                          <p className="text-sm text-muted-foreground">No sub-agents registered</p>
                        </div>
                      ) : (
                        <div className="grid gap-2 md:grid-cols-2">
                          {subAgents.map((subAgent) => (
                            <div key={subAgent.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/50 border">
                              <div className="flex items-center gap-3">
                                <Avatar className="h-10 w-10 border">
                                  <AvatarImage src={subAgent.profile?.avatar_url || undefined} />
                                  <AvatarFallback className="bg-warning/20 text-warning text-sm font-bold">
                                    {subAgent.profile?.full_name?.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || '?'}
                                  </AvatarFallback>
                                </Avatar>
                                <div>
                                  <p className="font-medium text-sm">{subAgent.profile?.full_name || 'Unknown'}</p>
                                  <p className="text-xs text-muted-foreground">{subAgent.profile?.phone}</p>
                                </div>
                              </div>
                              <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30">
                                {subAgent.tenants_count} tenant{subAgent.tenants_count !== 1 ? 's' : ''}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            <TabsContent value="activity" className="mt-0">
              <div className="p-6 pt-4 space-y-6">
                <FundEditHistory userId={user.id} userName={user.full_name} />
                <Separator />
                <UserActivityTimeline userId={user.id} userName={user.full_name} />
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>

      {canAdjustBalance && (
        <AddBalanceDialog
          open={addBalanceOpen}
          onOpenChange={setAddBalanceOpen}
          userId={user.id}
          userName={user.full_name}
          currentBalance={walletBalance}
          onSuccess={fetchUserDetails}
        />
      )}
    </Dialog>
  );
}

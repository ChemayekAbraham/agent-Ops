import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Users, Search, Star, CheckCircle, X, 
  ArrowLeft, RefreshCw, MoreVertical, Loader2, BadgeCheck, Clock, Send, Share2, UserCheck
} from 'lucide-react';
import UserDetailsDialog from '@/components/manager/UserDetailsDialog';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { formatDistanceToNow } from 'date-fns';

import BulkAssignRoleDialog from '@/components/manager/BulkAssignRoleDialog';
import BulkRemoveRoleDialog from '@/components/manager/BulkRemoveRoleDialog';
import BulkWhatsAppDialog from '@/components/manager/BulkWhatsAppDialog';
import InactiveUsersReachOutDialog from '@/components/manager/InactiveUsersReachOutDialog';
import BulkSetDefaultRoleDialog from '@/components/manager/BulkSetDefaultRoleDialog';
import { CreateUserInviteDialog } from '@/components/manager/CreateUserInviteDialog';
import { CompactUserStats, StatFilter } from '@/components/manager/CompactUserStats';
import { exportToCSV, formatDateForExport } from '@/lib/exportUtils';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { hapticTap, hapticSuccess } from '@/lib/haptics';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { usePresence } from '@/hooks/usePresence';
import { cn } from '@/lib/utils';
import { format, isToday, isYesterday } from 'date-fns';
import { ScrollToTopButton } from '@/components/ScrollToTopButton';

interface UserWithRating {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  rent_discount_active: boolean;
  monthly_rent: number | null;
  roles: string[];
  roleEnabledStatus: Record<string, boolean>;
  average_rating: number | null;
  rating_count: number;
  created_at: string;
  country: string | null;
  city: string | null;
  country_code: string | null;
  verified: boolean;
  subagent_count: number;
  last_active_at: string | null;
}

type RoleFilter = 'all' | 'tenant' | 'agent' | 'supporter' | 'landlord' | 'manager' | 'employee' | 'super_admin' | 'active' | 'inactive' | 'pending_invites';
type SortOption = 'newest' | 'oldest' | 'name_asc' | 'name_desc' | 'rating_high' | 'rating_low' | 'last_active' | 'least_active';
type VerificationFilter = 'all' | 'verified' | 'pending';

const PAGE_SIZE = 25;

const isUserInactive = (lastActiveAt: string | null): boolean => {
  if (!lastActiveAt) return true;
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return new Date(lastActiveAt) < thirtyDaysAgo;
};

const formatLastActive = (lastActiveAt: string | null): string => {
  if (!lastActiveAt) return 'Long ago';
  const date = new Date(lastActiveAt);
  if (isToday(date)) return format(date, 'h:mm a');
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'dd/MM/yyyy');
};

const getStatusText = (user: UserWithRating): string => {
  if (user.roles.length === 0) return 'New user';
  return user.roles.map(r => r.charAt(0).toUpperCase() + r.slice(1)).join(' • ');
};

export default function UserManagement() {
  const navigate = useNavigate();
  const { user, roles, role } = useAuth();
  const { onlineUsers, isOnline } = usePresence();
  const [users, setUsers] = useState<UserWithRating[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserWithRating | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [verificationFilter, setVerificationFilter] = useState<VerificationFilter>('all');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [totalUserCount, setTotalUserCount] = useState<number>(0);
  const [roleCounts, setRoleCounts] = useState<Record<string, number>>({});
  const [verifiedUserCount, setVerifiedUserCount] = useState(0);
  const [inactiveTotalCount, setInactiveTotalCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkNotificationOpen, setBulkNotificationOpen] = useState(false);
  const [bulkAssignRoleOpen, setBulkAssignRoleOpen] = useState(false);
  const [bulkRemoveRoleOpen, setBulkRemoveRoleOpen] = useState(false);
  const [bulkWhatsAppOpen, setBulkWhatsAppOpen] = useState(false);
  const [bulkSetDefaultRoleOpen, setBulkSetDefaultRoleOpen] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [statFilter, setStatFilter] = useState<StatFilter>('all');
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [reachOutInactiveOpen, setReachOutInactiveOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadingMoreRef = useRef(false);

  // Growth tab — % change of total users over a rolling window
  const GROWTH_WINDOWS = [
    { days: 1, label: '1D' },
    { days: 7, label: '7D' },
    { days: 30, label: '30D' },
    { days: 365, label: '365D' },
  ] as const;
  const [growthWindowIdx, setGrowthWindowIdx] = useState(1);
  const [growthPct, setGrowthPct] = useState<number | null>(null);
  const [growthNew, setGrowthNew] = useState(0);
  const [growthLoading, setGrowthLoading] = useState(false);

  // Pending invites state
  interface PendingInvite {
    id: string;
    email: string;
    full_name: string;
    phone: string;
    temp_password: string;
    activation_token: string;
    role: string;
    created_at: string;
    status: string;
  }
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [pendingInvitesCount, setPendingInvitesCount] = useState(0);
  const [pendingInvitesLoading, setPendingInvitesLoading] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);

  const inviteRoleConfig: Record<string, { label: string; emoji: string }> = {
    tenant: { label: 'Tenant', emoji: '🏠' },
    landlord: { label: 'Landlord', emoji: '🏢' },
    agent: { label: 'Agent', emoji: '💼' },
    supporter: { label: 'Partner', emoji: '💰' },
    manager: { label: 'Manager', emoji: '👑' },
  };

  const fetchPendingInvites = async () => {
    setPendingInvitesLoading(true);
    const { data, error, count } = await supabase
      .from('supporter_invites')
      .select('id, email, full_name, phone, temp_password, activation_token, role, created_at, status', { count: 'exact' })
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (!error && data) {
      setPendingInvites(data);
      setPendingInvitesCount(count || data.length);
    }
    setPendingInvitesLoading(false);
  };

  const handleActivateInvite = async (invite: PendingInvite) => {
    setActivatingId(invite.id);
    try {
      const { data, error } = await supabase.functions.invoke('activate-supporter', {
        body: { token: invite.activation_token, password: invite.temp_password },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`${invite.full_name} activated successfully!`);
      // Refresh invites list and counts
      await Promise.all([fetchPendingInvites(), fetchTotalCount()]);
      // Switch to 'all' filter so the newly activated user is visible
      setRoleFilter('all');
      setCurrentPage(0);
      setHasMore(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to activate invite');
    } finally {
      setActivatingId(null);
    }
  };

  const handleResendInviteWhatsApp = (invite: PendingInvite) => {
    setResendingInviteId(invite.id);
    const roleInfo = inviteRoleConfig[invite.role] || { label: 'User', emoji: '👤' };
    const link = `${getPublicOrigin()}/join?t=${invite.activation_token}`;
    const message = `${roleInfo.emoji} Welcome to Welile, ${invite.full_name}!

You've been invited to join as a ${roleInfo.label}!

🔐 Your password: ${invite.temp_password}

👉 Activate your account here:
${link}

Just click the link and enter your password to get started!`;
    window.open(`https://wa.me/${invite.phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`, '_blank');
    setTimeout(() => setResendingInviteId(null), 1000);
  };

  // Debounce search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(searchTerm);
    }, 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchTerm]);

  // Check if user is manager
  useEffect(() => {
    if (!roles.includes('manager')) {
      navigate(roleToSlug(role));
    }
  }, [roles, navigate]);

  // Reset pagination when filters/search change — don't clear users to avoid flash
  useEffect(() => {
    setCurrentPage(0);
    setHasMore(true);
  }, [debouncedSearch, roleFilter, verificationFilter, sortBy, statFilter]);

  // Fetch page when currentPage or filters change
  useEffect(() => {
    fetchUsersPage(currentPage);
  }, [currentPage, debouncedSearch, roleFilter, verificationFilter, sortBy, statFilter]);

  // Fetch counts on mount
  useEffect(() => {
    fetchTotalCount();
    fetchPendingInvites();
  }, []);

  // Growth: signups in the selected window vs the previous window of equal length
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setGrowthLoading(true);
      const days = GROWTH_WINDOWS[growthWindowIdx].days;
      const now = Date.now();
      const windowMs = days * 24 * 60 * 60 * 1000;
      const currentStart = new Date(now - windowMs).toISOString();
      const previousStart = new Date(now - windowMs * 2).toISOString();
      const [currentRes, previousRes] = await Promise.all([
        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', currentStart),
        supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', previousStart)
          .lt('created_at', currentStart),
      ]);
      if (cancelled) return;
      if (currentRes.error || previousRes.error) {
        setGrowthPct(null);
      } else {
        const current = currentRes.count || 0;
        const previous = previousRes.count || 0;
        setGrowthNew(current);
        setGrowthPct(
          previous > 0
            ? ((current - previous) / previous) * 100
            : current > 0
              ? 100
              : 0,
        );
      }
      setGrowthLoading(false);
    };
    if (totalUserCount > 0) load();
    return () => { cancelled = true; };
  }, [growthWindowIdx, totalUserCount]);

  // Fetch pending invites when filter switches to pending_invites
  useEffect(() => {
    if (roleFilter === 'pending_invites') {
      fetchPendingInvites();
    }
  }, [roleFilter]);

  // Keep Super Admin list/count live as access is granted or revoked
  useEffect(() => {
    const channel = supabase
      .channel('user-management-super-admin')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_roles', filter: 'role=eq.super_admin' }, () => {
        fetchTotalCount();
        if (roleFilter === 'super_admin') fetchUsersPage(0);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [roleFilter]);

  // Fallback refresh while viewing the Super Admin tab
  useEffect(() => {
    if (roleFilter !== 'super_admin') return;
    fetchTotalCount();
    const interval = setInterval(() => {
      fetchTotalCount();
      fetchUsersPage(0);
    }, 30000);
    return () => clearInterval(interval);
  }, [roleFilter]);

  // Infinite scroll via IntersectionObserver
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMoreRef.current && !loading) {
          setCurrentPage(prev => prev + 1);
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  const fetchTotalCount = async () => {
    const { data, error } = await supabase.rpc('get_platform_user_counts');
    if (error) {
      console.error('Error fetching platform user counts:', error);
      toast.error(error.message || 'Failed to load user counts');
      return;
    }

    const countsRow = data?.[0];
    if (!countsRow) return;

    setTotalUserCount(countsRow.total_users || 0);
    setVerifiedUserCount(countsRow.verified_users || 0);
    setInactiveTotalCount(countsRow.inactive_users || 0);
    setRoleCounts({
      tenant: countsRow.tenant_count || 0,
      agent: countsRow.agent_count || 0,
      supporter: countsRow.supporter_count || 0,
      landlord: countsRow.landlord_count || 0,
      manager: countsRow.manager_count || 0,
      employee: (countsRow as any).employee_count || 0,
      super_admin: (countsRow as any).super_admin_count || 0,
    });
  };

  const fetchUsersPage = async (page: number) => {
    // Skip profile fetch when viewing pending invites
    if (roleFilter === 'pending_invites') {
      setLoading(false);
      return;
    }
    if (page === 0) setLoading(true);
    else { setLoadingMore(true); loadingMoreRef.current = true; }

    try {
      const from = page * PAGE_SIZE;
      const { data: profiles, error } = await supabase.rpc('get_platform_users_page', {
        _search: debouncedSearch.trim(),
        _role_filter: roleFilter,
        _verification_filter: verificationFilter,
        _stat_filter: statFilter === 'inactive' || roleFilter === 'inactive' ? 'inactive' : statFilter,
        _sort: sortBy,
        _limit: PAGE_SIZE,
        _offset: from,
      });

      if (error) {
        console.error('Error fetching profiles:', error);
        toast.error(error.message || 'Failed to load users');
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
        return;
      }

      if (!profiles || profiles.length === 0) {
        if (page === 0) setUsers([]);
        setHasMore(false);
        setLoading(false);
        setLoadingMore(false);
        loadingMoreRef.current = false;
        return;
      }

      const pageUsers: UserWithRating[] = (profiles || []).map(p => {
        const roleEnabledStatus = (p.role_enabled_status && typeof p.role_enabled_status === 'object' && !Array.isArray(p.role_enabled_status))
          ? p.role_enabled_status as Record<string, boolean>
          : {};
        return {
          id: p.id,
          full_name: p.full_name || '',
          email: p.email || '',
          phone: p.phone || '',
          avatar_url: p.avatar_url || null,
          rent_discount_active: p.rent_discount_active || false,
          monthly_rent: p.monthly_rent || null,
          created_at: p.created_at,
          roles: p.roles || [],
          roleEnabledStatus,
          average_rating: p.average_rating || null,
          rating_count: p.rating_count || 0,
          country: p.country || null,
          city: p.city || null,
          country_code: p.country_code || null,
          verified: p.verified || false,
          subagent_count: p.subagent_count || 0,
          last_active_at: p.last_active_at || null,
        };
      });

      const matched = profiles[0]?.total_matched ?? 0;
      setHasMore(from + pageUsers.length < matched);

      if (page === 0) setUsers(pageUsers);
      else setUsers(prev => [...prev, ...pageUsers.filter(u => !prev.some(p => p.id === u.id))]);
    } catch (err) {
      console.error('Error in fetchUsersPage:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      loadingMoreRef.current = false;
    }
  };

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    hapticTap();
    setCurrentPage(0);
    setUsers([]);
    setHasMore(true);
    await fetchTotalCount();
    await fetchUsersPage(0);
    setRefreshing(false);
    hapticSuccess();
  }, [debouncedSearch, roleFilter, verificationFilter, sortBy, statFilter]);

  // --- UI helpers (unchanged logic) ---

  const handleExportCSV = () => {
    const dataToExport = selectedUserIds.size > 0 ? getSelectedUsers() : users;
    if (dataToExport.length === 0) { toast.error('No users to export'); return; }
    const headers = ['Name', 'Email', 'Phone', 'Country', 'City', 'Roles', 'Rating', 'Verified', 'Joined'];
    const rows = dataToExport.map(u => [
      u.full_name, u.email, u.phone, u.country || 'Unknown', u.city || 'Unknown',
      u.roles.join(', '), u.average_rating ? u.average_rating.toFixed(1) : 'N/A',
      u.verified ? 'Yes' : 'No', formatDateForExport(u.created_at)
    ]);
    exportToCSV({ headers, rows }, selectedUserIds.size > 0 ? 'selected_users' : 'all_users');
    toast.success(`Exported ${dataToExport.length} users`);
  };

  const toggleUserSelection = (userId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    hapticTap();
    setSelectedUserIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) newSet.delete(userId);
      else newSet.add(userId);
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    hapticTap();
    if (selectedUserIds.size === users.length) setSelectedUserIds(new Set());
    else setSelectedUserIds(new Set(users.map(u => u.id)));
  };

  const clearSelection = () => { hapticTap(); setSelectedUserIds(new Set()); };
  const getSelectedUsers = () => users.filter(u => selectedUserIds.has(u.id));

  // Client-side filter for presence-based filters only
  const displayUsers = (() => {
    // When searching, always show the full server-side result set. The
    // online/verified narrowing below relies on realtime presence which is
    // throttled for cost, so applying it to search results would wrongly hide
    // matched users who simply aren't currently "online".
    if (debouncedSearch.trim()) return users;
    if (roleFilter === 'active' || statFilter === 'online') return users.filter(u => isOnline(u.id));
    if (statFilter === 'verified') return users.filter(u => u.verified);
    return users;
  })();

  const handleUserClick = (user: UserWithRating) => { hapticTap(); setSelectedUser(user); setDialogOpen(true); };

  const sortOptions: { value: SortOption; label: string }[] = [
    { value: 'last_active', label: 'Recently Active' },
    { value: 'newest', label: 'Newest First' },
    { value: 'oldest', label: 'Oldest First' },
    { value: 'name_asc', label: 'Name A-Z' },
    { value: 'name_desc', label: 'Name Z-A' },
    { value: 'rating_high', label: 'Top Rated' },
    { value: 'least_active', label: 'Least Active' },
  ];

  const activeUserCount = onlineUsers?.size ?? 0;
  const inactiveUserCount = users.filter(u => isUserInactive(u.last_active_at)).length;

  const roleFilters: { value: RoleFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: totalUserCount },
    { value: 'pending_invites', label: '⏳ Pending Invites', count: pendingInvitesCount },
    { value: 'active', label: 'Online', count: activeUserCount },
    { value: 'tenant', label: 'Tenants', count: roleCounts['tenant'] || 0 },
    { value: 'agent', label: 'Agents', count: roleCounts['agent'] || 0 },
    { value: 'supporter', label: 'Supporters', count: roleCounts['supporter'] || 0 },
    { value: 'landlord', label: 'Landlords', count: roleCounts['landlord'] || 0 },
    { value: 'manager', label: 'Managers', count: roleCounts['manager'] || 0 },
    { value: 'employee', label: 'Employees', count: roleCounts['employee'] || 0 },
    { value: 'super_admin', label: 'SuperAdmin', count: roleCounts['super_admin'] || 0 },
  ];

  const getInitials = (name: string) => name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  // --- RENDER ---

  if (loading && users.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="sticky top-0 z-50 bg-card border-b border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-6 w-24" />
            <div className="flex gap-4"><Skeleton className="h-6 w-6 rounded-full" /></div>
          </div>
        </div>
        <div className="px-3 py-2"><Skeleton className="h-9 w-full rounded-lg" /></div>
        <div className="divide-y divide-border">
          {[1,2,3,4,5,6,7,8].map(i => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-12 w-12 rounded-full" />
              <div className="flex-1"><Skeleton className="h-4 w-32 mb-2" /><Skeleton className="h-3 w-48" /></div>
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border safe-area-top">
        <div className="px-3 pt-2 pb-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search name, phone, email..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-9 py-2 rounded-xl bg-muted text-foreground placeholder:text-muted-foreground border border-border outline-none text-sm focus:border-primary/50"
              style={{ fontSize: '16px' }}
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-2">
            <button onClick={() => { hapticTap(); navigate(-1); }} className="p-1 -ml-1 rounded-full hover:bg-muted active:scale-95 transition-all touch-manipulation" style={{ WebkitTapHighlightColor: 'transparent' }}>
              <ArrowLeft className="h-5 w-5 text-muted-foreground" />
            </button>
            <h1 className="font-semibold text-lg text-foreground">
              Platform Users
              <span className="ml-2 text-sm font-normal text-muted-foreground">({totalUserCount.toLocaleString()})</span>
            </h1>
          </div>

          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button onClick={() => hapticTap()} className="p-1.5 rounded-full hover:bg-muted active:scale-95 transition-all touch-manipulation" style={{ WebkitTapHighlightColor: 'transparent' }}>
                  <MoreVertical className="h-4 w-4 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setAddUserOpen(true)} className="gap-2">
                  <Users className="h-3.5 w-3.5 text-primary" /> Add User
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkNotificationOpen(true)} className="gap-2">
                  Notify {selectedUserIds.size > 0 && `(${selectedUserIds.size})`}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkWhatsAppOpen(true)} className="gap-2">
                  WhatsApp {selectedUserIds.size > 0 && `(${selectedUserIds.size})`}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportCSV} className="gap-2">Export CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkAssignRoleOpen(true)} disabled={selectedUserIds.size === 0} className="gap-2 disabled:opacity-40">Assign Role</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkRemoveRoleOpen(true)} disabled={selectedUserIds.size === 0} className="gap-2 disabled:opacity-40">Remove Role</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setBulkSetDefaultRoleOpen(true)} disabled={selectedUserIds.size === 0} className="gap-2 disabled:opacity-40">
                  Set Default Role {selectedUserIds.size > 0 && `(${selectedUserIds.size})`}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setReachOutInactiveOpen(true)} className="gap-2">Reach Inactive</DropdownMenuItem>
                <DropdownMenuItem onClick={toggleSelectAll}>{selectedUserIds.size === users.length ? 'Deselect All' : 'Select All'}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowFilters(true)}>Filters & Sort</DropdownMenuItem>
                <DropdownMenuItem onClick={handleRefresh}>
                  <RefreshCw className={cn("h-3.5 w-3.5 mr-2", refreshing && "animate-spin")} />
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <CompactUserStats
          totalUsers={totalUserCount}
          onlineCount={activeUserCount}
          verifiedCount={verifiedUserCount}
          inactiveCount={inactiveTotalCount}
          activeFilter={statFilter}
          onFilterChange={setStatFilter}
        />

        <div className="flex gap-1.5 px-2 pb-2 overflow-x-auto scrollbar-hide">
          {roleFilters.map((filter) => (
            <button
              key={filter.value}
              onClick={() => { hapticTap(); setRoleFilter(filter.value); }}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all active:scale-95 touch-manipulation min-h-[36px]",
                roleFilter === filter.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {filter.label}
              <span className="ml-1 opacity-80">{filter.count.toLocaleString()}</span>
            </button>
          ))}

          {/* Growth tab — % change of total users, toggles 1D / 7D / 30D / 365D */}
          <div className="shrink-0 flex items-center gap-1 rounded-full bg-muted px-2 py-1 min-h-[36px]">
            <span className="text-[10px] font-medium text-muted-foreground">Growth</span>
            <span
              className={cn(
                'text-xs font-bold tabular-nums',
                growthPct === null || growthLoading
                  ? 'text-muted-foreground'
                  : growthPct < 0
                    ? 'text-destructive'
                    : 'text-success',
              )}
            >
              {growthLoading || growthPct === null
                ? '—'
                : `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(growthPct !== 0 && Math.abs(growthPct) < 1 ? 2 : 1)}%`}
            </span>
            {!growthLoading && growthPct !== null && (
              <span className="text-[9px] text-muted-foreground">({growthNew.toLocaleString()})</span>
            )}
            <button
              type="button"
              onClick={() => { hapticTap(); setGrowthWindowIdx((i) => (i + 1) % GROWTH_WINDOWS.length); }}
              className="ml-0.5 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground active:scale-95 transition-all touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label={`Growth window: last ${GROWTH_WINDOWS[growthWindowIdx].days} days. Tap to change`}
            >
              {GROWTH_WINDOWS[growthWindowIdx].label}
            </button>
          </div>
        </div>

        {selectedUserIds.size > 0 && (
          <div className="px-2 pb-1">
            <div className="flex items-center justify-between bg-primary/10 rounded-md px-2 py-0.5">
              <span className="text-[9px] font-medium text-primary">{selectedUserIds.size} selected</span>
              <button onClick={clearSelection} className="text-[9px] text-primary font-medium">Clear</button>
            </div>
          </div>
        )}
      </header>

      {/* User Table */}
      <div
        ref={listRef}
        className="flex-1 overflow-auto"
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {roleFilter === 'pending_invites' ? (
          // Pending Invites View
          pendingInvitesLoading ? (
            <div className="px-4 py-8 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
            </div>
          ) : (() => {
            const searchLower = debouncedSearch.trim().toLowerCase();
            const filteredInvites = searchLower
              ? pendingInvites.filter(inv =>
                  inv.full_name.toLowerCase().includes(searchLower) ||
                  inv.phone.toLowerCase().includes(searchLower) ||
                  inv.email.toLowerCase().includes(searchLower)
                )
              : pendingInvites;
            return filteredInvites.length === 0 ? (
            <div className="text-center py-20 px-4">
              <div className="p-4 rounded-full bg-muted w-fit mx-auto mb-4">
                <Clock className="h-12 w-12 text-muted-foreground" />
              </div>
              <p className="font-semibold text-lg text-foreground">{searchLower ? 'No matching invites' : 'No pending invites'}</p>
              <p className="text-sm text-muted-foreground mt-1">{searchLower ? 'Try a different search term' : 'All invitations have been activated'}</p>
            </div>
          ) : (
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm text-muted-foreground">{filteredInvites.length} pending activation{filteredInvites.length !== 1 ? 's' : ''}{searchLower ? ` (of ${pendingInvites.length})` : ''}</p>
                <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs" onClick={fetchPendingInvites}>
                  <RefreshCw className="h-3 w-3" /> Refresh
                </Button>
              </div>
              {filteredInvites.map(invite => {
                const roleInfo = inviteRoleConfig[invite.role] || { label: 'User', emoji: '👤' };
                return (
                  <div key={invite.id} className="p-3 rounded-xl border border-border bg-card hover:bg-muted/50 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="text-2xl shrink-0">{roleInfo.emoji}</div>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-foreground truncate">{invite.full_name}</p>
                          <p className="text-sm text-muted-foreground truncate">{invite.phone}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{roleInfo.label}</Badge>
                            <span className="text-xs text-muted-foreground">
                              {formatDistanceToNow(new Date(invite.created_at), { addSuffix: true })}
                            </span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-warning/10 text-warning border-warning/20">
                              <Clock className="h-2.5 w-2.5 mr-0.5" /> Pending
                            </Badge>
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1 text-xs"
                          onClick={() => handleResendInviteWhatsApp(invite)}
                          disabled={resendingInviteId === invite.id}
                        >
                          {resendingInviteId === invite.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Share2 className="h-3 w-3" />}
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          className="h-8 gap-1 text-xs"
                          onClick={() => handleActivateInvite(invite)}
                          disabled={activatingId === invite.id}
                        >
                          {activatingId === invite.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserCheck className="h-3 w-3" />}
                          Activate
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          );
          })()
        ) : displayUsers.length === 0 && !loadingMore ? (
          <div className="text-center py-20 px-4">
            <div className="p-4 rounded-full bg-muted w-fit mx-auto mb-4">
              <Users className="h-12 w-12 text-muted-foreground" />
            </div>
            <p className="font-semibold text-lg text-foreground">No users found</p>
            <p className="text-sm text-muted-foreground mt-1">Try adjusting your search or filters</p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block px-4 py-3">
              <div className="border border-border rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/50 border-b border-border">
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground w-8">
                          <input
                            type="checkbox"
                            checked={selectedUserIds.size === displayUsers.length && displayUsers.length > 0}
                            onChange={toggleSelectAll}
                            className="rounded border-border"
                          />
                        </th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">User</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Phone</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Roles</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Status</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Rating</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Last Active</th>
                        <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayUsers.map((u) => (
                        <tr
                          key={u.id}
                          onClick={() => handleUserClick(u)}
                          className={cn(
                            "border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer",
                            selectedUserIds.has(u.id) && "bg-primary/5"
                          )}
                        >
                          <td className="px-3 py-2.5" onClick={(e) => { e.stopPropagation(); toggleUserSelection(u.id); }}>
                            <input
                              type="checkbox"
                              checked={selectedUserIds.has(u.id)}
                              onChange={() => {}}
                              className="rounded border-border"
                            />
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <div className="relative shrink-0">
                                <Avatar className="h-8 w-8">
                                  <AvatarImage src={u.avatar_url || undefined} />
                                  <AvatarFallback className="bg-muted text-muted-foreground font-medium text-xs">{getInitials(u.full_name)}</AvatarFallback>
                                </Avatar>
                                {isOnline(u.id) && <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-success border-2 border-background" />}
                              </div>
                              <div className="min-w-0">
                                <p className="font-medium text-foreground truncate max-w-[180px] flex items-center gap-1">
                                  {u.full_name}
                                  {u.verified && <BadgeCheck className="h-3.5 w-3.5 text-primary fill-primary/20 shrink-0" />}
                                </p>
                                <p className="text-xs text-muted-foreground truncate max-w-[180px]">{u.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground text-xs">{u.phone}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {u.roles.slice(0, 3).map(r => (
                                <span key={r} className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground capitalize">
                                  {r}
                                </span>
                              ))}
                              {u.roles.length > 3 && (
                                <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                                  +{u.roles.length - 3}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            {u.verified ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-success/10 text-success border border-success/20">
                                <CheckCircle className="h-3 w-3" /> Verified
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-warning/10 text-warning border border-warning/20">
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground text-xs">
                            {u.average_rating ? (
                              <span className="flex items-center gap-0.5">
                                <Star className="h-3 w-3 fill-warning text-warning" />
                                {u.average_rating.toFixed(1)}
                              </span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={cn("text-xs", isOnline(u.id) ? "text-success font-medium" : "text-muted-foreground")}>
                              {isOnline(u.id) ? 'Online' : formatLastActive(u.last_active_at)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground text-xs">
                            {format(new Date(u.created_at), 'dd MMM yyyy')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-border">
              {displayUsers.map((u) => (
                <div
                  key={u.id}
                  onClick={() => handleUserClick(u)}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3.5 hover:bg-muted/50 active:bg-muted transition-colors cursor-pointer touch-manipulation min-h-[72px]",
                    selectedUserIds.has(u.id) && "bg-primary/5"
                  )}
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <div className="relative shrink-0" onClick={(e) => toggleUserSelection(u.id, e)}>
                    {selectedUserIds.has(u.id) ? (
                      <div className="h-12 w-12 rounded-full bg-primary flex items-center justify-center">
                        <CheckCircle className="h-6 w-6 text-primary-foreground" />
                      </div>
                    ) : (
                      <>
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={u.avatar_url || undefined} />
                          <AvatarFallback className="bg-muted text-muted-foreground font-medium text-sm">{getInitials(u.full_name)}</AvatarFallback>
                        </Avatar>
                        {isOnline(u.id) && <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-success border-2 border-background" />}
                      </>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium text-foreground truncate flex items-center gap-1">
                        {u.full_name}
                        {u.verified && <BadgeCheck className="h-3.5 w-3.5 text-primary fill-primary/20 shrink-0" />}
                      </h3>
                      <span className={cn("text-xs shrink-0", isOnline(u.id) ? "text-success" : "text-muted-foreground")}>{formatLastActive(u.last_active_at)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-0.5">
                      <p className="text-sm text-muted-foreground truncate">{getStatusText(u)}</p>
                      {u.average_rating && (
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5 shrink-0">
                          <Star className="h-3 w-3 fill-warning text-warning" />
                          {u.average_rating.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Infinite scroll sentinel */}
        <div ref={sentinelRef} className="py-4 flex justify-center">
          {loadingMore && (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading more...
            </div>
          )}
          {!hasMore && displayUsers.length > 0 && (
            <p className="text-xs text-muted-foreground">Showing all {displayUsers.length.toLocaleString()} users</p>
          )}
        </div>

        <div className="h-20" />
      </div>

      {/* Filter Sheet */}
      <Sheet open={showFilters} onOpenChange={setShowFilters}>
        <SheetContent side="bottom" className="h-[70vh] rounded-t-3xl">
          <SheetHeader className="pb-4"><SheetTitle>Filters & Sort</SheetTitle></SheetHeader>
          <div className="space-y-6">
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Verification Status</h4>
              <div className="flex gap-2 flex-wrap">
                {([{ value: 'all' as VerificationFilter, label: 'All' }, { value: 'verified' as VerificationFilter, label: '✓ Verified' }, { value: 'pending' as VerificationFilter, label: '⏳ Pending' }]).map((f) => (
                  <button key={f.value} onClick={() => setVerificationFilter(f.value)} className={cn("px-4 py-3 rounded-xl text-sm font-medium transition-all", verificationFilter === f.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{f.label}</button>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">Sort By</h4>
              <div className="grid grid-cols-2 gap-2">
                {sortOptions.map((o) => (
                  <button key={o.value} onClick={() => setSortBy(o.value)} className={cn("px-4 py-3 rounded-xl text-sm font-medium transition-all", sortBy === o.value ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>{o.label}</button>
                ))}
              </div>
            </div>
            <Button onClick={() => setShowFilters(false)} className="w-full h-14 text-base font-semibold">Apply Filters</Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Dialogs */}
      <UserDetailsDialog open={dialogOpen} onOpenChange={setDialogOpen} user={selectedUser} onRolesUpdated={handleRefresh} onUserDeleted={handleRefresh} onUserUpdated={handleRefresh} canAdjustBalance={false} />
      
      <BulkAssignRoleDialog open={bulkAssignRoleOpen} onOpenChange={setBulkAssignRoleOpen} selectedUserIds={Array.from(selectedUserIds)} onSuccess={() => { clearSelection(); handleRefresh(); }} />
      <BulkRemoveRoleDialog open={bulkRemoveRoleOpen} onOpenChange={setBulkRemoveRoleOpen} selectedUserIds={Array.from(selectedUserIds)} onSuccess={() => { clearSelection(); handleRefresh(); }} />
      <BulkSetDefaultRoleDialog open={bulkSetDefaultRoleOpen} onOpenChange={setBulkSetDefaultRoleOpen} selectedUserIds={Array.from(selectedUserIds)} onSuccess={() => { clearSelection(); handleRefresh(); }} />
      <BulkWhatsAppDialog open={bulkWhatsAppOpen} onOpenChange={setBulkWhatsAppOpen} selectedUsers={getSelectedUsers().map(u => ({ id: u.id, full_name: u.full_name, phone: u.phone, avatar_url: u.avatar_url }))} />
      <CreateUserInviteDialog open={addUserOpen} onOpenChange={setAddUserOpen} />
      <InactiveUsersReachOutDialog open={reachOutInactiveOpen} onOpenChange={setReachOutInactiveOpen} inactiveUsers={getSelectedUsers().filter(u => isUserInactive(u.last_active_at)).map(u => ({ id: u.id, full_name: u.full_name, phone: u.phone, avatar_url: u.avatar_url, last_active_at: u.last_active_at }))} />
      <ScrollToTopButton scrollThreshold={3200} />
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useOffline } from '@/contexts/OfflineContext';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  Users, 
  FileText, 
  Banknote, 
  Receipt,
  TrendingUp,
  ArrowRight,
  ShoppingCart,
  CheckCircle,
  Clock,
  ChartBar,
  Award,
  Wallet,
  Download,
  Shield,
  AlertTriangle,
  ArrowDownToLine,
  Home
} from 'lucide-react';
// jsPDF loaded dynamically when needed
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { format, startOfMonth, isToday, isThisWeek } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';
import DashboardHeader from '@/components/DashboardHeader';

import { useProfile } from '@/hooks/useProfile';
import { ManagerDashboardSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { FloatingActionButton } from '@/components/FloatingActionButton';
import { FloatingDepositsWidget } from '@/components/manager/FloatingDepositsWidget';
// DailyReportMetrics moved to menu — not part of wallet balance management
// FloatingShareButton moved to global FloatingToolbar
import { CreateUserInviteDialog } from '@/components/manager/CreateUserInviteDialog';
// PendingInvestmentRequestsWidget removed — not part of rent management core
import FundFlowTracker from '@/components/manager/FundFlowTracker';
import { SupporterPoolBalanceCard } from '@/components/manager/SupporterPoolBalanceCard';
import { ApprovedRequestsFundingWidget } from '@/components/manager/ApprovedRequestsFundingWidget';
import { SupporterROITrigger } from '@/components/manager/SupporterROITrigger';
import UserDetailsDialog from '@/components/manager/UserDetailsDialog';
import BulkRemoveRoleDialog from '@/components/manager/BulkRemoveRoleDialog';
// MobileManagerMenu now integrated into MobileBottomNav
import { WithdrawalRequestsManager } from '@/components/manager/WithdrawalRequestsManager';
import { CollapsibleAgentSection } from '@/components/agent/CollapsibleAgentSection';
import { usePresence } from '@/hooks/usePresence';
import { useDuplicatePhoneUsers } from '@/hooks/useDuplicatePhoneUsers';
import { DuplicatePhoneUsersSheet } from '@/components/manager/DuplicatePhoneUsersSheet';
import { OpportunitySummaryForm } from '@/components/manager/OpportunitySummaryForm';
import { PendingRentRequestsWidget } from '@/components/manager/PendingRentRequestsWidget';
import { PendingSellerApplicationsWidget } from '@/components/manager/PendingSellerApplicationsWidget';
import { CollapsibleRentRequests } from '@/components/agent/CollapsibleRentRequests';
import { RentDueReceivablesWidget } from '@/components/rent/RentDueReceivablesWidget';
import { ManagerLedgerSummary } from '@/components/manager/ManagerLedgerSummary';
import { ManagerDepositsWidget } from '@/components/manager/ManagerDepositsWidget';
import { DepositRentAuditWidget } from '@/components/manager/DepositRentAuditWidget';
// FinancialStatementsPanel moved to menu
import { BufferAccountPanel } from '@/components/manager/BufferAccountPanel';
import { PendingWalletOperationsWidget } from '@/components/manager/PendingWalletOperationsWidget';
import { ManagerHubCards } from '@/components/manager/ManagerHubCards';
import { ManagerKPIStrip } from '@/components/manager/ManagerKPIStrip';
import { ManagerSectionHeader } from '@/components/manager/ManagerSectionHeader';
import { SubscriptionMonitorWidget } from '@/components/manager/SubscriptionMonitorWidget';
import { PasswordResetGuide } from '@/components/manager/PasswordResetGuide';
import { AgentEarningsOverview } from '@/components/manager/AgentEarningsOverview';
import { AgentCollectionsWidget } from '@/components/manager/AgentCollectionsWidget';
import { DesktopManagerSidebar } from '@/components/manager/DesktopManagerSidebar';
import { QuickUserLookup } from '@/components/manager/QuickUserLookup';
import { useIsMobile } from '@/hooks/use-mobile';

interface ManagerDashboardProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

const MANAGER_ACCESS_CODE = 'Manager@welile';

export default function ManagerDashboard({ user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent }: ManagerDashboardProps) {
  const navigate = useNavigate();
  const { profile } = useProfile();
  const isMobile = useIsMobile();
  const { isOnline } = useOffline();
  const { onlineUsers, isOnline: isUserOnline } = usePresence();
  const { duplicateUserIds, duplicateCount, duplicateGroups } = useDuplicatePhoneUsers();
  const [duplicatePhoneSheetOpen, setDuplicatePhoneSheetOpen] = useState(false);
  const [showOpportunitySummary, setShowOpportunitySummary] = useState(false);
  const [activeHub, setActiveHub] = useState<'home' | 'wallets' | 'rent-investments' | 'buffer'>('home');
  const [loading, setLoading] = useState(true);
  const [hasCachedData, setHasCachedData] = useState(false);
  // Auto-verify if manager already authenticated via /manager-login PIN flow
  const [accessVerified, setAccessVerified] = useState(() => {
    return localStorage.getItem('manager_access_verified') === 'true';
  });
  const [accessCodeInput, setAccessCodeInput] = useState('');
  const [accessError, setAccessError] = useState(false);

  const handleAccessCodeSubmit = () => {
    if (accessCodeInput === MANAGER_ACCESS_CODE) {
      setAccessVerified(true);
      localStorage.setItem('manager_access_verified', 'true');
      setAccessError(false);
    } else {
      setAccessError(true);
      toast.error('Invalid access code');
    }
  };
  const [createUserInviteOpen, setCreateUserInviteOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{
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
  } | null>(null);
  const [pendingRequests, setPendingRequests] = useState(0);
  const [totalUsers, setTotalUsers] = useState(0);
  const [totalFacilitated, setTotalFacilitated] = useState(0);
  const [pendingOrders, setPendingOrders] = useState(0);
  const [pendingLoans, setPendingLoans] = useState(0);
  const [activeUsers, setActiveUsers] = useState(0);
  const [newSignupsThisWeek, setNewSignupsThisWeek] = useState(0);
  const [topOnboarders, setTopOnboarders] = useState<{
    id: string;
    full_name: string;
    email: string;
    phone: string;
    avatar_url: string | null;
    referral_count: number;
    roles?: string[];
    created_at?: string;
    updated_at?: string;
  }[]>([]);
  const [productivityFilter, setProductivityFilter] = useState<'week' | 'month' | 'all' | 'custom'>('all');
  const [customDateRange, setCustomDateRange] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
  const [trendData, setTrendData] = useState<{ date: string; count: number }[]>([]);
  const [periodComparison, setPeriodComparison] = useState<{
    currentTotal: number;
    previousTotal: number;
    percentChange: number;
    currentRecruiters: number;
    previousRecruiters: number;
    recruitersChange: number;
  } | null>(null);
  const [monthlyTarget, setMonthlyTarget] = useState<number | null>(null);
  const [monthlyProgress, setMonthlyProgress] = useState(0);
  const [isEditingTarget, setIsEditingTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [showTargetHistory, setShowTargetHistory] = useState(false);
  const [targetHistory, setTargetHistory] = useState<{
    month: string;
    target: number;
    actual: number;
    achieved: boolean;
  }[]>([]);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [bulkRoleDialogOpen, setBulkRoleDialogOpen] = useState(false);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkRemoveRoleDialogOpen, setBulkRemoveRoleDialogOpen] = useState(false);
  const [selectedBulkRole, setSelectedBulkRole] = useState<AppRole | ''>('');
  const [whatsAppDialogOpen, setWhatsAppDialogOpen] = useState(false);
  const [whatsAppMessage, setWhatsAppMessage] = useState('Hello! This is a message from Welile.');
  const [savedTemplates, setSavedTemplates] = useState<{ id: string; name: string; message: string }[]>(() => {
    const stored = localStorage.getItem('whatsapp-templates');
    return stored ? JSON.parse(stored) : [
      { id: '1', name: 'Welcome', message: 'Hello! Welcome to Welile. We are excited to have you on board!' },
      { id: '2', name: 'Reminder', message: 'Hi! This is a friendly reminder from Welile. Please check your dashboard for updates.' },
    ];
  });
  const [newTemplateName, setNewTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSortBy, setUserSortBy] = useState<'name' | 'referrals' | 'newest' | 'oldest' | 'last_active'>('referrals');
  const [activityFilter, setActivityFilter] = useState<'all' | 'today' | 'week' | 'inactive'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [usersPerPage, setUsersPerPage] = useState(10);
  const [withdrawalStats, setWithdrawalStats] = useState<{ pending: number; approved: number; rejected: number; pendingAmount: number; approvedAmount: number; rejectedAmount: number }>({ pending: 0, approved: 0, rejected: 0, pendingAmount: 0, approvedAmount: 0, rejectedAmount: 0 });
  const [withdrawalSectionOpen, setWithdrawalSectionOpen] = useState(false);
  const [depositSectionOpen, setDepositSectionOpen] = useState(true);
  const [rentDueSectionOpen, setRentDueSectionOpen] = useState(false);
  const [rentDueTotal, setRentDueTotal] = useState(0);
  const withdrawalSectionRef = useRef<HTMLDivElement>(null);
  const rentDueSectionRef = useRef<HTMLDivElement>(null);

  // Compute online users from topOnboarders list
  const activeOnlineUsers = topOnboarders.filter(u => isUserOnline(u.id)).map(u => ({
    id: u.id,
    full_name: u.full_name,
    avatar_url: u.avatar_url,
    roles: u.roles || [],
  }));

  // Helper to get activity status
  const getActivityStatus = (updatedAt?: string): 'today' | 'week' | 'inactive' => {
    if (!updatedAt) return 'inactive';
    const lastActive = new Date(updatedAt);
    if (isToday(lastActive)) return 'today';
    if (isThisWeek(lastActive, { weekStartsOn: 1 })) return 'week';
    return 'inactive';
  };

  // Filter and sort users
  const filteredOnboarders = topOnboarders
    .filter(user => user.full_name.toLowerCase().includes(userSearchQuery.toLowerCase()))
    .filter(user => {
      if (activityFilter === 'all') return true;
      return getActivityStatus(user.updated_at) === activityFilter;
    })
    .sort((a, b) => {
      switch (userSortBy) {
        case 'name':
          return a.full_name.localeCompare(b.full_name);
        case 'referrals':
          return b.referral_count - a.referral_count;
        case 'newest':
          return (b.created_at || '').localeCompare(a.created_at || '');
        case 'oldest':
          return (a.created_at || '').localeCompare(b.created_at || '');
        case 'last_active':
          return (b.updated_at || '').localeCompare(a.updated_at || '');
        default:
          return 0;
      }
    });

  // Pagination calculations
  const totalPages = Math.ceil(filteredOnboarders.length / usersPerPage);
  const paginatedOnboarders = filteredOnboarders.slice(
    (currentPage - 1) * usersPerPage,
    currentPage * usersPerPage
  );

  // Reset to page 1 when search/sort changes
  const handleSearchChange = (value: string) => {
    setUserSearchQuery(value);
    setCurrentPage(1);
  };

  const handleSortChange = (value: typeof userSortBy) => {
    setUserSortBy(value);
    setCurrentPage(1);
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = () => {
    if (selectedUserIds.size === filteredOnboarders.length) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(filteredOnboarders.map(o => o.id)));
    }
  };

  const handleBulkDelete = async () => {
    setBulkActionLoading(true);
    try {
      const userIds = Array.from(selectedUserIds);
      
      // Delete roles for all selected users
      await supabase.from('user_roles').delete().in('user_id', userIds);
      
      // Delete profiles for all selected users (wallets cleaned up by cascade/triggers)
      const { error } = await supabase.from('profiles').delete().in('id', userIds);
      
      if (error) throw error;
      
      toast.success(`${userIds.length} users deleted successfully`);
      setSelectedUserIds(new Set());
      setBulkDeleteDialogOpen(false);
      fetchProductivityData();
    } catch (error) {
      console.error('Error bulk deleting users:', error);
      toast.error('Failed to delete users');
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkAssignRole = async () => {
    if (!selectedBulkRole) {
      toast.error('Please select a role');
      return;
    }
    
    setBulkActionLoading(true);
    try {
      const userIds = Array.from(selectedUserIds);
      
      // Insert roles for all selected users (ignore conflicts)
      for (const userId of userIds) {
        await supabase.from('user_roles').upsert(
          { user_id: userId, role: selectedBulkRole },
          { onConflict: 'user_id,role' }
        );
      }
      
      toast.success(`Role "${selectedBulkRole}" assigned to ${userIds.length} users`);
      setSelectedUserIds(new Set());
      setBulkRoleDialogOpen(false);
      setSelectedBulkRole('');
      fetchProductivityData();
    } catch (error) {
      console.error('Error assigning roles:', error);
      toast.error('Failed to assign roles');
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleQuickDeleteUser = async (userId: string, userName: string) => {
    setDeletingUserId(userId);
    try {
      // Delete user roles
      await supabase.from('user_roles').delete().eq('user_id', userId);
      
      // Delete user profile (wallets cleaned up by cascade/triggers)
      const { error } = await supabase.from('profiles').delete().eq('id', userId);
      
      if (error) throw error;
      
      toast.success(`${userName} has been deleted`);
      
      // Refresh the list
      fetchProductivityData();
    } catch (error) {
      console.error('Error deleting user:', error);
      toast.error('Failed to delete user');
    } finally {
      setDeletingUserId(null);
    }
  };

  // Load cached data first for offline support
  useEffect(() => {
    const cached = localStorage.getItem(`manager_dashboard_${user.id}`);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        setPendingRequests(data.pendingRequests ?? 0);
        setTotalUsers(data.totalUsers ?? 0);
        setTotalFacilitated(data.totalFacilitated ?? 0);
        setPendingOrders(data.pendingOrders ?? 0);
        setPendingLoans(data.pendingLoans ?? 0);
        setActiveUsers(data.activeUsers ?? 0);
        setNewSignupsThisWeek(data.newSignupsThisWeek ?? 0);
        setHasCachedData(true);
      } catch (e) {
        console.warn('[ManagerDashboard] Failed to load cached data');
      }
    }
  }, [user.id]);

  // Fetch rent due total independently so hub cards show it without opening the section
  const fetchRentDueTotal = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('total_repayment, amount_repaid')
        .eq('status', 'approved');

      if (!error && data) {
        const total = data.reduce((sum: number, r: any) => 
          sum + Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0)), 0
        );
        setRentDueTotal(total);
      }
    } catch (err) {
      console.error('Error fetching rent due total:', err);
    }
  }, []);

  // Run ALL initial data fetches in parallel with 8s timeout
  useEffect(() => {
    const timeout = setTimeout(() => {
      // Force-stop loading after 8s so dashboard is usable
      setLoading(false);
    }, 8000);

    Promise.all([
      fetchData(),
      fetchMonthlyTarget(),
      fetchProductivityData(),
      fetchRentDueTotal()
    ]).catch(console.error).finally(() => clearTimeout(timeout));

    // Re-fetch rent due total when a rent request is deleted
    const handler = () => fetchRentDueTotal();
    window.addEventListener('user-deleted', handler);
    return () => window.removeEventListener('user-deleted', handler);
  }, []);

  // Re-fetch productivity when filter changes (after initial load)
  useEffect(() => {
    if (productivityFilter !== 'custom' || (customDateRange.start && customDateRange.end)) {
      fetchProductivityData();
    }
  }, [productivityFilter, customDateRange]);

  const fetchProductivityData = async () => {
    try {
      const customStart = productivityFilter === 'custom' && customDateRange.start ? customDateRange.start.toISOString() : null;
      const customEnd = productivityFilter === 'custom' && customDateRange.end ? new Date(customDateRange.end.getTime()).toISOString() : null;

      const { data, error } = await supabase.rpc('get_manager_productivity', {
        p_filter: productivityFilter,
        p_custom_start: customStart,
        p_custom_end: customEnd
      });

      if (error) {
        console.error('[ManagerDashboard] Productivity RPC error:', error);
        return;
      }

      const result = data as {
        onboarders: { id: string; full_name: string; email: string; phone: string; avatar_url: string | null; created_at: string; updated_at: string; referral_count: number; roles: string[] }[];
        current_total: number;
        previous_total: number;
        previous_recruiters: number;
        trend_data: { date: string; count: number }[];
      };

      setTopOnboarders(result.onboarders || []);
      setTrendData(result.trend_data || []);

      const currentTotal = result.current_total || 0;
      const activeRecruiters = (result.onboarders || []).filter(o => o.referral_count > 0).length;
      const prevTotal = result.previous_total || 0;
      const prevRecruiters = result.previous_recruiters || 0;

      if (prevTotal > 0 || currentTotal > 0) {
        setPeriodComparison({
          currentTotal,
          previousTotal: prevTotal,
          percentChange: prevTotal > 0 ? Math.round(((currentTotal - prevTotal) / prevTotal) * 100) : (currentTotal > 0 ? 100 : 0),
          currentRecruiters: activeRecruiters,
          previousRecruiters: prevRecruiters,
          recruitersChange: prevRecruiters > 0 ? Math.round(((activeRecruiters - prevRecruiters) / prevRecruiters) * 100) : (activeRecruiters > 0 ? 100 : 0)
        });
      } else {
        setPeriodComparison(null);
      }
    } catch (err) {
      console.error('[ManagerDashboard] fetchProductivityData error:', err);
    }
  };

  const fetchMonthlyTarget = async () => {
    const monthStart = startOfMonth(new Date()).toISOString();
    
    // onboarding_targets table removed - use local state only
    const countRes = await supabase
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', monthStart);
    
    setMonthlyProgress(countRes.count || 0);
  };

  const handleSaveTarget = async () => {
    const targetValue = parseInt(targetInput);
    if (isNaN(targetValue) || targetValue <= 0) {
      toast.error('Please enter a valid target number');
      return;
    }
    // onboarding_targets table removed - use local state only
    setMonthlyTarget(targetValue);
    setIsEditingTarget(false);
    toast.success('Monthly target updated!');
  };

  const fetchTargetHistory = async () => {
    // onboarding_targets table removed
    setTargetHistory([]);
  };

  const toggleTargetHistory = () => {
    if (!showTargetHistory) {
      fetchTargetHistory();
    }
    setShowTargetHistory(!showTargetHistory);
  };

  const fetchData = async () => {
    // Skip network fetch if offline and we have cached data
    if (!navigator.onLine && hasCachedData) {
      setLoading(false);
      return;
    }
    
    // Don't reset loading to true if we have cached data — show cache first
    if (!hasCachedData) {
      setLoading(true);
    }
    
    try {
      // Single RPC call replaces 7 parallel queries — much faster on mobile
      const { data, error } = await supabase.rpc('get_manager_dashboard_stats');
      
      if (error) {
        console.error('[ManagerDashboard] Stats RPC error:', error);
        setLoading(false);
        return;
      }

      const stats = data as {
        pending_requests: number;
        total_facilitated: number;
        total_users: number;
        active_users: number;
        new_signups_this_week: number;
        pending_orders: number;
        pending_loans: number;
      };
      
      setPendingRequests(stats.pending_requests);
      setTotalFacilitated(stats.total_facilitated);
      setTotalUsers(stats.total_users);
      setActiveUsers(stats.active_users);
      setNewSignupsThisWeek(stats.new_signups_this_week);
      setPendingOrders(stats.pending_orders);
      setPendingLoans(stats.pending_loans);
      
      // Cache the data for offline use
      localStorage.setItem(`manager_dashboard_${user.id}`, JSON.stringify({
        pendingRequests: stats.pending_requests,
        totalFacilitated: stats.total_facilitated,
        totalUsers: stats.total_users,
        activeUsers: stats.active_users,
        newSignupsThisWeek: stats.new_signups_this_week,
        pendingOrders: stats.pending_orders,
        pendingLoans: stats.pending_loans,
        timestamp: Date.now()
      }));
      setHasCachedData(true);
    } catch (error) {
      console.error('[ManagerDashboard] Error fetching data:', error);
    }
    
    // Fetch withdrawal stats
    try {
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data: wdData } = await supabase
        .from('withdrawal_requests')
        .select('status, amount, created_at');
      if (wdData) {
        const wdStats = { pending: 0, approved: 0, rejected: 0, pendingAmount: 0, approvedAmount: 0, rejectedAmount: 0 };
        wdData.forEach((r: any) => {
          // Skip pending requests older than 12 hours
          if (r.status === 'pending' && r.created_at < twelveHoursAgo) return;
          if (r.status === 'pending') { wdStats.pending++; wdStats.pendingAmount += Number(r.amount); }
          else if (r.status === 'approved') { wdStats.approved++; wdStats.approvedAmount += Number(r.amount); }
          else if (r.status === 'rejected') { wdStats.rejected++; wdStats.rejectedAmount += Number(r.amount); }
        });
        setWithdrawalStats(wdStats);
      }
    } catch (e) {
      console.error('[ManagerDashboard] withdrawal stats error:', e);
    }
    
    setLoading(false);
  };

  const handleSelectOnboarder = async (userId: string) => {
    // Fetch full user details including roles and ratings
    // Only fetch profiles + roles (core), stub ratings to reduce DB calls
    const [profileRes, rolesRes] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('user_roles').select('role').eq('user_id', userId),
    ]);

    if (profileRes.data) {
      const roles = (rolesRes.data || []).map(r => r.role);
      const avgRating: number | null = null;

      setSelectedUser({
        id: profileRes.data.id,
        full_name: profileRes.data.full_name,
        email: profileRes.data.email,
        phone: profileRes.data.phone,
        avatar_url: profileRes.data.avatar_url,
        rent_discount_active: profileRes.data.rent_discount_active,
        monthly_rent: profileRes.data.monthly_rent,
        roles,
        average_rating: avgRating,
        rating_count: 0
      });
    }
  };

  const getFilterLabel = () => {
    switch (productivityFilter) {
      case 'week': return 'This Week';
      case 'month': return 'This Month';
      default: return 'All Time';
    }
  };

  const exportToCSV = () => {
    if (filteredOnboarders.length === 0) {
      toast.error('No data to export');
      return;
    }

    const headers = ['Rank', 'Name', 'Email', 'Phone', 'Roles', 'Users Onboarded', 'Last Active'];
    const rows = filteredOnboarders.map((o, i) => [
      i + 1,
      `"${o.full_name}"`,
      `"${o.email}"`,
      `"${o.phone}"`,
      `"${o.roles?.join(', ') || 'No role'}"`,
      o.referral_count,
      o.updated_at ? format(new Date(o.updated_at), 'yyyy-MM-dd HH:mm') : 'N/A'
    ]);

    const filterInfo = userSearchQuery ? ` (filtered by "${userSearchQuery}")` : '';
    const sortInfo = userSortBy === 'referrals' ? 'Most Referrals' : 
                     userSortBy === 'name' ? 'Name (A-Z)' : 
                     userSortBy === 'newest' ? 'Newest First' :
                     userSortBy === 'oldest' ? 'Oldest First' :
                     userSortBy === 'last_active' ? 'Recently Active' : '';

    const csvContent = [
      `User Productivity Report - ${getFilterLabel()}${filterInfo}`,
      `Sorted by: ${sortInfo}`,
      `Generated: ${new Date().toLocaleDateString()}`,
      `Total Users: ${filteredOnboarders.length}`,
      '',
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `user-productivity-${productivityFilter}-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${filteredOnboarders.length} users to CSV`);
  };

  const exportToPDF = async () => {
    if (filteredOnboarders.length === 0) {
      toast.error('No data to export');
      return;
    }

    const { default: jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    
    // Title
    doc.setFontSize(20);
    doc.setFont('helvetica', 'bold');
    doc.text('User Productivity Report', pageWidth / 2, 20, { align: 'center' });
    
    // Subtitle
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${getFilterLabel()}`, pageWidth / 2, 30, { align: 'center' });
    if (userSearchQuery) {
      doc.text(`Filter: "${userSearchQuery}"`, pageWidth / 2, 38, { align: 'center' });
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageWidth / 2, 46, { align: 'center' });
    } else {
      doc.text(`Generated: ${new Date().toLocaleDateString()}`, pageWidth / 2, 38, { align: 'center' });
    }
    
    // Summary stats
    const summaryY = userSearchQuery ? 60 : 52;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', 20, summaryY);
    
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    const totalOnboarded = filteredOnboarders.reduce((sum, o) => sum + o.referral_count, 0);
    doc.text(`Total Users Onboarded: ${totalOnboarded}`, 20, summaryY + 10);
    doc.text(`Users in Report: ${filteredOnboarders.length}`, 20, summaryY + 18);
    
    // Leaderboard table
    const tableStartY = summaryY + 35;
    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('User List', 20, tableStartY);
    
    // Table header
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Rank', 20, tableStartY + 10);
    doc.text('Name', 35, tableStartY + 10);
    doc.text('Roles', 95, tableStartY + 10);
    doc.text('Referrals', 145, tableStartY + 10);
    doc.text('Last Active', 170, tableStartY + 10);
    
    // Table line
    doc.setDrawColor(200);
    doc.line(20, tableStartY + 13, 190, tableStartY + 13);
    
    // Table rows (limit to prevent overflow)
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const maxRows = Math.min(filteredOnboarders.length, 25);
    filteredOnboarders.slice(0, maxRows).forEach((onboarder, index) => {
      const y = tableStartY + 20 + (index * 8);
      const medal = index === 0 ? '1st' : index === 1 ? '2nd' : index === 2 ? '3rd' : `${index + 1}`;
      doc.text(medal, 20, y);
      doc.text(onboarder.full_name.substring(0, 25), 35, y);
      doc.text((onboarder.roles?.slice(0, 2).join(', ') || 'No role').substring(0, 20), 95, y);
      doc.text(String(onboarder.referral_count), 145, y);
      doc.text(onboarder.updated_at ? format(new Date(onboarder.updated_at), 'MMM d') : 'N/A', 170, y);
    });
    
    if (filteredOnboarders.length > maxRows) {
      doc.setFontSize(9);
      doc.setTextColor(100);
      doc.text(`... and ${filteredOnboarders.length - maxRows} more users`, 20, tableStartY + 20 + (maxRows * 8) + 5);
    }
    
    // Footer
    doc.setFontSize(8);
    doc.setTextColor(128);
    doc.text('Welile Platform - User Productivity Report', pageWidth / 2, 280, { align: 'center' });
    
    doc.save(`user-productivity-${productivityFilter}-${new Date().toISOString().split('T')[0]}.pdf`);
    toast.success(`Exported ${filteredOnboarders.length} users to PDF`);
  };

  // Access code gate - show BEFORE loading check
  if (!accessVerified) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 space-y-6">
            <div className="text-center space-y-2">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Shield className="h-8 w-8 text-primary" />
              </div>
              <h2 className="text-2xl font-bold">Manager Access</h2>
              <p className="text-muted-foreground">
                Enter the manager access code to view the dashboard
              </p>
            </div>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <Input
                  type="password"
                  placeholder="Enter access code"
                  value={accessCodeInput}
                  onChange={(e) => {
                    setAccessCodeInput(e.target.value);
                    setAccessError(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleAccessCodeSubmit();
                    }
                  }}
                  className={accessError ? 'border-destructive' : ''}
                />
                {accessError && (
                  <p className="text-sm text-destructive">Invalid access code. Please try again.</p>
                )}
              </div>
              
              <Button 
                onClick={handleAccessCodeSubmit} 
                className="w-full"
                size="lg"
              >
                Access Dashboard
              </Button>
              
              <Button 
                variant="ghost" 
                className="w-full"
                onClick={() => onRoleChange(availableRoles.find(r => r !== 'manager') || 'tenant')}
              >
                Switch to Another Role
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Only show skeleton if loading AND online AND no cached data
  if (loading && isOnline && !hasCachedData) {
    return <ManagerDashboardSkeleton />;
  }

  const scrollToProductivity = () => {
    const element = document.getElementById('productivity-section');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const menuItems = [
    { icon: Award, label: 'Productivity', onClick: scrollToProductivity },
    { icon: FileText, label: 'Rent Requests', onClick: () => navigate('/manager-access') },
    { icon: Banknote, label: 'Rent Plans', onClick: () => navigate('/manager-access?tab=loans') },
    { icon: ShoppingCart, label: 'Product Orders', onClick: () => navigate('/manager-access?tab=orders') },
    { icon: Users, label: 'User Management', onClick: () => navigate('/manager-access?tab=users'), separator: true },
    { icon: Receipt, label: 'Receipt Management', onClick: () => navigate('/manager-access?tab=receipts') },
    { icon: ChartBar, label: 'Financial Overview', onClick: () => navigate('/manager-access?tab=financials') },
    { icon: FileText, label: 'General Ledger', onClick: () => navigate('/manager-access?tab=ledger') },
    { icon: Wallet, label: 'Investment Accounts', onClick: () => navigate('/manager-access?tab=investments') },
    { icon: Receipt, label: 'My Receipts', onClick: () => navigate('/my-receipts'), separator: true },
    { icon: Banknote, label: 'My Loans', onClick: () => navigate('/my-loans') },
    { icon: Banknote, label: 'Agent Advance', onClick: () => navigate('/agent-advances') },
    { icon: Download, label: 'Share App', onClick: () => navigate('/install') },
  ];

  return (
    <div className="min-h-screen bg-background pb-20 lg:pb-0">
      <DashboardHeader
        currentRole={currentRole}
        availableRoles={availableRoles}
        onRoleChange={onRoleChange}
        onSignOut={signOut}
        menuItems={menuItems}
      />

      <div className="flex">
        {/* Desktop Sidebar */}
        <DesktopManagerSidebar
          activeHub={activeHub}
          onHubChange={(hub) => { hapticTap(); setActiveHub(hub); }}
          onScrollToProductivity={scrollToProductivity}
        />

        <main className="flex-1 px-3 py-3 space-y-3 animate-fade-in max-w-4xl mx-auto lg:px-6 lg:py-6 lg:space-y-4 min-w-0 overflow-hidden">
        {/* Opportunity Summary Form - Full page when open */}
        {showOpportunitySummary ? (
          <OpportunitySummaryForm onClose={() => setShowOpportunitySummary(false)} />
        ) : activeHub === 'home' ? (
        <>
        {/* KPI Summary Strip */}
        <ManagerKPIStrip
          totalUsers={totalUsers}
          activeUsers={activeUsers}
          newSignupsThisWeek={newSignupsThisWeek}
          totalFacilitated={totalFacilitated}
          pendingActions={pendingRequests + withdrawalStats.pending}
          rentDueTotal={rentDueTotal}
          onNavigate={(hub) => { hapticTap(); setActiveHub(hub as any); }}
        />

        {/* Quick User Lookup by Phone */}
        <QuickUserLookup
          onUserFound={(user) => {
            setSelectedUser({
              id: user.id,
              full_name: user.full_name,
              email: user.email,
              phone: user.phone,
              avatar_url: user.avatar_url,
              rent_discount_active: user.rent_discount_active,
              monthly_rent: user.monthly_rent,
              roles: user.roles,
              average_rating: user.average_rating,
              rating_count: user.rating_count,
            });
          }}
        />

        {/* Opportunity Summary Button */}
        <motion.button
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => setShowOpportunitySummary(true)}
          className="w-full rounded-xl bg-primary text-primary-foreground px-4 py-3 shadow-sm touch-manipulation text-left flex items-center justify-between"
        >
          <div className="flex items-center gap-2.5">
            <TrendingUp className="h-4 w-4 opacity-80" />
            <div>
              <p className="font-semibold text-sm">Post Opportunity Summary</p>
              <p className="text-[10px] opacity-70">Update rent totals for supporters</p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 opacity-50" />
        </motion.button>

        {/* 3 Hub Cards */}
        <ManagerHubCards
          pendingWalletOps={0}
          pendingWithdrawals={withdrawalStats.pending}
          withdrawalStats={withdrawalStats}
          pendingRequests={pendingRequests}
          totalFacilitated={totalFacilitated}
          totalUsers={totalUsers}
          rentDueTotal={rentDueTotal}
          onOpenWallets={() => { hapticTap(); setActiveHub('wallets'); }}
          onOpenRentInvestments={() => { hapticTap(); setActiveHub('rent-investments'); }}
          onOpenBufferAccount={() => { hapticTap(); setActiveHub('buffer'); }}
        />

        {/* Duplicate Phone Alert */}
        {/* Password Reset Instructions */}
        <PasswordResetGuide />

        {duplicateCount > 0 && (
          <Card 
            className="border-destructive/40 bg-destructive/5 cursor-pointer active:scale-[0.98] transition-transform touch-manipulation"
            onClick={() => setDuplicatePhoneSheetOpen(true)}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-destructive/20">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div className="flex-1">
                  <p className="text-lg font-bold text-destructive">{duplicateCount}</p>
                  <p className="text-xs text-muted-foreground">Duplicate Phone Numbers</p>
                </div>
                <Badge variant="destructive" className="shrink-0 text-xs">Fix</Badge>
              </div>
            </CardContent>
          </Card>
        )}

        <DuplicatePhoneUsersSheet
          open={duplicatePhoneSheetOpen}
          onOpenChange={setDuplicatePhoneSheetOpen}
          duplicateGroups={duplicateGroups}
          onUserClick={(userId) => {
            setDuplicatePhoneSheetOpen(false);
            const user = topOnboarders.find(u => u.id === userId);
            if (user) {
              setSelectedUser({
                ...user,
                avatar_url: user.avatar_url,
                rent_discount_active: false,
                monthly_rent: null,
                roles: user.roles || [],
                average_rating: null,
                rating_count: 0,
              });
            }
          }}
        />

        {/* Agent Rent Requests */}
        <CollapsibleRentRequests />

        {/* Pending Seller Applications */}
        <PendingSellerApplicationsWidget />
        </>
        ) : activeHub === 'wallets' ? (
        <>
          <ManagerSectionHeader
            emoji="💰"
            title="Manage Wallets"
            subtitle="Deposits, withdrawals & balance approvals"
            onBack={() => setActiveHub('home')}
          />

          {/* Pending Wallet Approvals */}
          <PendingWalletOperationsWidget />

          {/* Quick Withdrawal Status */}
          <div className="grid grid-cols-3 gap-2">
            <Card 
              className="border-warning/30 bg-warning/5 cursor-pointer active:scale-95 transition-transform touch-manipulation"
              onClick={() => {
                setWithdrawalSectionOpen(true);
                setTimeout(() => withdrawalSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
              }}
            >
              <CardContent className="p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Clock className="h-4 w-4 text-warning" />
                  <span className="text-[10px] font-medium text-warning">Pending</span>
                </div>
                <p className="text-xl font-black text-warning">{withdrawalStats.pending}</p>
                <p className="text-[10px] text-muted-foreground font-medium">{formatUGX(withdrawalStats.pendingAmount)}</p>
              </CardContent>
            </Card>
            <Card 
              className="border-success/30 bg-success/5 cursor-pointer active:scale-95 transition-transform touch-manipulation"
              onClick={() => {
                setWithdrawalSectionOpen(true);
                setTimeout(() => withdrawalSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
              }}
            >
              <CardContent className="p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <CheckCircle className="h-4 w-4 text-success" />
                  <span className="text-[10px] font-medium text-success">Approved</span>
                </div>
                <p className="text-xl font-black text-success">{withdrawalStats.approved}</p>
                <p className="text-[10px] text-muted-foreground font-medium">{formatUGX(withdrawalStats.approvedAmount)}</p>
              </CardContent>
            </Card>
            <Card 
              className="border-destructive/30 bg-destructive/5 cursor-pointer active:scale-95 transition-transform touch-manipulation"
              onClick={() => {
                setWithdrawalSectionOpen(true);
                setTimeout(() => withdrawalSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
              }}
            >
              <CardContent className="p-3 text-center">
                <div className="flex items-center justify-center gap-1 mb-1">
                  <ArrowDownToLine className="h-4 w-4 text-destructive" />
                  <span className="text-[10px] font-medium text-destructive">Rejected</span>
                </div>
                <p className="text-xl font-black text-destructive">{withdrawalStats.rejected}</p>
                <p className="text-[10px] text-muted-foreground font-medium">{formatUGX(withdrawalStats.rejectedAmount)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Deposits */}
          <CollapsibleAgentSection
            icon={Wallet}
            label="Deposits"
            iconColor="text-primary"
            isOpen={depositSectionOpen}
            onToggle={() => setDepositSectionOpen(!depositSectionOpen)}
          >
            <div className="space-y-3">
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={() => navigate('/deposits-management')}
                className="w-full flex items-center justify-between rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-semibold text-primary hover:bg-primary/10 transition-colors touch-manipulation"
              >
                <span className="flex items-center gap-2">
                  <Wallet className="h-4 w-4" />
                  Open Full Deposits Manager
                </span>
                <ArrowRight className="h-4 w-4 opacity-70" />
              </motion.button>
              <ManagerDepositsWidget />
              <DepositRentAuditWidget />
            </div>
          </CollapsibleAgentSection>

          {/* Withdrawal Requests */}
          <div ref={withdrawalSectionRef} id="withdrawal-section">
            <CollapsibleAgentSection
              icon={Wallet}
              label="Wallet Withdrawals"
              iconColor="text-warning"
              isOpen={withdrawalSectionOpen}
              onToggle={() => setWithdrawalSectionOpen(!withdrawalSectionOpen)}
            >
              <WithdrawalRequestsManager />
            </CollapsibleAgentSection>
          </div>

          {/* Ledger Summary */}
          <ManagerLedgerSummary />

          {/* Agent Earnings Overview */}
          <AgentEarningsOverview />
        </>
        ) : activeHub === 'rent-investments' ? (
        <>
          <ManagerSectionHeader
            emoji="🏠"
            title="Rent Management"
            subtitle="Requests, receivables, fund routing & tracking"
            onBack={() => setActiveHub('home')}
            accentClass="text-emerald-700 dark:text-emerald-400"
          />

          {/* Supporter Pool — funds available from supporters */}
          <SupporterPoolBalanceCard />

          {/* Approved Requests — ready to fund from pool */}
          <ApprovedRequestsFundingWidget />

          {/* Pending Rent Requests — action queue */}
          <PendingRentRequestsWidget />

          {/* Rent Due Receivables — what's owed */}
          <div ref={rentDueSectionRef} id="rent-due-section">
            <CollapsibleAgentSection
              icon={Home}
              label="Rent Due (Receivables)"
              iconColor="text-emerald-600"
              isOpen={true}
              onToggle={() => setRentDueSectionOpen(!rentDueSectionOpen)}
            >
              <RentDueReceivablesWidget mode="manager" onTotalChange={setRentDueTotal} />
            </CollapsibleAgentSection>
          </div>

          {/* Agent Field Collections — payments recorded by agents */}
          <AgentCollectionsWidget />

          {/* Fund Flow Tracker — where rent money went & who funded */}
          <FundFlowTracker />

          {/* Supporter ROI Processing — 15% monthly rewards */}
          <SupporterROITrigger />

          {/* Auto-Charge Subscription Monitor */}
          <SubscriptionMonitorWidget />

          {/* Quick nav to full rent requests manager */}
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={() => navigate('/manager-access')}
            className="w-full flex items-center justify-between rounded-xl border border-border/60 bg-muted/30 px-4 py-3.5 text-sm font-semibold text-foreground hover:bg-muted/60 transition-colors touch-manipulation"
          >
            <span className="flex items-center gap-2">
              <Home className="h-5 w-5" />
              Full Rent Requests Manager
            </span>
            <ArrowRight className="h-4 w-4 opacity-70" />
          </motion.button>
        </>
        ) : activeHub === 'buffer' ? (
        <>
          <ManagerSectionHeader
            emoji="🛡️"
            title="Buffer Account"
            subtitle="Platform solvency, coverage ratios & safety"
            onBack={() => setActiveHub('home')}
            accentClass="text-amber-700 dark:text-amber-400"
          />

          <BufferAccountPanel />
        </>
        ) : null}
      </main>
      </div>

      {/* Floating Deposits Widget - mobile only */}
      {isMobile && <FloatingDepositsWidget />}
      
      
      {/* Floating Action Button - mobile only */}
      {isMobile && (
        <FloatingActionButton 
          actions={[
            {
              icon: ChartBar,
              label: 'Financial Dashboard',
              onClick: () => navigate('/manager-access?tab=financials'),
            },
            {
              icon: FileText,
              label: 'Rent Requests',
              onClick: () => navigate('/manager-access?tab=rent-requests'),
            },
            {
              icon: Banknote,
              label: 'Rent Plans',
              onClick: () => navigate('/manager-access?tab=loans'),
            },
            {
              icon: ShoppingCart,
              label: 'Orders',
              onClick: () => navigate('/manager-access?tab=orders'),
            },
            {
              icon: Users,
              label: 'Users',
              onClick: () => navigate('/manager-access?tab=users'),
            },
            {
              icon: Receipt,
              label: 'Receipts',
              onClick: () => navigate('/manager-access?tab=receipts'),
            },
          ]}
        />
      )}
      
      <CreateUserInviteDialog 
        open={createUserInviteOpen} 
        onOpenChange={setCreateUserInviteOpen} 
      />
      
      <UserDetailsDialog
        user={selectedUser}
        open={!!selectedUser}
        onOpenChange={(open) => !open && setSelectedUser(null)}
        onRolesUpdated={() => fetchData()}
      />

      <BulkRemoveRoleDialog
        open={bulkRemoveRoleDialogOpen}
        onOpenChange={setBulkRemoveRoleDialogOpen}
        selectedUserIds={Array.from(selectedUserIds)}
        onSuccess={() => {
          setSelectedUserIds(new Set());
          fetchData();
        }}
      />

      
    </div>
  );
}

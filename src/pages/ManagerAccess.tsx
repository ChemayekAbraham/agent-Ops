import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  ArrowLeft, 
  FileText, 
  Banknote, 
  Users, 
  Receipt, 
  ChartBar,
  ShoppingCart,
  Loader2,
  Search,
  X,
  User,
  Package,
  Filter,
  CalendarIcon,
  Wallet,
  Activity,
  CreditCard,
  BadgeCheck,
  MapPin,
  Landmark,
} from 'lucide-react';
import { RentRequestsManager } from '@/components/manager/RentRequestsManager';
import { LoanApplicationsManager } from '@/components/manager/LoanApplicationsManager';
import UserProfilesTable from '@/components/manager/UserProfilesTable';
import UserCountsSummary from '@/components/manager/UserCountsSummary';
import { ReceiptManagement } from '@/components/manager/ReceiptManagement';
import { FinancialOverview } from '@/components/manager/FinancialOverview';
import { GeneralLedger } from '@/components/manager/GeneralLedger';
import { ManagerBankingLedger } from '@/components/manager/ManagerBankingLedger';
import { OrdersManager } from '@/components/manager/OrdersManager';
import { InvestmentAccountsManager } from '@/components/manager/InvestmentAccountsManager';
import { ManagerInvestmentRequestsSection } from '@/components/manager/ManagerInvestmentRequestsSection';
import { DepositRequestsManager } from '@/components/manager/DepositRequestsManager';
import { ActivityManager } from '@/components/manager/ActivityManager';
import { PaymentConfirmationsManager } from '@/components/manager/PaymentConfirmationsManager';
import { RecordMerchantPayment } from '@/components/manager/RecordMerchantPayment';
import { PaymentProofsManager } from '@/components/manager/PaymentProofsManager';
import FundFlowTracker from '@/components/manager/FundFlowTracker';
import UserLocationsManager from '@/components/manager/UserLocationsManager';
 import LandlordLocationsMap from '@/components/map/LandlordLocationsMap';
import { SupporterROITrigger } from '@/components/manager/SupporterROITrigger';
import { AgentCommissionPayoutsManager } from '@/components/manager/AgentCommissionPayoutsManager';
import { PaidAgentsHistory } from '@/components/manager/PaidAgentsHistory';
import { MonthlyRewardsTrigger } from '@/components/manager/MonthlyRewardsTrigger';
import { WelileHomesSubscriptionsManager } from '@/components/manager/WelileHomesSubscriptionsManager';
import { formatUGX } from '@/lib/rentCalculations';
import { format, startOfDay, endOfDay, subDays, isWithinInterval } from 'date-fns';
import { cn } from '@/lib/utils';
import { Home, Banknote as BanknoteIcon } from 'lucide-react';
import { WelileHomesWithdrawalsManager } from '@/components/manager/WelileHomesWithdrawalsManager';
import ScreenLoader from '@/components/common/ScreenLoader';

interface SearchResult {
  type: 'user' | 'rent_request' | 'order' | 'loan';
  id: string;
  title: string;
  subtitle: string;
  status?: string;
  amount?: number;
  createdAt?: string;
}

type StatusFilter = 'all' | 'pending' | 'approved' | 'funded' | 'rejected' | 'delivered' | 'cancelled' | 'completed';
type DatePreset = 'all' | 'today' | '7days' | '30days' | 'custom';

export default function ManagerAccess() {
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'rent-requests');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [filteredResults, setFilteredResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showFullUserTable, setShowFullUserTable] = useState(false);
  
  // Filter states
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + K to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      // Escape to close results
      if (e.key === 'Escape' && showResults) {
        setShowResults(false);
        searchInputRef.current?.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showResults]);

  useEffect(() => {
    if (!loading && (!user || role !== 'manager')) {
      navigate(roleToSlug(role));
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSearchParams({ tab: value });
    setSearchQuery('');
    setShowResults(false);
  };

  const handleDatePresetChange = (preset: DatePreset) => {
    setDatePreset(preset);
    const now = new Date();
    
    switch (preset) {
      case 'all':
        setStartDate(undefined);
        setEndDate(undefined);
        break;
      case 'today':
        setStartDate(startOfDay(now));
        setEndDate(endOfDay(now));
        break;
      case '7days':
        setStartDate(startOfDay(subDays(now, 7)));
        setEndDate(endOfDay(now));
        break;
      case '30days':
        setStartDate(startOfDay(subDays(now, 30)));
        setEndDate(endOfDay(now));
        break;
      case 'custom':
        break;
    }
  };

  const clearFilters = () => {
    setStatusFilter('all');
    setDatePreset('all');
    setStartDate(undefined);
    setEndDate(undefined);
  };

  const hasActiveFilters = statusFilter !== 'all' || datePreset !== 'all';

  // Apply filters to results
  useEffect(() => {
    let results = [...searchResults];

    // Filter by status
    if (statusFilter !== 'all') {
      results = results.filter(r => r.status === statusFilter);
    }

    // Filter by date range
    if (startDate && endDate) {
      results = results.filter(r => {
        if (!r.createdAt) return true;
        const itemDate = new Date(r.createdAt);
        return isWithinInterval(itemDate, { start: startDate, end: endDate });
      });
    }

    setFilteredResults(results);
  }, [searchResults, statusFilter, startDate, endDate]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setFilteredResults([]);
      setShowResults(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearching(true);
      const query = searchQuery.toLowerCase().trim();
      const results: SearchResult[] = [];

      try {
        // Search users
        const { data: users } = await supabase
          .from('profiles')
          .select('id, full_name, phone, email, created_at')
          .or(`full_name.ilike.%${query}%,phone.ilike.%${query}%,email.ilike.%${query}%`)
          .limit(5);

        users?.forEach(u => {
          results.push({
            type: 'user',
            id: u.id,
            title: u.full_name,
            subtitle: u.phone || u.email,
            createdAt: u.created_at,
          });
        });

        // Search rent requests by tenant name
        const { data: rentRequests } = await supabase
          .from('rent_requests')
          .select('id, rent_amount, status, tenant_id, created_at')
          .order('created_at', { ascending: false })
          .limit(50);

        if (rentRequests?.length) {
          const tenantIds = [...new Set(rentRequests.map(r => r.tenant_id))];
          const { data: tenantProfiles } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', tenantIds);

          rentRequests.forEach(r => {
            const tenant = tenantProfiles?.find(p => p.id === r.tenant_id);
            if (tenant?.full_name.toLowerCase().includes(query)) {
              results.push({
                type: 'rent_request',
                id: r.id,
                title: `Rent Request - ${tenant.full_name}`,
                subtitle: format(new Date(r.created_at), 'MMM d, yyyy'),
                status: r.status || 'pending',
                amount: r.rent_amount,
                createdAt: r.created_at,
              });
            }
          });
        }

        // Search orders by product name or buyer
        const { data: orders } = await supabase
          .from('product_orders')
          .select('id, total_price, status, product_id, buyer_id, created_at')
          .order('created_at', { ascending: false })
          .limit(50);

        if (orders?.length) {
          const productIds = [...new Set(orders.map(o => o.product_id))];
          const buyerIds = [...new Set(orders.map(o => o.buyer_id))];
          
          const [{ data: products }, { data: buyers }] = await Promise.all([
            supabase.from('products').select('id, name').in('id', productIds),
            supabase.from('profiles').select('id, full_name').in('id', buyerIds)
          ]);

          orders.forEach(o => {
            const product = products?.find(p => p.id === o.product_id);
            const buyer = buyers?.find(b => b.id === o.buyer_id);
            if (product?.name.toLowerCase().includes(query) || buyer?.full_name.toLowerCase().includes(query)) {
              results.push({
                type: 'order',
                id: o.id,
                title: product?.name || 'Unknown Product',
                subtitle: buyer?.full_name || 'Unknown Buyer',
                status: o.status,
                amount: o.total_price,
                createdAt: o.created_at,
              });
            }
          });
        }

        // loan_applications table removed - skip loan search

        setSearchResults(results);
        setShowResults(true);
      } catch (error) {
        console.error('Search error:', error);
      }
      
      setIsSearching(false);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleResultClick = (result: SearchResult) => {
    setShowResults(false);
    setSearchQuery('');
    
    switch (result.type) {
      case 'user':
        handleTabChange('users');
        break;
      case 'rent_request':
        handleTabChange('rent-requests');
        break;
      case 'order':
        handleTabChange('orders');
        break;
      case 'loan':
        handleTabChange('loans');
        break;
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'user': return <User className="h-4 w-4" />;
      case 'rent_request': return <FileText className="h-4 w-4" />;
      case 'order': return <Package className="h-4 w-4" />;
      case 'loan': return <Banknote className="h-4 w-4" />;
      default: return <Search className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'pending': return 'bg-warning/10 text-warning border-warning/30';
      case 'approved':
      case 'funded':
      case 'delivered': return 'bg-success/10 text-success border-success/30';
      case 'rejected':
      case 'cancelled': return 'bg-destructive/10 text-destructive border-destructive/30';
      default: return 'bg-muted text-muted-foreground';
    }
  };

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  if (!user || role !== 'manager') {
    return null;
  }

  return (
    <div className="min-h-screen bg-background pb-6">
      {/* Header */}
      <header className="sticky top-0 z-50 wa-header shadow-sm pt-safe">
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate(roleToSlug(role))}
              className="text-white/90 hover:text-white hover:bg-white/10"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-lg font-semibold text-white">Manager Access</h1>
          </div>
        </div>
      </header>

      <main className="px-4 py-4 space-y-4">
        {/* Global Search with Filters */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                placeholder="Search (⌘K)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 pr-10"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => {
                    setSearchQuery('');
                    setShowResults(false);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Button
              variant={showFilters ? 'default' : 'outline'}
              size="icon"
              onClick={() => setShowFilters(!showFilters)}
              className={cn(hasActiveFilters && !showFilters && 'border-primary text-primary')}
            >
              <Filter className="h-4 w-4" />
              {hasActiveFilters && !showFilters && (
                <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-primary" />
              )}
            </Button>
          </div>

          {/* Filter Controls */}
          {showFilters && (
            <Card className="animate-fade-in">
              <CardContent className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {hasActiveFilters && (
                    <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 text-xs">
                      Clear all
                    </Button>
                  )}
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  {/* Status Filter */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Status</label>
                    <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="All statuses" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All statuses</SelectItem>
                        <SelectItem value="pending">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="funded">Funded</SelectItem>
                        <SelectItem value="delivered">Delivered</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                        <SelectItem value="cancelled">Cancelled</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Date Preset */}
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Date Range</label>
                    <Select value={datePreset} onValueChange={(v) => handleDatePresetChange(v as DatePreset)}>
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="All time" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All time</SelectItem>
                        <SelectItem value="today">Today</SelectItem>
                        <SelectItem value="7days">Last 7 days</SelectItem>
                        <SelectItem value="30days">Last 30 days</SelectItem>
                        <SelectItem value="custom">Custom range</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Custom Date Range */}
                {datePreset === 'custom' && (
                  <div className="flex items-center gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn(
                            "flex-1 h-9 justify-start text-left font-normal",
                            !startDate && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="h-4 w-4 mr-2" />
                          {startDate ? format(startDate, "MMM d, yyyy") : "Start date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={startDate}
                          onSelect={(date) => setStartDate(date ? startOfDay(date) : undefined)}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    
                    <span className="text-muted-foreground text-sm">to</span>
                    
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className={cn(
                            "flex-1 h-9 justify-start text-left font-normal",
                            !endDate && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="h-4 w-4 mr-2" />
                          {endDate ? format(endDate, "MMM d, yyyy") : "End date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="end">
                        <Calendar
                          mode="single"
                          selected={endDate}
                          onSelect={(date) => setEndDate(date ? endOfDay(date) : undefined)}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                )}

                {/* Active Filters Summary */}
                {hasActiveFilters && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {statusFilter !== 'all' && (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        Status: {statusFilter}
                        <button onClick={() => setStatusFilter('all')} className="ml-1 hover:text-foreground">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    )}
                    {datePreset !== 'all' && (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        {datePreset === 'custom' && startDate && endDate 
                          ? `${format(startDate, 'MMM d')} - ${format(endDate, 'MMM d')}`
                          : datePreset === 'today' ? 'Today'
                          : datePreset === '7days' ? 'Last 7 days'
                          : 'Last 30 days'
                        }
                        <button onClick={() => handleDatePresetChange('all')} className="ml-1 hover:text-foreground">
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Search Results Dropdown */}
          {showResults && (
            <Card className="absolute left-4 right-4 z-50 shadow-lg max-h-80 overflow-auto">
              <CardContent className="p-2">
                {isSearching ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredResults.length > 0 ? (
                  <div className="space-y-1">
                    <div className="px-2 py-1 text-xs text-muted-foreground">
                      {filteredResults.length} result{filteredResults.length !== 1 ? 's' : ''}
                      {hasActiveFilters && ' (filtered)'}
                    </div>
                    {filteredResults.slice(0, 10).map((result) => (
                      <button
                        key={`${result.type}-${result.id}`}
                        onClick={() => handleResultClick(result)}
                        className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors text-left"
                      >
                        <div className="p-2 rounded-lg bg-muted">
                          {getTypeIcon(result.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{result.title}</p>
                          <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {result.amount && (
                            <span className="text-xs font-medium">{formatUGX(result.amount)}</span>
                          )}
                          {result.status && (
                            <Badge variant="outline" className={`text-xs ${getStatusColor(result.status)}`}>
                              {result.status}
                            </Badge>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-sm text-muted-foreground py-4">
                    No results found{hasActiveFilters ? ' with current filters' : ` for "${searchQuery}"`}
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
          <div className="overflow-x-auto -mx-4 px-4 pb-1 hide-scrollbar">
            <TabsList className="inline-flex w-max gap-1 bg-muted/50 p-1 md:flex md:flex-wrap md:w-full">
              <TabsTrigger value="activities" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Activity className="h-4 w-4" />
                Activities
              </TabsTrigger>
              <TabsTrigger value="rent-requests" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <FileText className="h-4 w-4" />
                Rent Requests
              </TabsTrigger>
              <TabsTrigger value="loans" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Banknote className="h-4 w-4" />
                Rent Plans
              </TabsTrigger>
              <TabsTrigger value="orders" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <ShoppingCart className="h-4 w-4" />
                Orders
              </TabsTrigger>
              <TabsTrigger value="users" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Users className="h-4 w-4" />
                Users
              </TabsTrigger>
              <TabsTrigger value="receipts" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Receipt className="h-4 w-4" />
                Receipts
              </TabsTrigger>
              <TabsTrigger value="financials" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <ChartBar className="h-4 w-4" />
                Financials
              </TabsTrigger>
              <TabsTrigger value="deposits" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Wallet className="h-4 w-4" />
                Top-ups
              </TabsTrigger>
              <TabsTrigger value="investments" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Wallet className="h-4 w-4" />
                Support Accounts
              </TabsTrigger>
              <TabsTrigger value="payments" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <CreditCard className="h-4 w-4" />
                Payments
              </TabsTrigger>
              <TabsTrigger value="proofs" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <BadgeCheck className="h-4 w-4" />
                Proofs
              </TabsTrigger>
              <TabsTrigger value="welile-homes" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Home className="h-4 w-4" />
                Welile Homes
              </TabsTrigger>
              <TabsTrigger value="withdrawals" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Banknote className="h-4 w-4" />
                Withdrawals
              </TabsTrigger>
              <TabsTrigger value="locations" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <MapPin className="h-4 w-4" />
                Locations
              </TabsTrigger>
              <TabsTrigger value="ledger" className="gap-1.5 text-xs px-3 py-2.5 min-h-[44px] touch-manipulation whitespace-nowrap">
                <Landmark className="h-4 w-4" />
                Ledger
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="activities" className="mt-4">
            <ActivityManager />
          </TabsContent>

          <TabsContent value="rent-requests" className="mt-4">
            <div className="space-y-4">
              <FundFlowTracker />
              <RentRequestsManager />
            </div>
          </TabsContent>

          <TabsContent value="loans" className="mt-4">
            <LoanApplicationsManager />
          </TabsContent>

          <TabsContent value="orders" className="mt-4">
            <OrdersManager />
          </TabsContent>

          <TabsContent value="users" className="mt-4">
            {/* Full-screen users view for mobile */}
            <div className="fixed inset-0 z-[100] bg-background md:relative md:inset-auto md:z-auto">
              {/* Mobile full-screen header */}
              <div className="sticky top-0 z-10 wa-header p-4 flex items-center gap-3 md:hidden shadow-sm">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  onClick={() => handleTabChange('rent-requests')}
                  className="text-white/90 hover:text-white hover:bg-white/10"
                >
                  <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-white">All Users</h2>
                  <p className="text-xs text-white/70">Manage system users</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate('/users')}
                  className="text-white/90 hover:text-white hover:bg-white/10 gap-2"
                >
                  <Users className="h-4 w-4" />
                  <span className="hidden xs:inline">Staff</span>
                </Button>
              </div>
              {/* User counts summary + load full table on demand */}
              <div className="h-[calc(100vh-60px)] overflow-auto md:h-auto md:overflow-visible pb-20 md:pb-0">
                {showFullUserTable ? (
                  <UserProfilesTable />
                ) : (
                  <UserCountsSummary onViewAll={() => setShowFullUserTable(true)} />
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="receipts" className="mt-4">
            <ReceiptManagement userId={user.id} />
          </TabsContent>

          <TabsContent value="financials" className="mt-4">
            <FinancialOverview />
          </TabsContent>

          <TabsContent value="ledger" className="mt-4">
            <ManagerBankingLedger />
          </TabsContent>

          <TabsContent value="deposits" className="mt-4">
            <DepositRequestsManager />
          </TabsContent>

          <TabsContent value="investments" className="mt-4">
            <div className="space-y-4">
              <ManagerInvestmentRequestsSection />
              <InvestmentAccountsManager />
            </div>
          </TabsContent>

          <TabsContent value="payments" className="mt-4">
            <div className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-2">
                <RecordMerchantPayment />
                <PaymentConfirmationsManager />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <SupporterROITrigger />
                <MonthlyRewardsTrigger />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="proofs" className="mt-4">
            <PaymentProofsManager />
          </TabsContent>

          <TabsContent value="welile-homes" className="mt-4">
            <div className="space-y-6">
              <WelileHomesSubscriptionsManager />
              <WelileHomesWithdrawalsManager />
            </div>
          </TabsContent>

          <TabsContent value="withdrawals" className="mt-4">
            <div className="space-y-6">
              <AgentCommissionPayoutsManager />
              <PaidAgentsHistory />
            </div>
          </TabsContent>

          <TabsContent value="locations" className="mt-4">
             <div className="space-y-6">
               <LandlordLocationsMap />
               <UserLocationsManager />
             </div>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

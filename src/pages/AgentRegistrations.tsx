import { useState, useEffect, useRef } from 'react';
import { getPublicOrigin } from '@/lib/getPublicOrigin';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { 
  Copy, Check, Share2, Users, Building2, Clock, CheckCircle2, 
  RefreshCw, ArrowLeft, Search, Filter, UserPlus, Calendar,
  Phone, Mail, ChevronDown, Download, FileText, FileSpreadsheet
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { AgentRegistrationAnalytics } from '@/components/agent/AgentRegistrationAnalytics';
import { exportToCSV, exportToPDF, formatDateForExport } from '@/lib/exportUtils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface UserInvite {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  role: string;
  status: string;
  activation_token: string;
  temp_password: string;
  created_at: string;
  activated_at: string | null;
}

import { HandCoins } from 'lucide-react';

const roleConfig: Record<string, { label: string; icon: React.ElementType; color: string; bgColor: string; emoji: string }> = {
  tenant: {
    label: 'Tenant',
    icon: Users,
    color: 'text-blue-600',
    bgColor: 'bg-blue-500/10 border-blue-500/20',
    emoji: '🏠',
  },
  landlord: {
    label: 'Landlord',
    icon: Building2,
    color: 'text-emerald-600',
    bgColor: 'bg-emerald-500/10 border-emerald-500/20',
    emoji: '🏢',
  },
  supporter: {
    label: 'Partner',
    icon: HandCoins,
    color: 'text-orange-600',
    bgColor: 'bg-orange-500/10 border-orange-500/20',
    emoji: '💰',
  },
};

export default function AgentRegistrations() {
  const navigate = useNavigate();
  const { user, role } = useAuth();
  const { toast } = useToast();
  const [invites, setInvites] = useState<UserInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'activated'>('all');
  const [roleFilter, setRoleFilter] = useState<'all' | 'tenant' | 'landlord' | 'supporter'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const exportRef = useRef<HTMLDivElement>(null);

  const fetchInvites = async () => {
    if (!user) return;
    
    setLoading(true);

    // Build base query without status filter first — we reconcile status client-side
    let query = supabase
      .from('supporter_invites')
      .select('*')
      .eq('created_by', user.id)
      .in('role', ['tenant', 'landlord', 'supporter'])
      .order('created_at', { ascending: false });

    if (roleFilter !== 'all') {
      query = query.eq('role', roleFilter);
    }

    const { data, error } = await query;

    if (!error && data) {
      // Reconcile: check which "pending" invites have users who already registered
      const pendingInvites = data.filter(i => i.status === 'pending');
      
      if (pendingInvites.length > 0) {
        // Extract last 9 digits of phones for matching
        const phoneDigits = pendingInvites.map(i => i.phone.replace(/\D/g, '').slice(-9));
        
        // Fetch profiles matching these phone numbers
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, phone')
          .or(phoneDigits.map(d => `phone.ilike.%${d}`).join(','));
        
        const matchedPhones = new Set(
          (profiles || []).map(p => p.phone.replace(/\D/g, '').slice(-9))
        );

        // Auto-reconcile: mark matching invites as activated in local state
        const reconciled = data.map(invite => {
          if (invite.status === 'pending') {
            const inviteDigits = invite.phone.replace(/\D/g, '').slice(-9);
            if (matchedPhones.has(inviteDigits)) {
              return { ...invite, status: 'activated' as string };
            }
          }
          return invite;
        });

        // Apply status filter after reconciliation
        const filtered = statusFilter === 'all' 
          ? reconciled 
          : reconciled.filter(i => i.status === statusFilter);

        setInvites(filtered);
      } else {
        // No pending invites, apply status filter directly
        const filtered = statusFilter === 'all'
          ? data
          : data.filter(i => i.status === statusFilter);
        setInvites(filtered);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchInvites();
  }, [user, statusFilter, roleFilter]);

  const filteredInvites = invites.filter(invite => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      invite.full_name.toLowerCase().includes(query) ||
      invite.email.toLowerCase().includes(query) ||
      invite.phone.includes(query)
    );
  });

  const getShareLink = (token: string) => {
    return `${getPublicOrigin()}/join?t=${token}`;
  };

  const handleCopyLink = async (invite: UserInvite) => {
    await navigator.clipboard.writeText(getShareLink(invite.activation_token));
    setCopiedId(invite.id);
    setTimeout(() => setCopiedId(null), 2000);
    toast({ title: 'Link & password copied!' });
  };

  const handleShareWhatsApp = (invite: UserInvite) => {
    const config = roleConfig[invite.role] || roleConfig.tenant;
    const message = `${config.emoji} Welcome to Welile, ${invite.full_name}!

You've been invited to join as a ${config.label}!

🔐 Your password: ${invite.temp_password}

👉 Activate your account here:
${getShareLink(invite.activation_token)}

Just click the link and enter your password to get started!`;
    
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const pendingCount = invites.filter(i => i.status === 'pending').length;
  const activatedCount = invites.filter(i => i.status === 'activated').length;
  const tenantCount = invites.filter(i => i.role === 'tenant').length;
  const landlordCount = invites.filter(i => i.role === 'landlord').length;
  const supporterCount = invites.filter(i => i.role === 'supporter').length;

  const handleExportCSV = () => {
    if (filteredInvites.length === 0) {
      toast({ title: 'No data to export', variant: 'destructive' });
      return;
    }

    const data = {
      headers: ['Name', 'Email', 'Phone', 'Role', 'Status', 'Registered Date', 'Activated Date'],
      rows: filteredInvites.map(invite => [
        invite.full_name,
        invite.email,
        invite.phone,
        roleConfig[invite.role]?.label || invite.role,
        invite.status === 'activated' ? 'Active' : 'Pending',
        formatDateForExport(invite.created_at),
        invite.activated_at ? formatDateForExport(invite.activated_at) : 'N/A',
      ]),
    };

    exportToCSV(data, 'agent_registrations');
    toast({ title: '✅ CSV exported successfully!' });
  };

  const handleExportPDF = async () => {
    if (filteredInvites.length === 0) {
      toast({ title: 'No data to export', variant: 'destructive' });
      return;
    }

    if (!exportRef.current) return;

    setExporting(true);
    try {
      await exportToPDF(exportRef.current, 'agent_registrations', 'My Registered Users');
      toast({ title: '✅ PDF exported successfully!' });
    } catch (error) {
      toast({ title: 'Export failed', description: 'Please try again', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background pb-20">
      <Tabs defaultValue="users" className="w-full">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b">
          <div className="flex items-center justify-between p-4 gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Button variant="ghost" size="icon-sm" className="shrink-0" onClick={() => navigate(roleToSlug(role))}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div className="min-w-0">
                <h1 className="font-bold text-lg truncate">My Registrations</h1>
                <p className="text-xs text-muted-foreground">{invites.length} total users</p>
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              {/* Export Menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" disabled={exporting || filteredInvites.length === 0}>
                    <Download className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExportCSV}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    Export as CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPDF}>
                    <FileText className="h-4 w-4 mr-2" />
                    Export as PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon-sm" onClick={fetchInvites}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Tabs Header */}
          <div className="px-4 pb-3">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="analytics">Analytics</TabsTrigger>
            </TabsList>
          </div>
        </div>

        {/* Analytics Tab */}
        <TabsContent value="analytics" className="p-4 mt-0">
          <AgentRegistrationAnalytics />
        </TabsContent>

        {/* Users Tab */}
        <TabsContent value="users" className="mt-0">
          {/* Stats Cards */}
          <div className="px-4 py-3 grid grid-cols-4 gap-2">
            <button 
              onClick={() => setStatusFilter('all')}
              className={`p-2 rounded-lg text-center transition-all ${statusFilter === 'all' ? 'bg-primary/10 ring-1 ring-primary' : 'bg-muted/50'}`}
            >
              <p className="text-lg font-bold">{invites.length}</p>
              <p className="text-[10px] text-muted-foreground">Total</p>
            </button>
            <button 
              onClick={() => setStatusFilter('pending')}
              className={`p-2 rounded-lg text-center transition-all ${statusFilter === 'pending' ? 'bg-warning/20 ring-1 ring-warning' : 'bg-muted/50'}`}
            >
              <p className="text-lg font-bold text-warning">{pendingCount}</p>
              <p className="text-[10px] text-muted-foreground">Pending</p>
            </button>
            <button 
              onClick={() => setStatusFilter('activated')}
              className={`p-2 rounded-lg text-center transition-all ${statusFilter === 'activated' ? 'bg-success/20 ring-1 ring-success' : 'bg-muted/50'}`}
            >
              <p className="text-lg font-bold text-success">{activatedCount}</p>
              <p className="text-[10px] text-muted-foreground">Active</p>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={`p-2 rounded-lg text-center transition-all ${roleFilter !== 'all' ? 'bg-primary/10 ring-1 ring-primary' : 'bg-muted/50'}`}>
                  <Filter className="h-4 w-4 mx-auto" />
                  <p className="text-[10px] text-muted-foreground">Role</p>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRoleFilter('all')}>
                  All Roles
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRoleFilter('tenant')}>
                  🏠 Tenants ({tenantCount})
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRoleFilter('landlord')}>
                  🏢 Landlords ({landlordCount})
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setRoleFilter('supporter')}>
                  💰 Partners ({supporterCount})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Search */}
          <div className="px-4 pb-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input 
                placeholder="Search by name, email, or phone..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {/* User List Content */}
          <div ref={exportRef} className="p-4 pt-0 space-y-3">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full rounded-xl" />
              ))
            ) : filteredInvites.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Users className="h-12 w-12 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="font-medium">No users found</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {searchQuery ? 'Try a different search term' : 'Register your first user to get started'}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {filteredInvites.map((invite) => {
                  const config = roleConfig[invite.role] || roleConfig.tenant;
                  const RoleIcon = config.icon;
                  const isPending = invite.status === 'pending';
                  const isExpanded = expandedId === invite.id;
                  
                  return (
                    <Collapsible 
                      key={invite.id} 
                      open={isExpanded}
                      onOpenChange={() => setExpandedId(isExpanded ? null : invite.id)}
                    >
                      <Card className={`overflow-hidden transition-all ${isExpanded ? 'ring-1 ring-primary' : ''}`}>
                        <CollapsibleTrigger asChild>
                          <CardContent className="p-4 cursor-pointer">
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-3 min-w-0 flex-1">
                                <div className={`p-2.5 rounded-xl ${config.bgColor} border`}>
                                  <RoleIcon className={`h-5 w-5 ${config.color}`} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="font-semibold">{invite.full_name}</p>
                                    <Badge 
                                      variant="outline" 
                                      className={isPending 
                                        ? 'bg-warning/10 text-warning border-warning/20' 
                                        : 'bg-success/10 text-success border-success/20'
                                      }
                                    >
                                      {isPending ? (
                                        <><Clock className="h-3 w-3 mr-1" /> Pending</>
                                      ) : (
                                        <><CheckCircle2 className="h-3 w-3 mr-1" /> Active</>
                                      )}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
                                    <Badge variant="secondary" className="text-xs font-normal">
                                      {config.emoji} {config.label}
                                    </Badge>
                                    <span>•</span>
                                    <span>{formatDistanceToNow(new Date(invite.created_at), { addSuffix: true })}</span>
                                    {isPending && (
                                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 bg-green-500/10 text-green-600 border-green-500/30">
                                        ∞ Never expires
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              </div>
                              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                            </div>
                          </CardContent>
                        </CollapsibleTrigger>
                        
                        <CollapsibleContent>
                          <div className="px-4 pb-4 pt-0 space-y-3 border-t">
                            <div className="pt-3 grid grid-cols-2 gap-3 text-sm">
                              <div className="flex items-center gap-2">
                                <Phone className="h-4 w-4 text-muted-foreground" />
                                <span>{invite.phone}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Mail className="h-4 w-4 text-muted-foreground" />
                                <span className="truncate">{invite.email}</span>
                              </div>
                              <div className="flex items-center gap-2 col-span-2">
                                <Calendar className="h-4 w-4 text-muted-foreground" />
                                <span>Registered {format(new Date(invite.created_at), 'PPp')}</span>
                              </div>
                              {invite.activated_at && (
                                <div className="flex items-center gap-2 col-span-2 text-success">
                                  <CheckCircle2 className="h-4 w-4" />
                                  <span>Activated {format(new Date(invite.activated_at), 'PPp')}</span>
                                </div>
                              )}
                            </div>
                            
                            {isPending && (
                              <div className="flex gap-2 pt-2">
                                <Button 
                                  variant="outline" 
                                  className="flex-1"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyLink(invite);
                                  }}
                                >
                                  {copiedId === invite.id ? (
                                    <><Check className="h-4 w-4 mr-2 text-success" /> Copied!</>
                                  ) : (
                                    <><Copy className="h-4 w-4 mr-2" /> Copy Link</>
                                  )}
                                </Button>
                                <Button 
                                  className="flex-1 bg-green-600 hover:bg-green-700"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleShareWhatsApp(invite);
                                  }}
                                >
                                  <Share2 className="h-4 w-4 mr-2" />
                                  WhatsApp
                                </Button>
                              </div>
                            )}
                          </div>
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

    </div>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Users, FileText, Home, Phone, MapPin, Search, Calendar, XCircle, CheckCircle2, Clock, ChevronDown } from 'lucide-react';
import { format } from 'date-fns';
import { RentPipelineQueue } from './RentPipelineQueue';
import { PromissoryNotesQueue } from './PromissoryNotesQueue';
import { AgentOpsApprovedRequestsPanel } from './AgentOpsApprovedRequestsPanel';
import { AgentOpsRejectedRequestsPanel } from './AgentOpsRejectedRequestsPanel';
import { RejectedRequestsQueue } from './RejectedRequestsQueue';
import { AgentOpsExpiredRequestsPanel } from './AgentOpsExpiredRequestsPanel';
import { NewTenantsWithoutRequestPanel } from './NewTenantsWithoutRequestPanel';
import { formatLocation, locationHaystack } from '@/lib/locationText';

function LandlordsPipeline() {
  const [search, setSearch] = useState('');
  const [selectedLandlord, setSelectedLandlord] = useState<any>(null);
  const { data: landlords = [], isLoading } = useQuery({
    queryKey: ['pipeline-landlords'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, status, created_at, rent_amount, landlord_id, tenant_id, landlords!inner(id, name, phone, property_address, region, district, sub_county, village)')
        .not('status', 'in', '("funded","rejected","cancelled")')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;

      const grouped = new Map<string, { name: string; phone: string; address: string; district: string; fullAddress: string; searchText: string; statuses: string[]; requests: { id: string; status: string; rent_amount: number; created_at: string }[] }>();
      for (const r of data || []) {
        const ll = r.landlords as any;
        const key = r.landlord_id;
        if (!grouped.has(key)) {
          const fullAddress = formatLocation([
            ll?.property_address,
            ll?.village,
            ll?.sub_county,
            ll?.district,
            ll?.region,
          ]);
          grouped.set(key, {
            name: ll?.name || 'Unknown',
            phone: ll?.phone || '',
            address: ll?.property_address || '',
            district: ll?.district || '',
            fullAddress,
            searchText: locationHaystack([ll?.name, ll?.phone, fullAddress]),
            statuses: [],
            requests: [],
          });
        }
        const entry = grouped.get(key)!;
        entry.statuses.push(r.status || 'pending');
        entry.requests.push({ id: r.id, status: r.status || 'pending', rent_amount: r.rent_amount || 0, created_at: r.created_at });
      }
      return Array.from(grouped.values());
    },
  });

  const q = search.toLowerCase().trim();
  const filtered = landlords.filter(ll => !q || ll.searchText.includes(q));

  if (isLoading) return <div className="text-center py-8 text-muted-foreground text-sm">Loading landlords...</div>;
  if (landlords.length === 0) return <div className="text-center py-8 text-muted-foreground text-sm">No landlords in pipeline</div>;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search by name, phone, district, or address..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 h-8 text-xs"
        />
      </div>
      {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No matching landlords</p>}
      {filtered.map((ll, i) => (
        <Card key={i} className="border cursor-pointer hover:bg-muted/30 transition-colors" onClick={() => setSelectedLandlord(ll)}>
          <CardContent className="p-3 space-y-1.5">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium text-sm truncate">{ll.name}</span>
                </div>
                {ll.phone && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground">{ll.phone}</span>
                  </div>
                )}
                {(ll.fullAddress || ll.address) && (
                  <div className="flex items-center gap-2 mt-0.5">
                    <MapPin className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{ll.fullAddress || ll.address}</span>
                  </div>
                )}
              </div>
              <Badge variant="primary" size="sm">{ll.statuses.length} request{ll.statuses.length !== 1 ? 's' : ''}</Badge>
            </div>
            <div className="flex flex-wrap gap-1">
              {ll.statuses.slice(0, 3).map((s, j) => (
                <Badge key={j} variant="outline" size="sm">{s}</Badge>
              ))}
              {ll.statuses.length > 3 && <Badge variant="muted" size="sm">+{ll.statuses.length - 3}</Badge>}
            </div>
          </CardContent>
        </Card>
      ))}

      {/* Landlord Detail Sheet */}
      <Sheet open={!!selectedLandlord} onOpenChange={(open) => { if (!open) setSelectedLandlord(null); }}>
        <SheetContent side="bottom" className="h-[75vh] rounded-t-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Home className="h-4 w-4 text-primary" />
              Landlord Details
            </SheetTitle>
          </SheetHeader>
          {selectedLandlord && (
            <div className="space-y-4 mt-4 overflow-y-auto max-h-[calc(75vh-80px)] pb-6">
              {/* Contact Info */}
              <Card>
                <CardContent className="p-3 space-y-2">
                  <p className="font-semibold text-base">{selectedLandlord.name}</p>
                  {selectedLandlord.phone && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Phone className="h-3.5 w-3.5" />
                      <span>{selectedLandlord.phone}</span>
                    </div>
                  )}
                  {(selectedLandlord.fullAddress || selectedLandlord.address) && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5" />
                      <span>{selectedLandlord.fullAddress || selectedLandlord.address}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Rent Requests */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase mb-2">
                  Active Rent Requests ({selectedLandlord.requests.length})
                </p>
                <div className="space-y-2">
                  {selectedLandlord.requests.map((req: any) => (
                    <Card key={req.id} className="border">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Badge variant="outline" size="sm">{req.status.replace(/_/g, ' ')}</Badge>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                              <Calendar className="h-3 w-3" />
                              {format(new Date(req.created_at), 'dd MMM yyyy')}
                            </div>
                          </div>
                          <p className="font-bold text-sm">UGX {Number(req.rent_amount).toLocaleString()}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              {/* Summary */}
              <Card className="bg-primary/5 border-primary/20">
                <CardContent className="p-3 text-center">
                  <p className="text-xs text-muted-foreground">Total Pipeline Value</p>
                  <p className="font-bold text-lg">
                    UGX {selectedLandlord.requests.reduce((sum: number, r: any) => sum + Number(r.rent_amount), 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function AgentOpsPipelineHub() {
  const [activeTab, setActiveTab] = useState('tenants');

  const { data: counts } = useQuery({
    queryKey: ['pipeline-counts'],
    staleTime: 0,
    refetchOnMount: 'always',
    queryFn: async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [tenants, notes, landlordsData, approved, rejected, expiredData] = await Promise.all([
        supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('promissory_notes').select('id', { count: 'exact', head: true }).in('status', ['pending', 'activated']),
        supabase.from('rent_requests').select('landlord_id').not('status', 'in', '("funded","rejected","cancelled")').not('landlord_id', 'is', null),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .or('status.neq.pending,agent_verified.eq.true,agent_verified_at.not.is.null,agent_ops_reviewed_at.not.is.null')
          .neq('status', 'rejected')
          .neq('status', 'cancelled'),
        supabase.from('rent_requests').select('id', { count: 'exact', head: true }).eq('status', 'rejected'),
        supabase
          .from('rent_requests')
          .select('id, agent_verified')
          .eq('status', 'pending')
          .lt('created_at', thirtyDaysAgo),
      ]);
      const uniqueLandlords = new Set(landlordsData.data?.map((r: any) => r.landlord_id)).size;
      const expiredCount = (expiredData.data || []).filter((r: any) => !r.agent_verified).length;
      return {
        tenants: tenants.count || 0,
        notes: notes.count || 0,
        landlords: uniqueLandlords,
        approved: approved.count || 0,
        rejected: rejected.count || 0,
        expired: expiredCount,
      };
    },
  });

  const tabs = [
    { value: 'tenants', label: 'Tenants', icon: Users, count: counts?.tenants },
    { value: 'notes', label: 'Promissory Notes', icon: FileText, count: counts?.notes },
    { value: 'landlords', label: 'Landlords', icon: Home, count: counts?.landlords },
    { value: 'approved', label: 'Approved', icon: CheckCircle2, count: counts?.approved },
    { value: 'expired', label: 'Expired', icon: Clock, count: counts?.expired, isDestructive: true },
    { value: 'rejected', label: 'Rejected', icon: XCircle, count: counts?.rejected },
  ];

  const otherTabs = tabs.filter((t) => t.value !== 'tenants');
  const activeOtherTab = otherTabs.find((t) => t.value === activeTab);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
      {/* Mobile view: Tenants button + dropdown for other tabs */}
      <div className="flex sm:hidden items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={activeTab === 'tenants' ? 'default' : 'outline'}
          onClick={() => setActiveTab('tenants')}
          className="h-8 text-xs font-semibold gap-1.5 rounded-full px-3 shadow-xs"
        >
          <Users className="h-3.5 w-3.5" />
          <span>Tenants</span>
          {counts?.tenants != null && counts.tenants > 0 && (
            <Badge
              variant={activeTab === 'tenants' ? 'secondary' : 'primary'}
              size="sm"
              className="ml-1 px-1.5 h-4 text-[10px] font-bold"
            >
              {counts.tenants}
            </Badge>
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant={activeTab !== 'tenants' ? 'default' : 'outline'}
              className="h-8 text-xs font-semibold gap-1.5 rounded-full border-border/70 px-3 shadow-xs"
            >
              {activeOtherTab ? (
                <>
                  <activeOtherTab.icon className="h-3.5 w-3.5" />
                  <span>{activeOtherTab.label}</span>
                  {activeOtherTab.count != null && activeOtherTab.count > 0 && (
                    <Badge
                      variant={activeOtherTab.isDestructive ? 'destructive' : 'secondary'}
                      size="sm"
                      className="ml-1 px-1.5 h-4 text-[10px] font-bold"
                    >
                      {activeOtherTab.count}
                    </Badge>
                  )}
                  <ChevronDown className="h-3 w-3 ml-0.5 opacity-70" />
                </>
              ) : (
                <>
                  <span>More tabs</span>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52 p-1 z-50 bg-popover border border-border shadow-md">
            {otherTabs.map((t) => (
              <DropdownMenuItem
                key={t.value}
                onClick={() => setActiveTab(t.value)}
                className={cn(
                  'text-xs py-2 px-2.5 cursor-pointer flex items-center justify-between rounded-md transition-colors',
                  activeTab === t.value ? 'bg-primary/10 text-primary font-semibold' : 'text-foreground hover:bg-accent/50'
                )}
              >
                <div className="flex items-center gap-2">
                  <t.icon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                </div>
                {t.count != null && t.count > 0 && (
                  <Badge
                    variant={t.isDestructive ? 'destructive' : 'primary'}
                    size="sm"
                    className="px-1.5 h-4 text-[10px] font-bold"
                  >
                    {t.count}
                  </Badge>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop view: Standard horizontal pills */}
      <div className="hidden sm:block overflow-x-auto scrollbar-hide -mx-1 px-1">
        <TabsList variant="pills" className="w-max">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} variant="pills" className="gap-1.5">
              <t.icon className="h-3.5 w-3.5" />
              <span className="text-xs">{t.label}</span>
              {t.count != null && t.count > 0 && (
                <Badge
                  variant={t.isDestructive ? 'destructive' : 'primary'}
                  size="sm"
                  className="ml-0.5 min-w-[18px] justify-center font-bold"
                >
                  {t.count}
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="tenants" className="space-y-4">
        <NewTenantsWithoutRequestPanel />
        <RentPipelineQueue stage="pending" />
      </TabsContent>
      <TabsContent value="notes"><PromissoryNotesQueue /></TabsContent>
      <TabsContent value="landlords"><LandlordsPipeline /></TabsContent>
      <TabsContent value="approved"><AgentOpsApprovedRequestsPanel /></TabsContent>
      <TabsContent value="expired"><AgentOpsExpiredRequestsPanel /></TabsContent>
      <TabsContent value="rejected" className="space-y-4">
        {/* Managers reopen Agent Ops-stage returns here, using the same
            reason-required reopen workflow as every other stage. */}
        <RejectedRequestsQueue stageFilter="pending" title="Rejected at Agent Ops" collapsible />
        <AgentOpsRejectedRequestsPanel />
      </TabsContent>
    </Tabs>
  );
}


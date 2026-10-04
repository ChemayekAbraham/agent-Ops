import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  FileText, 
  Calendar, 
  CheckCircle, 
  XCircle,
  Smartphone,
  Globe,
  Shield,
  Home
} from 'lucide-react';
import { format } from 'date-fns';

interface BaseAgreement {
  id: string;
  agreement_version: string;
  status: string;
  accepted_at: string;
  device_info: string | null;
  ip_address: string | null;
  created_at: string;
}

interface TenantAgreement extends BaseAgreement {
  tenant_id: string;
}

interface SupporterAgreement extends BaseAgreement {
  supporter_id: string;
}

interface AgentAgreement extends BaseAgreement {
  agent_id: string;
}

interface LandlordAgreement extends BaseAgreement {
  landlord_id: string;
}

interface UserTermsSectionProps {
  userId: string;
  userRoles: string[];
}

export default function UserTermsSection({ userId, userRoles }: UserTermsSectionProps) {
  const [tenantAgreement, setTenantAgreement] = useState<TenantAgreement | null>(null);
  const [supporterAgreement, setSupporterAgreement] = useState<SupporterAgreement | null>(null);
  const [agentAgreement, setAgentAgreement] = useState<AgentAgreement | null>(null);
  const [landlordAgreement, setLandlordAgreement] = useState<LandlordAgreement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAgreements();
  }, [userId, userRoles]);

  const fetchAgreements = async () => {
    setLoading(true);
    try {
      // Fetch all agreements in parallel based on roles
      const [tenantResult, supporterResult, agentResult, landlordResult] = await Promise.all([
        userRoles.includes('tenant')
          ? supabase
              .from('tenant_agreement_acceptance')
              .select('*')
              .eq('tenant_id', userId)
              .order('accepted_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        userRoles.includes('supporter')
          ? supabase
              .from('supporter_agreement_acceptance')
              .select('*')
              .eq('supporter_id', userId)
              .order('accepted_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        // agent_agreement_acceptance table removed
        Promise.resolve({ data: null }),
        // landlord_agreement_acceptance table removed
        Promise.resolve({ data: null }),
      ]);

      setTenantAgreement(tenantResult.data);
      setSupporterAgreement(supporterResult.data);
      setAgentAgreement(agentResult.data);
      setLandlordAgreement(landlordResult.data);
    } catch (error) {
      console.error('Error fetching agreements:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    if (status === 'accepted') {
      return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Accepted</Badge>;
    }
    return <Badge className="bg-destructive/20 text-destructive"><XCircle className="h-3 w-3 mr-1" />Not Accepted</Badge>;
  };

  const parseDeviceInfo = (deviceInfo: string | null) => {
    if (!deviceInfo) return 'Unknown device';
    try {
      // Try to extract meaningful info from user agent or device string
      if (deviceInfo.includes('Mobile')) return 'Mobile Device';
      if (deviceInfo.includes('Android')) return 'Android Device';
      if (deviceInfo.includes('iPhone') || deviceInfo.includes('iOS')) return 'iPhone/iOS';
      if (deviceInfo.includes('Windows')) return 'Windows PC';
      if (deviceInfo.includes('Mac')) return 'Mac';
      return deviceInfo.length > 50 ? deviceInfo.substring(0, 50) + '...' : deviceInfo;
    } catch {
      return deviceInfo;
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const hasTenantRole = userRoles.includes('tenant');
  const hasSupporterRole = userRoles.includes('supporter');
  const hasAgentRole = userRoles.includes('agent');
  const hasLandlordRole = userRoles.includes('landlord');
  const noRelevantRoles = !hasTenantRole && !hasSupporterRole && !hasAgentRole && !hasLandlordRole;

  if (noRelevantRoles) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <FileText className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-muted-foreground text-sm">
            No agreement requirements for this user's roles
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Agreements are required for Tenant, Supporter, Agent, and Landlord roles
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3">
        {hasTenantRole && (
          <Card className={`p-3 ${tenantAgreement?.status === 'accepted' ? 'border-success/50' : 'border-warning/50'}`}>
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Shield className="h-3 w-3" />
              Tenant Agreement
            </div>
            {tenantAgreement?.status === 'accepted' ? (
              <>
                <div className="flex items-center gap-1 text-success">
                  <CheckCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">v{tenantAgreement.agreement_version}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 text-warning">
                  <XCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Not Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">Pending</p>
              </>
            )}
          </Card>
        )}
        {hasSupporterRole && (
          <Card className={`p-3 ${supporterAgreement?.status === 'accepted' ? 'border-success/50' : 'border-warning/50'}`}>
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Shield className="h-3 w-3" />
              Supporter Agreement
            </div>
            {supporterAgreement?.status === 'accepted' ? (
              <>
                <div className="flex items-center gap-1 text-success">
                  <CheckCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">v{supporterAgreement.agreement_version}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 text-warning">
                  <XCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Not Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">Pending</p>
              </>
            )}
          </Card>
        )}
        {hasAgentRole && (
          <Card className={`p-3 ${agentAgreement?.status === 'accepted' ? 'border-success/50' : 'border-warning/50'}`}>
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Shield className="h-3 w-3" />
              Agent Agreement
            </div>
            {agentAgreement?.status === 'accepted' ? (
              <>
                <div className="flex items-center gap-1 text-success">
                  <CheckCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">v{agentAgreement.agreement_version}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 text-warning">
                  <XCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Not Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">Pending</p>
              </>
            )}
          </Card>
        )}
        {hasLandlordRole && (
          <Card className={`p-3 ${landlordAgreement?.status === 'accepted' ? 'border-success/50' : 'border-warning/50'}`}>
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Home className="h-3 w-3" />
              Landlord Agreement
            </div>
            {landlordAgreement?.status === 'accepted' ? (
              <>
                <div className="flex items-center gap-1 text-success">
                  <CheckCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">v{landlordAgreement.agreement_version}</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 text-warning">
                  <XCircle className="h-4 w-4" />
                  <span className="font-semibold text-sm">Not Accepted</span>
                </div>
                <p className="text-xs text-muted-foreground">Pending</p>
              </>
            )}
          </Card>
        )}
      </div>

      {/* Tenant Agreement Details */}
      {hasTenantRole && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Tenant Terms & Conditions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {tenantAgreement ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Status</span>
                  {getStatusBadge(tenantAgreement.status)}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Version</span>
                  <span className="text-sm font-medium">v{tenantAgreement.agreement_version}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Accepted
                  </span>
                  <span className="text-sm font-medium">
                    {format(new Date(tenantAgreement.accepted_at), 'MMM d, yyyy HH:mm')}
                  </span>
                </div>
                {tenantAgreement.device_info && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Smartphone className="h-3 w-3" /> Device
                    </span>
                    <span className="text-sm font-medium text-right truncate max-w-[150px]">
                      {parseDeviceInfo(tenantAgreement.device_info)}
                    </span>
                  </div>
                )}
                {tenantAgreement.ip_address && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Globe className="h-3 w-3" /> IP Address
                    </span>
                    <span className="text-sm font-medium font-mono">
                      {tenantAgreement.ip_address}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <XCircle className="h-8 w-8 mx-auto text-warning mb-2" />
                <p className="text-sm text-muted-foreground">
                  Tenant has not accepted the agreement yet
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Landlord Agreement Details - placed right after Tenant */}
      {hasLandlordRole && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Home className="h-4 w-4 text-amber-500" />
              Landlord Terms & Benefits
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {landlordAgreement ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Status</span>
                  {getStatusBadge(landlordAgreement.status)}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Version</span>
                  <span className="text-sm font-medium">v{landlordAgreement.agreement_version}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Accepted
                  </span>
                  <span className="text-sm font-medium">
                    {format(new Date(landlordAgreement.accepted_at), 'MMM d, yyyy HH:mm')}
                  </span>
                </div>
                {landlordAgreement.device_info && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Smartphone className="h-3 w-3" /> Device
                    </span>
                    <span className="text-sm font-medium text-right truncate max-w-[150px]">
                      {parseDeviceInfo(landlordAgreement.device_info)}
                    </span>
                  </div>
                )}
                {landlordAgreement.ip_address && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Globe className="h-3 w-3" /> IP Address
                    </span>
                    <span className="text-sm font-medium font-mono">
                      {landlordAgreement.ip_address}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <XCircle className="h-8 w-8 mx-auto text-warning mb-2" />
                <p className="text-sm text-muted-foreground">
                  Landlord has not accepted the agreement yet
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Supporter Agreement Details */}
      {hasSupporterRole && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <FileText className="h-4 w-4 text-success" />
              Supporter Terms & Conditions
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {supporterAgreement ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Status</span>
                  {getStatusBadge(supporterAgreement.status)}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Version</span>
                  <span className="text-sm font-medium">v{supporterAgreement.agreement_version}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" /> Accepted
                  </span>
                  <span className="text-sm font-medium">
                    {format(new Date(supporterAgreement.accepted_at), 'MMM d, yyyy HH:mm')}
                  </span>
                </div>
                {supporterAgreement.device_info && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Smartphone className="h-3 w-3" /> Device
                    </span>
                    <span className="text-sm font-medium text-right truncate max-w-[150px]">
                      {parseDeviceInfo(supporterAgreement.device_info)}
                    </span>
                  </div>
                )}
                {supporterAgreement.ip_address && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground flex items-center gap-1">
                      <Globe className="h-3 w-3" /> IP Address
                    </span>
                    <span className="text-sm font-medium font-mono">
                      {supporterAgreement.ip_address}
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4">
                <XCircle className="h-8 w-8 mx-auto text-warning mb-2" />
                <p className="text-sm text-muted-foreground">
                  Supporter has not accepted the agreement yet
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

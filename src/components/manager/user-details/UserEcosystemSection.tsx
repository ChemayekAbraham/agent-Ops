import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Building, User, Heart, Shield, MapPin, Phone, CheckCircle, Clock
} from 'lucide-react';
import WhatsAppPhoneLink from '@/components/WhatsAppPhoneLink';

interface StakeholderInfo {
  id: string;
  name: string;
  phone: string;
  role: string;
  verified?: boolean;
}

interface EcosystemData {
  landlord: { name: string; phone: string; property_address: string; verified: boolean } | null;
  agent: StakeholderInfo | null;
  supporter: StakeholderInfo | null;
  manager: StakeholderInfo | null;
  location: { city: string | null; country: string | null; lat: number | null; lng: number | null } | null;
  rentAmount: number | null;
  status: string | null;
}

interface UserEcosystemSectionProps {
  userId: string;
}

export default function UserEcosystemSection({ userId }: UserEcosystemSectionProps) {
  const [data, setData] = useState<EcosystemData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchEcosystem();
  }, [userId]);

  const fetchEcosystem = async () => {
    setLoading(true);
    try {
      // Fetch the most recent rent request with all linked stakeholders
      const { data: rr } = await supabase
        .from('rent_requests')
        .select(`
          id, rent_amount, status, supporter_id, agent_id, approved_by,
          request_city, request_country, request_latitude, request_longitude,
          landlord:landlords!rent_requests_landlord_id_fkey(name, phone, property_address, verified)
        `)
        .eq('tenant_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!rr) {
        setData(null);
        setLoading(false);
        return;
      }

      // Fetch agent, supporter, and manager profiles in parallel
      const profileIds = [rr.agent_id, rr.supporter_id, rr.approved_by].filter(Boolean) as string[];
      let profiles: Record<string, { id: string; full_name: string; phone: string }> = {};

      if (profileIds.length > 0) {
        const { data: p } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', profileIds);
        if (p) {
          profiles = p.reduce((acc, pr) => { acc[pr.id] = pr; return acc; }, {} as typeof profiles);
        }
      }

      const landlordData = rr.landlord as any;

      setData({
        landlord: landlordData ? {
          name: landlordData.name,
          phone: landlordData.phone,
          property_address: landlordData.property_address,
          verified: landlordData.verified ?? false,
        } : null,
        agent: rr.agent_id && profiles[rr.agent_id] ? {
          id: rr.agent_id,
          name: profiles[rr.agent_id].full_name,
          phone: profiles[rr.agent_id].phone,
          role: 'Agent',
        } : null,
        supporter: rr.supporter_id && profiles[rr.supporter_id] ? {
          id: rr.supporter_id,
          name: profiles[rr.supporter_id].full_name,
          phone: profiles[rr.supporter_id].phone,
          role: 'Supporter',
        } : null,
        manager: rr.approved_by && profiles[rr.approved_by] ? {
          id: rr.approved_by,
          name: profiles[rr.approved_by].full_name,
          phone: profiles[rr.approved_by].phone,
          role: 'Manager',
        } : null,
        location: {
          city: rr.request_city,
          country: rr.request_country,
          lat: rr.request_latitude,
          lng: rr.request_longitude,
        },
        rentAmount: rr.rent_amount,
        status: rr.status,
      });
    } catch (err) {
      console.error('Error fetching ecosystem:', err);
    } finally {
      setLoading(false);
    }
  };

  const getInitials = (name: string) =>
    name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);

  if (loading) {
    return (
      <Card>
        <CardHeader className="py-3">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-center">
          <Building className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No rent facilitation yet</p>
        </CardContent>
      </Card>
    );
  }

  const stakeholders = [
    {
      icon: Building,
      label: 'Landlord',
      name: data.landlord?.name,
      phone: data.landlord?.phone,
      subtitle: data.landlord?.property_address,
      color: 'text-chart-5',
      bgColor: 'bg-chart-5/10',
      verified: data.landlord?.verified,
    },
    {
      icon: User,
      label: 'Agent',
      name: data.agent?.name,
      phone: data.agent?.phone,
      subtitle: 'Field verification & collection',
      color: 'text-warning',
      bgColor: 'bg-warning/10',
    },
    {
      icon: Heart,
      label: 'Supporter / Funder',
      name: data.supporter?.name,
      phone: data.supporter?.phone,
      subtitle: 'Funded this rent (earns 15%/mo)',
      color: 'text-success',
      bgColor: 'bg-success/10',
    },
    {
      icon: Shield,
      label: 'Manager (Approved)',
      name: data.manager?.name,
      phone: data.manager?.phone,
      subtitle: 'Approved this facilitation',
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
  ];

  return (
    <Card className="border-primary/20">
      <CardHeader className="py-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Building className="h-4 w-4 text-primary" />
          Tenant Ecosystem
          {data.status && (
            <Badge variant="outline" className="ml-auto text-xs">
              {data.status}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {stakeholders.map((s) => (
          <div
            key={s.label}
            className={`flex items-center gap-3 p-2.5 rounded-lg ${s.bgColor}`}
          >
            <Avatar className="h-9 w-9 shrink-0">
              <AvatarFallback className={`${s.bgColor} ${s.color} text-xs font-bold`}>
                {s.name ? getInitials(s.name) : <s.icon className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </span>
                {s.verified && (
                  <CheckCircle className="h-3 w-3 text-success" />
                )}
              </div>
              {s.name ? (
                <>
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  {s.phone && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="h-3 w-3" />
                      <WhatsAppPhoneLink phone={s.phone} />
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Not assigned yet
                </p>
              )}
              {s.subtitle && s.name && (
                <p className="text-[10px] text-muted-foreground truncate">{s.subtitle}</p>
              )}
            </div>
          </div>
        ))}

        {/* Location */}
        {(data.location?.city || data.location?.lat) && (
          <div className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30">
            <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
              <MapPin className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Location
              </span>
              <p className="text-sm font-medium">
                {[data.location.city, data.location.country].filter(Boolean).join(', ') || 'Coordinates only'}
              </p>
              {data.location.lat && data.location.lng && (
                <p className="text-[10px] text-muted-foreground">
                  {data.location.lat.toFixed(4)}, {data.location.lng.toFixed(4)}
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

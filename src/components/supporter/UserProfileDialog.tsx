import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { ContactActionsBar } from '@/components/chat/ContactActionsBar';
import { WhatsAppRequestButton } from '@/components/chat/WhatsAppRequestButton';
import { Separator } from '@/components/ui/separator';
import { MapPin, Calendar, Home, Building, Users, Phone, Shield, CheckCircle2, Zap, Eye, EyeOff, IdCard, Mail, Wallet, Tag } from 'lucide-react';
import { formatDistanceToNow, differenceInDays } from 'date-fns';
import UserReviewsSection from '@/components/reviews/UserReviewsSection';
import { useUserStats } from '@/hooks/useUserStats';
import { UserStatsSection } from '@/components/profile/UserStatsSection';
import { VerificationChecklist } from '@/components/shared/VerificationChecklist';

interface UserProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: string;
    name: string;
    avatarUrl?: string;
    type: 'tenant' | 'landlord' | 'agent';
    createdAt?: string;
    phone?: string;
    propertyAddress?: string;
    verified?: boolean;
    readyToReceive?: boolean;
    hasSmartphone?: boolean;
    numberOfHouses?: number;
    desiredRent?: number;
    electricityMeter?: string;
    caretakerName?: string;
    caretakerPhone?: string;
    city?: string;
    country?: string;
    tenantCount?: number;
    hasRentRequest?: boolean;
    lastActiveAt?: string | null;
    // CRM directory extras
    email?: string;
    nationalId?: string;
    district?: string;
    region?: string;
    territory?: string;
    monthlyRent?: number;
    stage?: string;
    tenantStatus?: string;
  } | null;
}

const STAGE_LABELS: Record<string, string> = {
  rent_request: 'Rent Request',
  processing: 'Processing',
  verified: 'Verified',
  paid: 'Paid',
};

const fmtUGX = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

export function UserProfileDialog({ open, onOpenChange, user }: UserProfileDialogProps) {
  const { stats, loading: statsLoading } = useUserStats(user?.id);

  if (!user) return null;
  const getRoleBadge = () => {
    switch (user.type) {
      case 'tenant':
        return (
          <Badge className="bg-blue-500/10 text-blue-600 border-blue-500/30">
            🏠 Tenant
          </Badge>
        );
      case 'landlord':
        return (
          <Badge className="bg-purple-500/10 text-purple-600 border-purple-500/30">
            🏢 Landlord
          </Badge>
        );
      case 'agent':
        return (
          <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/30">
            🤝 Agent
          </Badge>
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader className="pb-0">
          <div className="flex flex-col items-center gap-3 pt-2">
            <UserAvatar 
              fullName={user.name} 
              avatarUrl={user.avatarUrl} 
              size="lg" 
            />
            <div className="text-center">
              <DialogTitle className="text-lg">{user.name}</DialogTitle>
              <div className="flex flex-wrap justify-center gap-1.5 mt-2">
                {getRoleBadge()}
                {stats.roles.length > 0 && stats.roles
                  .filter(r => r !== user.type)
                  .map(role => (
                    <Badge key={role} variant="secondary" className="text-xs capitalize">
                      {role}
                    </Badge>
                  ))}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Contact Actions */}
          <div className="flex justify-center">
            {user.type === 'landlord' ? (
              <div className="flex items-center gap-2">
                <WhatsAppRequestButton
                  targetUserId={user.id}
                  targetName={user.name}
                  targetPhone={user.phone}
                  size="default"
                  variant="outline"
                  showLabel
                />
              </div>
            ) : (
              <ContactActionsBar
                userId={user.id}
                userName={user.name}
                showLabels
              />
            )}
          </div>

          {/* User Info */}
          <div className="space-y-3 bg-muted/30 rounded-lg p-3">
            {user.createdAt && (
              <div className="flex items-center gap-2 text-sm">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Joined</span>
                <span className="ml-auto font-medium">
                  {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })}
                </span>
              </div>
            )}

            {/* Dashboard Access Status */}
            {(() => {
              const lastActive = user.lastActiveAt;
              if (lastActive) {
                const days = differenceInDays(new Date(), new Date(lastActive));
                const isRecent = days <= 7;
                return (
                  <div className="flex items-center gap-2 text-sm">
                    {isRecent ? <Eye className="h-4 w-4 text-green-600" /> : <EyeOff className="h-4 w-4 text-destructive" />}
                    <span className="text-muted-foreground">Dashboard</span>
                    <span className={`ml-auto font-medium ${isRecent ? 'text-green-600' : days <= 30 ? 'text-amber-600' : 'text-destructive'}`}>
                      {isRecent ? 'Active' : `Last seen ${formatDistanceToNow(new Date(lastActive), { addSuffix: true })}`}
                    </span>
                  </div>
                );
              }
              return (
                <div className="flex items-center gap-2 text-sm">
                  <EyeOff className="h-4 w-4 text-destructive" />
                  <span className="text-muted-foreground">Dashboard</span>
                  <span className="ml-auto">
                    <Badge variant="destructive" className="text-[10px]">Never logged in</Badge>
                  </span>
                </div>
              );
            })()}

            {/* Landlord-specific info */}
            {user.type === 'landlord' && (
              <>
                {user.propertyAddress && (
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
                    <span className="text-muted-foreground">Property</span>
                    <span className="ml-auto font-medium text-right max-w-[160px]">
                      {user.propertyAddress}
                    </span>
                  </div>
                )}
                {user.numberOfHouses && user.numberOfHouses > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Houses</span>
                    <span className="ml-auto font-medium">{user.numberOfHouses}</span>
                  </div>
                )}
                {user.electricityMeter && (
                  <div className="flex items-center gap-2 text-sm">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Meter #</span>
                    <span className="ml-auto font-mono text-xs bg-muted px-2 py-0.5 rounded">
                      {user.electricityMeter}
                    </span>
                  </div>
                )}
                {user.verified !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Shield className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Verified</span>
                    <span className="ml-auto">
                      {user.verified ? (
                        <Badge className="bg-success/10 text-success border-success/30 text-xs">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Yes
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Pending</Badge>
                      )}
                    </span>
                  </div>
                )}
                {user.readyToReceive !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Home className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Ready to Receive</span>
                    <span className="ml-auto">
                      {user.readyToReceive ? (
                        <Badge className="bg-success/10 text-success border-success/30 text-xs">Yes</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">No</Badge>
                      )}
                    </span>
                  </div>
                )}
                {user.hasSmartphone !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Has Smartphone</span>
                    <span className="ml-auto">
                      {user.hasSmartphone ? (
                        <Badge className="bg-primary/10 text-primary border-primary/30 text-xs">Yes</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">No</Badge>
                      )}
                    </span>
                  </div>
                )}
                {user.caretakerName && (
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Caretaker</span>
                    <span className="ml-auto font-medium">{user.caretakerName}</span>
                  </div>
                )}
              </>
            )}

            {/* Agent-specific info */}
            {user.type === 'agent' && (
              <>
                {(user.city || user.country) && (
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Location</span>
                    <span className="ml-auto font-medium">
                      {[user.city, user.country].filter(Boolean).join(', ')}
                    </span>
                  </div>
                )}
                {user.tenantCount !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Tenants Referred</span>
                    <span className="ml-auto font-medium">{user.tenantCount}</span>
                  </div>
                )}
              </>
            )}

            {/* Tenant-specific info */}
            {user.type === 'tenant' && (
              <>
                {user.hasRentRequest !== undefined && (
                  <div className="flex items-center gap-2 text-sm">
                    <Home className="h-4 w-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Rent Request</span>
                    <span className="ml-auto">
                      {user.hasRentRequest ? (
                        <Badge className="bg-success/10 text-success border-success/30 text-xs">Active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">None</Badge>
                      )}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Contact & ID */}
          {(user.phone || user.email || user.nationalId) && (
            <div className="space-y-3 bg-muted/30 rounded-lg p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contact & ID</p>
              {user.phone && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Phone</span>
                  <span className="ml-auto font-medium">{user.phone}</span>
                </div>
              )}
              {user.email && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Email</span>
                  <span className="ml-auto font-medium text-right break-all max-w-[180px]">{user.email}</span>
                </div>
              )}
              {user.nationalId && (
                <div className="flex items-center gap-2 text-sm">
                  <IdCard className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">National ID</span>
                  <span className="ml-auto font-mono text-xs bg-muted px-2 py-0.5 rounded">{user.nationalId}</span>
                </div>
              )}
            </div>
          )}

          {/* Location */}
          {(user.city || user.district || user.region || user.territory || user.country) && (
            <div className="space-y-3 bg-muted/30 rounded-lg p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Location</p>
              {(user.city || user.district || user.region) && (
                <div className="flex items-start gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
                  <span className="text-muted-foreground">Area</span>
                  <span className="ml-auto font-medium text-right max-w-[200px]">
                    {[user.city, user.district, user.region].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
              {user.territory && (
                <div className="flex items-center gap-2 text-sm">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Territory</span>
                  <span className="ml-auto font-medium">{user.territory}</span>
                </div>
              )}
              {user.country && (
                <div className="flex items-center gap-2 text-sm">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Country</span>
                  <span className="ml-auto font-medium">{user.country}</span>
                </div>
              )}
            </div>
          )}

          {/* Rent details (tenants) */}
          {user.type === 'tenant' && (user.stage || user.tenantStatus || (user.monthlyRent && user.monthlyRent > 0)) && (
            <div className="space-y-3 bg-muted/30 rounded-lg p-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Rent Details</p>
              {user.stage && (
                <div className="flex items-center gap-2 text-sm">
                  <Tag className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Stage</span>
                  <span className="ml-auto">
                    <Badge variant="secondary" className="text-xs capitalize">{STAGE_LABELS[user.stage] || user.stage}</Badge>
                  </span>
                </div>
              )}
              {user.tenantStatus && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Status</span>
                  <span className="ml-auto">
                    <Badge variant="secondary" className="text-xs capitalize">{user.tenantStatus}</Badge>
                  </span>
                </div>
              )}
              {user.monthlyRent && user.monthlyRent > 0 && (
                <div className="flex items-center gap-2 text-sm">
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Monthly Rent</span>
                  <span className="ml-auto font-semibold">{fmtUGX(user.monthlyRent)}</span>
                </div>
              )}
            </div>
          )}

          <Separator />

          {/* Verification Checklist */}
          <VerificationChecklist userId={user.id} highlightRole={user.type} compact />

          <Separator />

          {/* Activity Stats */}
          <UserStatsSection stats={stats} loading={statsLoading} />

          {stats.tenantsRegistered > 0 || stats.landlordsRegistered > 0 || stats.subAgentsRecruited > 0 || stats.supportersRegistered > 0 || stats.tenantsEarningFrom > 0 ? <Separator /> : null}

          {/* Reviews & Ratings Section */}
          <UserReviewsSection
            userId={user.id}
            userName={user.name}
          />

          {/* Privacy notice */}
          <p className="text-xs text-muted-foreground text-center">
            Phone numbers are hidden for privacy. Use in-app chat or request WhatsApp access.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

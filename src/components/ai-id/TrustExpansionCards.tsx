import { motion } from 'framer-motion';
import { Activity, MapPin, Home } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import type { TrustProfile } from '@/hooks/useTrustProfile';

interface Props {
  profile: TrustProfile;
}

/** Cash-flow capacity card — daily/weekly/monthly money movement */
export function CashFlowCapacityCard({ profile }: Props) {
  const cf = profile.cash_flow_capacity;
  const hasFlow = cf && cf.monthly_avg > 0;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Cash Flow Capacity
            <Badge variant="outline" className="text-[9px] ml-auto">Lender Signal</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {!hasFlow ? (
            <p className="text-xs text-muted-foreground text-center py-3">
              No wallet activity yet — start using Welile Wallet to build cash-flow history.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2">
                <FlowStat label="Daily" value={formatUGX(cf.daily_avg)} />
                <FlowStat label="Weekly" value={formatUGX(cf.weekly_avg)} />
                <FlowStat label="Monthly" value={formatUGX(cf.monthly_avg)} accent />
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 text-center">
                Average money flowing through this user (last {cf.window_days} days)
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

/** Movement behavior card — venue visits & GPS reliability */
export function MovementBehaviorCard({ profile }: Props) {
  const b = profile.behavior;
  const hasData = b.visits_total_60d > 0 || b.always_share_location;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.22 }}>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" />
            Movement & Findability
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          {!hasData ? (
            <p className="text-xs text-muted-foreground text-center py-3">
              No movement data — enable always-on GPS to build this signal.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <BehaviorStat label="Worship visits" value={String(b.worship_visits || 0)} />
                <BehaviorStat label="Mall visits" value={String(b.mall_visits || 0)} />
                <BehaviorStat label="Restaurant visits" value={String(b.restaurant_visits || 0)} />
                <BehaviorStat label="Hotel visits" value={String(b.hotel_visits || 0)} />
              </div>
              <div className="mt-3 pt-3 border-t border-border/50 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Always-on GPS</span>
                  <Badge variant={b.always_share_location ? 'default' : 'outline'} className="text-[9px]">
                    {b.always_share_location ? 'Enabled ✓' : 'Off'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">GPS captures (30d)</span>
                  <span className="font-mono">{b.location_captures_30d || 0}</span>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

/** Landlord listings card — guaranteed rent boost */
export function LandlordListingsCard({ profile }: Props) {
  const la = profile.landlord_activity;
  if (la.total_listings === 0) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.26 }}>
      <Card className="bg-gradient-to-br from-emerald-500/10 to-primary/5 border-emerald-500/20">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Home className="h-4 w-4 text-emerald-600" />
            Landlord Activity
            {la.guaranteed_rent && (
              <Badge className="text-[9px] ml-auto bg-emerald-600 hover:bg-emerald-600">Guaranteed Rent</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="grid grid-cols-2 gap-3">
            <BehaviorStat label="Total listings" value={String(la.total_listings)} />
            <BehaviorStat label="Verified" value={String(la.verified_listings)} accent />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function FlowStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="p-2.5 sm:p-3 rounded-xl bg-muted/40 border border-border/50 text-center min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p className={`text-[11px] sm:text-xs font-bold mt-1 break-words leading-tight ${accent ? 'text-emerald-600' : 'text-foreground'}`}>{value}</p>
    </div>
  );
}

function BehaviorStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="p-2.5 sm:p-3 rounded-xl bg-muted/40 border border-border/50 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground truncate">{label}</p>
      <p className={`text-sm font-bold mt-0.5 break-words leading-tight ${accent ? 'text-emerald-600' : 'text-foreground'}`}>{value}</p>
    </div>
  );
}

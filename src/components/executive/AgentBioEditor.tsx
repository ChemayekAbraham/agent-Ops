import { Badge } from '@/components/ui/badge';
import { ShieldCheck, AlertCircle, Phone, Mail, MapPin, CreditCard, User, Calendar, Award } from 'lucide-react';

const dt = (v?: string | null) => (v ? new Date(v).toLocaleDateString() : '—');

interface Props {
  agentId: string | null;
  bio: any;
  allowEdit?: boolean;
}

export function AgentBioEditor({ bio }: Props) {
  const isFrozen = Boolean(bio?.is_frozen);
  const isVerified = Boolean(bio?.verified);

  return (
    <div className="space-y-3">
      {/* Account Status Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-xl border border-border/80 bg-background/60 p-2.5 space-y-0.5">
          <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
            <ShieldCheck className="h-3 w-3 text-emerald-600" /> Verification
          </span>
          <div>
            {isVerified ? (
              <Badge variant="outline" className="text-[10.5px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 font-semibold px-2 py-0">
                Verified
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10.5px] text-amber-600 border-amber-500/40 bg-amber-50/50 dark:bg-amber-950/20 font-semibold px-2 py-0">
                Unverified
              </Badge>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border/80 bg-background/60 p-2.5 space-y-0.5">
          <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-muted-foreground" /> Account State
          </span>
          <div>
            {isFrozen ? (
              <Badge variant="destructive" className="text-[10.5px] font-semibold px-2 py-0">
                Frozen
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10.5px] border-emerald-500/40 text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 font-semibold px-2 py-0">
                Active
              </Badge>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-border/80 bg-background/60 p-2.5 space-y-0.5">
          <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
            <Award className="h-3 w-3 text-primary" /> Agent Tier
          </span>
          <p className="text-xs font-bold text-foreground">
            {bio?.agent_tier ? `Tier ${bio.agent_tier}` : 'Standard'}
          </p>
        </div>

        <div className="rounded-xl border border-border/80 bg-background/60 p-2.5 space-y-0.5">
          <span className="text-[10px] uppercase font-semibold text-muted-foreground flex items-center gap-1">
            <Calendar className="h-3 w-3 text-muted-foreground" /> Last Active
          </span>
          <p className="text-xs font-semibold text-foreground truncate">
            {dt(bio?.last_active_at)}
          </p>
        </div>
      </div>

      {/* Personal & Contact Details */}
      <div className="rounded-2xl border border-border/80 bg-background p-3.5 space-y-2.5">
        <div className="flex items-center gap-1.5 pb-2 border-b border-border/60">
          <User className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-bold text-foreground">Identity & Contact Information</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Full Name</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.full_name || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
              <Phone className="h-2.5 w-2.5" /> Phone
            </p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.phone || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
              <Mail className="h-2.5 w-2.5" /> Email
            </p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.email || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">National ID (NIN)</p>
            <p className="text-xs font-semibold text-foreground break-words font-mono">{bio?.national_id || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Occupation</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.occupation || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Joined Date</p>
            <p className="text-xs font-semibold text-foreground break-words">{dt(bio?.created_at)}</p>
          </div>
        </div>
      </div>

      {/* Operating Location */}
      <div className="rounded-2xl border border-border/80 bg-background p-3.5 space-y-2.5">
        <div className="flex items-center gap-1.5 pb-2 border-b border-border/60">
          <MapPin className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-bold text-foreground">Operating Location</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Region</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.region || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">District</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.district || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Sub-County</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.sub_county || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Village</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.village || '—'}</p>
          </div>
          <div className="space-y-0.5 sm:col-span-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Territory</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.territory || '—'}</p>
          </div>
        </div>
      </div>

      {/* Mobile Money Details */}
      <div className="rounded-2xl border border-border/80 bg-background p-3.5 space-y-2.5">
        <div className="flex items-center gap-1.5 pb-2 border-b border-border/60">
          <CreditCard className="h-3.5 w-3.5 text-primary" />
          <p className="text-xs font-bold text-foreground">Mobile Money & Payout Channel</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Number</p>
            <p className="text-xs font-semibold text-foreground break-words font-mono">{bio?.mobile_money_number || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Account Name</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.mobile_money_name || '—'}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Provider</p>
            <p className="text-xs font-semibold text-foreground break-words">{bio?.mobile_money_provider || 'MTN / Airtel'}</p>
          </div>
        </div>
      </div>

      {/* Frozen Warning if applicable */}
      {isFrozen && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <div className="flex items-center gap-1.5 font-bold mb-1">
            <AlertCircle className="h-4 w-4" /> Account Frozen
          </div>
          <p className="text-muted-foreground">{bio?.frozen_reason || 'No specific reason provided.'}</p>
        </div>
      )}
    </div>
  );
}

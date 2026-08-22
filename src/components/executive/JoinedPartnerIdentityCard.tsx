import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { CheckCircle2, AlertTriangle, UserCheck, UserPlus, Clock, MapPin, ShieldCheck } from 'lucide-react';

const last9 = (v?: string | null) => (v || '').replace(/\D/g, '').slice(-9);
const norm = (v?: string | null) => (v || '').trim().toLowerCase().replace(/\s+/g, ' ');

interface Props {
  /** Profile id of the partner who actually came in and registered */
  userId: string | null;
  /** What the agent wrote on the promissory note */
  notePartnerName?: string | null;
  noteWhatsapp?: string | null;
  notePhone?: string | null;
  noteEmail?: string | null;
  /** Agent who wrote the note (to detect self-registration vs agent referral) */
  noteAgentId?: string | null;
  noteAgentName?: string | null;
  /** Timestamp captured on the note when the partner came in */
  cameInAt?: string | null;
}

function MatchRow({
  label,
  noteValue,
  realValue,
  match,
}: {
  label: string;
  noteValue?: string | null;
  realValue?: string | null;
  match: 'yes' | 'no' | 'na';
}) {
  return (
    <div className="grid grid-cols-[84px_1fr_1fr_18px] items-start gap-2 text-xs py-1.5 border-b last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate" title={noteValue || undefined}>{noteValue || <span className="text-muted-foreground">—</span>}</span>
      <span className={cn('truncate font-medium', match === 'no' && 'text-amber-700')} title={realValue || undefined}>
        {realValue || <span className="text-muted-foreground font-normal">—</span>}
      </span>
      <span className="pt-0.5">
        {match === 'yes' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
        {match === 'no' && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
      </span>
    </div>
  );
}

export function JoinedPartnerIdentityCard({
  userId,
  notePartnerName,
  noteWhatsapp,
  notePhone,
  noteEmail,
  noteAgentId,
  noteAgentName,
  cameInAt,
}: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['promissory-joined-identity', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select(
          'id, full_name, phone, email, created_at, signup_source, referrer_id, verified, phone_verified, whatsapp_verified, national_id, region, district, village, town, occupation, mobile_money_name, mobile_money_number',
        )
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      let referrer: { id: string; full_name: string | null; phone: string | null } | null = null;
      if (profile?.referrer_id) {
        const { data: ref } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .eq('id', profile.referrer_id)
          .maybeSingle();
        referrer = (ref as any) || null;
      }
      return { profile: profile as any, referrer };
    },
  });

  if (!userId) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-3 space-y-1">
          <p className="text-xs font-medium text-muted-foreground uppercase">Joined account</p>
          <p className="text-sm text-muted-foreground">
            This partner has not registered an account yet, so there are no live details to compare against the note.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <p className="text-xs text-muted-foreground">Loading joined partner details…</p>
        </CardContent>
      </Card>
    );
  }

  const p = data?.profile;
  const referrer = data?.referrer;
  if (!p) {
    return (
      <Card>
        <CardContent className="p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase">Joined account</p>
          <p className="text-sm text-muted-foreground">Account record is not visible to your role.</p>
        </CardContent>
      </Card>
    );
  }

  const noteNumbers = [last9(noteWhatsapp), last9(notePhone)].filter(Boolean);
  const realNumbers = [last9(p.phone), last9(p.mobile_money_number)].filter(Boolean);
  const phoneMatch: 'yes' | 'no' | 'na' =
    !noteNumbers.length || !realNumbers.length ? 'na' : noteNumbers.some((n) => realNumbers.includes(n)) ? 'yes' : 'no';

  const nameMatch: 'yes' | 'no' | 'na' =
    !notePartnerName || !p.full_name ? 'na' : norm(notePartnerName) === norm(p.full_name) ? 'yes' : 'no';

  const emailMatch: 'yes' | 'no' | 'na' =
    !noteEmail || !p.email ? 'na' : norm(noteEmail) === norm(p.email) ? 'yes' : 'no';

  const mismatches = [nameMatch, phoneMatch, emailMatch].filter((m) => m === 'no').length;

  const selfRegistered = !p.referrer_id;
  const referredByNoteAgent = !!noteAgentId && p.referrer_id === noteAgentId;

  const location = [p.village, p.town, p.district, p.region].filter(Boolean).join(', ');

  return (
    <Card className={cn('border', mismatches ? 'border-amber-300 bg-amber-50/40' : 'border-emerald-200 bg-emerald-50/30')}>
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground uppercase">Joined account vs promissory note</p>
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              mismatches
                ? 'bg-amber-100 text-amber-800 border-amber-300'
                : 'bg-emerald-100 text-emerald-800 border-emerald-300',
            )}
          >
            {mismatches ? `${mismatches} mismatch${mismatches > 1 ? 'es' : ''}` : 'Details match'}
          </Badge>
        </div>

        {/* Comparison table */}
        <div>
          <div className="grid grid-cols-[84px_1fr_1fr_18px] gap-2 text-[10px] uppercase text-muted-foreground pb-1 border-b">
            <span>Field</span>
            <span>On note</span>
            <span>Real account</span>
            <span />
          </div>
          <MatchRow label="Name" noteValue={notePartnerName} realValue={p.full_name} match={nameMatch} />
          <MatchRow
            label="Phone"
            noteValue={noteWhatsapp || notePhone}
            realValue={p.phone || p.mobile_money_number}
            match={phoneMatch}
          />
          <MatchRow label="Email" noteValue={noteEmail} realValue={p.email} match={emailMatch} />
          <MatchRow label="Mobile money" noteValue={null} realValue={p.mobile_money_name} match="na" />
          <MatchRow label="National ID" noteValue={null} realValue={p.national_id} match="na" />
        </div>

        {/* Join timeline */}
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md bg-background/70 border p-2">
            <p className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Account created
            </p>
            <p className="font-semibold">{p.created_at ? format(new Date(p.created_at), 'dd MMM yyyy HH:mm') : '—'}</p>
          </div>
          <div className="rounded-md bg-background/70 border p-2">
            <p className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
              <UserCheck className="h-3 w-3" /> Marked joined
            </p>
            <p className="font-semibold">{cameInAt ? format(new Date(cameInAt), 'dd MMM yyyy HH:mm') : '—'}</p>
          </div>
        </div>

        {/* Origin */}
        <div className="rounded-md bg-background/70 border p-2 space-y-1">
          <p className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
            {selfRegistered ? <UserPlus className="h-3 w-3" /> : <UserCheck className="h-3 w-3" />} How they joined
          </p>
          {selfRegistered ? (
            <p className="text-sm font-medium">Self registered — no referring agent on the account</p>
          ) : (
            <p className="text-sm font-medium">
              Referred by {referrer?.full_name || 'another agent'}
              {referrer?.phone ? <span className="text-muted-foreground font-normal"> · {referrer.phone}</span> : null}
            </p>
          )}
          {!selfRegistered && (
            <p className="text-xs text-muted-foreground">
              {referredByNoteAgent
                ? `Same agent who wrote this note (${noteAgentName || 'note agent'}) — attribution is consistent.`
                : `Different from the note agent (${noteAgentName || 'note agent'}) — attribution conflict, verify before paying bonuses.`}
            </p>
          )}
          {p.signup_source && (
            <p className="text-xs text-muted-foreground">Signup channel: {String(p.signup_source).replace(/_/g, ' ')}</p>
          )}
        </div>

        {/* Verification + location */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              'text-[10px]',
              p.verified ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-muted text-muted-foreground',
            )}
          >
            <ShieldCheck className="h-3 w-3 mr-1" /> {p.verified ? 'Verified' : 'Not verified'}
          </Badge>
          {p.phone_verified && (
            <Badge variant="outline" className="text-[10px] bg-sky-100 text-sky-800 border-sky-300">Phone verified</Badge>
          )}
          {p.whatsapp_verified && (
            <Badge variant="outline" className="text-[10px] bg-sky-100 text-sky-800 border-sky-300">WhatsApp verified</Badge>
          )}
          {p.occupation && <Badge variant="outline" className="text-[10px]">{p.occupation}</Badge>}
        </div>
        {location && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5 shrink-0" /> {location}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

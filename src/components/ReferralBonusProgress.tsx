import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Lock, Unlock, Gift, CheckCircle2, Clock, ChevronDown } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface BonusRow {
  referral_id: string;
  referred_id: string;
  referred_name: string | null;
  created_at: string;
  restricted_amount: number;
  unlocked: boolean;
  unlocked_at: string | null;
  progress: {
    qualified: boolean;
    houses_verified: number; houses_required: number;
    rent_submitted: number; rent_submitted_required: number;
    rent_approved_paid: number; rent_approved_paid_required: number;
    landlords_total: number; landlords_verified: number; landlords_required: number;
    lc1_total: number; lc1_verified: number; lc1_required: number;
  } | null;
}

function Milestone({ label, done, required, complete }: { label: string; done: number; required: number; complete: boolean }) {
  const pct = Math.min(100, Math.round((done / Math.max(required, 1)) * 100));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5">
          {complete ? <CheckCircle2 className="h-3.5 w-3.5 text-success" /> : <Clock className="h-3.5 w-3.5 text-warning" />}
          <span className={complete ? 'text-success font-medium' : ''}>{label}</span>
        </span>
        <span className="tabular-nums font-medium">{done} / {required}</span>
      </div>
      <Progress value={pct} className="h-1.5" />
    </div>
  );
}

export function ReferralBonusProgress() {
  const { user } = useAuth();
  const [rows, setRows] = useState<BonusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      const { data, error } = await supabase.rpc('get_my_referral_bonuses');
      if (!alive) return;
      if (!error && data) setRows(data as BonusRow[]);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [user]);

  if (loading || rows.length === 0) return null;

  const locked = rows.filter(r => !r.unlocked);
  const unlocked = rows.filter(r => r.unlocked);
  const restrictedTotal = locked.reduce((s, r) => s + Number(r.restricted_amount), 0);
  const unlockedTotal = unlocked.reduce((s, r) => s + Number(r.restricted_amount), 0);

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="flex w-full items-center justify-between gap-2 flex-wrap text-left"
          aria-expanded={open}
          aria-controls="referral-bonus-progress-content"
        >
          <CardTitle className="flex items-center gap-2 text-lg">
            <Gift className="h-5 w-5 text-primary" />
            Referral Bonus Progress
          </CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex gap-2">
              <Badge variant="secondary" className="gap-1"><Lock className="h-3 w-3" /> {formatUGX(restrictedTotal)} restricted</Badge>
              <Badge className="gap-1 bg-success text-success-foreground"><Unlock className="h-3 w-3" /> {formatUGX(unlockedTotal)} unlocked</Badge>
            </div>
            <ChevronDown className={cn('h-5 w-5 text-muted-foreground transition-transform', open && 'rotate-180')} />
          </div>
        </button>
        <p className="text-xs text-muted-foreground mt-1">
          Each referral earns UGX 100. The bonus unlocks only after your invite completes all platform milestones below.
        </p>
      </CardHeader>
      {open && (
        <CardContent id="referral-bonus-progress-content" className="space-y-3">
          {rows.slice(0, 20).map((r) => {
          const p = r.progress;
          if (!p) return null;
          const landlordsComplete = p.landlords_total >= p.landlords_required && p.landlords_verified === p.landlords_total;
          const lc1Complete = p.lc1_total >= p.lc1_required && p.lc1_verified === p.lc1_total;
          const housesComplete = p.houses_verified >= p.houses_required;
          const submittedComplete = p.rent_submitted >= p.rent_submitted_required;
          const paidComplete = p.rent_approved_paid >= p.rent_approved_paid_required;

          return (
            <div key={r.referral_id} className="rounded-lg border p-3 space-y-3 bg-background/60">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">
                    {r.referred_name || `Invite · …${r.referred_id.slice(-6)}`}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    Joined {format(new Date(r.created_at), 'MMM d, yyyy')}
                  </p>
                </div>
                {r.unlocked ? (
                  <Badge className="gap-1 bg-success text-success-foreground">
                    <Unlock className="h-3 w-3" /> +{formatUGX(Number(r.restricted_amount))} unlocked
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1">
                    <Lock className="h-3 w-3" /> {formatUGX(Number(r.restricted_amount))} locked
                  </Badge>
                )}
              </div>

              {!r.unlocked && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Milestone label="Verified houses listed" done={p.houses_verified} required={p.houses_required} complete={housesComplete} />
                  <Milestone label="Rent requests submitted" done={p.rent_submitted} required={p.rent_submitted_required} complete={submittedComplete} />
                  <Milestone label="Approved & paid rents" done={p.rent_approved_paid} required={p.rent_approved_paid_required} complete={paidComplete} />
                  <Milestone label="Verified landlords" done={p.landlords_verified} required={p.landlords_required} complete={landlordsComplete} />
                  <Milestone label="Verified LC1 chairpersons" done={p.lc1_verified} required={p.lc1_required} complete={lc1Complete} />
                </div>
              )}
            </div>
          );
        })}
        </CardContent>
      )}
    </Card>
  );
}
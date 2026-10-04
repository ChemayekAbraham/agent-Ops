import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, PhoneCall, ShieldCheck, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * The two numbers every merchant agent MUST record before they can work:
 *   • Float number  — the line the company sends payout float to.
 *   • Personal number — the line their own money (commission, personal
 *     withdrawals) is sent to.
 * They must be different so company float never lands on the personal line.
 */
export interface MerchantPayoutNumbers {
  deskId: string;
  floatPhone: string | null;
  personalPhone: string | null;
  complete: boolean;
}

export function useMerchantPayoutNumbers(agentId?: string | null) {
  return useQuery({
    queryKey: ['merchant-payout-numbers', agentId],
    enabled: !!agentId,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<MerchantPayoutNumbers | null> => {
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('id, float_phone, personal_phone')
        .eq('agent_id', agentId!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const row = data as any;
      const floatPhone = row.float_phone ?? null;
      const personalPhone = row.personal_phone ?? null;
      return {
        deskId: String(row.id),
        floatPhone,
        personalPhone,
        complete: !!floatPhone && !!personalPhone && floatPhone !== personalPhone,
      };
    },
  });
}

function looksValid(raw: string) {
  const digits = raw.replace(/\D/g, '');
  return (
    /^2567\d{8}$/.test(digits) ||
    /^07\d{8}$/.test(digits) ||
    /^7\d{8}$/.test(digits)
  );
}

function canonical(raw: string) {
  const d = raw.replace(/\D/g, '');
  if (/^2567\d{8}$/.test(d)) return d;
  if (/^07\d{8}$/.test(d)) return `256${d.slice(1)}`;
  if (/^7\d{8}$/.test(d)) return `256${d}`;
  return d;
}

/**
 * Hard blocking screen. Rendered INSTEAD of the merchant dashboard until both
 * numbers are saved — no dismiss, no skip, no work until then.
 */
export function MerchantPayoutNumbersGate({
  agentId,
  existing,
}: {
  agentId: string;
  existing?: MerchantPayoutNumbers | null;
}) {
  const qc = useQueryClient();
  const [floatPhone, setFloatPhone] = useState(existing?.floatPhone ?? '');
  const [personalPhone, setPersonalPhone] = useState(existing?.personalPhone ?? '');

  const sameNumber =
    !!floatPhone && !!personalPhone && canonical(floatPhone) === canonical(personalPhone);
  const ready = looksValid(floatPhone) && looksValid(personalPhone) && !sameNumber;

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('merchant_set_payout_numbers' as any, {
        p_float_phone: floatPhone,
        p_personal_phone: personalPhone,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Numbers saved — you can now start working');
      qc.invalidateQueries({ queryKey: ['merchant-payout-numbers', agentId] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not save your numbers'),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-3xl border-2 border-destructive/40 bg-destructive/5 p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-destructive/15 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-bold text-foreground">
              Add your two phone numbers to start working
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Your merchant desk is locked. You cannot pay anyone, claim a request or use any tool
              until you tell us which number receives company float and which number receives your
              own money. The two numbers must be different.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 rounded-3xl border border-border/60 bg-card p-5">
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-bold">
            <Wallet className="h-4 w-4 text-primary" /> Number for receiving float
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Company money for paying customers is sent here. Use the line you pay people from.
          </p>
          <Input
            inputMode="tel"
            placeholder="0772 000 000"
            value={floatPhone}
            onChange={(e) => setFloatPhone(e.target.value)}
          />
          {!!floatPhone && !looksValid(floatPhone) && (
            <p className="text-[11px] text-destructive">Enter a valid Uganda mobile number.</p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-bold">
            <PhoneCall className="h-4 w-4 text-primary" /> Number for your own money
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Your commission and your personal withdrawals are sent here. It must be a different
            number from the float one.
          </p>
          <Input
            inputMode="tel"
            placeholder="0700 000 000"
            value={personalPhone}
            onChange={(e) => setPersonalPhone(e.target.value)}
          />
          {!!personalPhone && !looksValid(personalPhone) && (
            <p className="text-[11px] text-destructive">Enter a valid Uganda mobile number.</p>
          )}
          {sameNumber && (
            <p className="text-[11px] text-destructive">
              This is the same as your float number. They must be different.
            </p>
          )}
        </div>

        <Button
          className="w-full"
          disabled={!ready || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            <>
              <ShieldCheck className="mr-2 h-4 w-4" /> Save my numbers and unlock
            </>
          )}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">
          Finance uses these numbers to send float and to pay you. Keep them correct.
        </p>
      </div>
    </div>
  );
}

export default MerchantPayoutNumbersGate;

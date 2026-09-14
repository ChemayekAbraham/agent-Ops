/**
 * National ID prompt.
 *
 * Anyone holding a withdrawable balance must record their National ID and the
 * exact name printed on it. Financial Ops compares that name with the name on
 * the mobile money number or bank account before any payout is released, so
 * this cannot be skipped — it only disappears once the ID is submitted.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IdCard, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSubmitNationalId } from '@/hooks/usePayoutVerification';
import { useIsFunderWithPortfolio } from '@/hooks/useIsFunderWithPortfolio';
import {
  NATIONAL_ID_MAX_LENGTH,
  normalizeNationalId,
  validateNationalId,
  validateNationalIdName,
} from '@/lib/nationalId';

export function useMyNationalId() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-national-id', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id, national_id_name, full_name')
        .eq('id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as
        | { national_id: string | null; national_id_name: string | null; full_name: string | null }
        | null;
    },
  });
}

export default function NationalIdPrompt({
  withdrawableBalance,
  className,
  blocking = false,
  allowResubmit = false,
}: {
  withdrawableBalance: number;
  className?: string;
  /** Red, "you cannot continue" styling used inside the withdraw flow. */
  blocking?: boolean;
  /** Keep rendering even when an ID is already on file — used after a rejection. */
  allowResubmit?: boolean;
}) {
  const { user } = useAuth();
  // Funders holding an investor portfolio are exempt — their identity and
  // payout details were captured with the portfolio.
  const funder = useIsFunderWithPortfolio(user?.id);
  const { data, isLoading, refetch } = useMyNationalId();
  const submit = useSubmitNationalId();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState<{ id: boolean; name: boolean }>({ id: false, name: false });

  const idCheck = validateNationalId(id);
  const nameCheck = validateNationalIdName(name);
  const canSave = idCheck.valid && nameCheck.valid && !submit.isPending;

  const alreadyDone = !!data?.national_id;
  if (
    isLoading ||
    funder.isLoading ||
    funder.isFunder ||
    (alreadyDone && !allowResubmit) ||
    withdrawableBalance <= 0
  )
    return null;

  const save = async () => {
    if (!idCheck.valid || !nameCheck.valid) {
      setTouched({ id: true, name: true });
      toast.error(idCheck.error || nameCheck.error || 'Check your National ID details.');
      return;
    }
    try {
      await submit.mutateAsync({ nationalId: idCheck.value, idName: nameCheck.value });
      toast.success('National ID saved. Financial Ops will confirm it against your payout number.');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save your National ID.');
    }
  };

  const tone = blocking
    ? 'border-destructive/50 bg-destructive/5'
    : 'border-amber-500/40 bg-amber-500/5';

  return (
    <div className={`rounded-2xl border-2 p-4 space-y-3 ${tone} ${className ?? ''}`}>
      <div className="flex items-start gap-3">
        <div
          className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
            blocking ? 'bg-destructive/15' : 'bg-amber-500/15'
          }`}
        >
          <IdCard className={`h-5 w-5 ${blocking ? 'text-destructive' : 'text-amber-600'}`} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">
            {blocking ? 'Verify your wallet before you withdraw' : 'Add your National ID'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Your money can only be sent to a number or bank account in your own name. Enter your
            National ID and the exact name printed on it.
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <div>
          <Label className="text-xs">National ID number</Label>
          <Input
            value={id}
            onChange={(e) => setId(normalizeNationalId(e.target.value))}
            onBlur={() => setTouched((t) => ({ ...t, id: true }))}
            placeholder="CM12345678ABCD"
            className="h-11 text-sm tracking-wider"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={NATIONAL_ID_MAX_LENGTH}
            aria-invalid={touched.id && !idCheck.valid}
          />
          {touched.id && idCheck.error ? (
            <p className="text-[11px] text-destructive mt-1">{idCheck.error}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-1">
              {id.length}/{NATIONAL_ID_MAX_LENGTH} characters, letters and numbers only.
            </p>
          )}
        </div>
        <div>
          <Label className="text-xs">Full name exactly as printed on the ID</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            placeholder="e.g. Nakato Sarah Namuli"
            className="h-11 text-sm"
            autoCorrect="off"
            spellCheck={false}
            maxLength={120}
            aria-invalid={touched.name && !nameCheck.valid}
          />
          {touched.name && nameCheck.error && (
            <p className="text-[11px] text-destructive mt-1">{nameCheck.error}</p>
          )}
        </div>
      </div>
      <Button onClick={save} disabled={!canSave} className="w-full h-11">
        {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <ShieldCheck className="h-4 w-4 mr-1.5" />}
        Save my National ID
      </Button>
    </div>
  );
}

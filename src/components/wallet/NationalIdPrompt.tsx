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
}: {
  withdrawableBalance: number;
  className?: string;
}) {
  const { data, isLoading, refetch } = useMyNationalId();
  const submit = useSubmitNationalId();
  const [id, setId] = useState('');
  const [name, setName] = useState('');

  const alreadyDone = !!data?.national_id;
  if (isLoading || alreadyDone || withdrawableBalance <= 0) return null;

  const save = async () => {
    try {
      await submit.mutateAsync({ nationalId: id.trim(), idName: name.trim() });
      toast.success('National ID saved. Financial Ops will confirm it against your payout number.');
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save your National ID.');
    }
  };

  return (
    <div
      className={`rounded-2xl border-2 border-amber-500/40 bg-amber-500/5 p-4 space-y-3 ${className ?? ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-amber-500/15 flex items-center justify-center shrink-0">
          <IdCard className="h-5 w-5 text-amber-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">Add your National ID</p>
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
            onChange={(e) => setId(e.target.value.toUpperCase())}
            placeholder="CM12345678AB"
            className="h-11 text-sm"
            inputMode="text"
            autoCapitalize="characters"
          />
        </div>
        <div>
          <Label className="text-xs">Full name exactly as printed on the ID</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Nakato Sarah Namuli"
            className="h-11 text-sm"
          />
        </div>
      </div>
      <Button onClick={save} disabled={submit.isPending} className="w-full h-11">
        {submit.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <ShieldCheck className="h-4 w-4 mr-1.5" />}
        Save my National ID
      </Button>
    </div>
  );
}

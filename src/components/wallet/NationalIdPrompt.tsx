import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BadgeCheck, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useMyNationalId, useSubmitNationalId } from '@/hooks/usePayoutVerification';

interface NationalIdPromptProps {
  /** Only prompt people who actually have money to take out. */
  maxAmount?: number;
  /**
   * When true the card is styled as a hard stop (used inside the withdraw
   * flow, where nothing can continue until the ID is recorded).
   */
  blocking?: boolean;
  onSubmitted?: () => void;
}

/**
 * Asks a wallet holder for their National ID number and the name exactly as
 * printed on it, so Financial Ops can compare it against the mobile money or
 * bank account name before any payout. Writes through `submit_national_id`.
 */
export default function NationalIdPrompt({ maxAmount = 1, blocking = false, onSubmitted }: NationalIdPromptProps) {
  const { user } = useAuth();
  const my = useMyNationalId(user?.id);
  const submit = useSubmitNationalId();
  const [nationalId, setNationalId] = useState('');
  const [idName, setIdName] = useState('');

  if (!user?.id || my.isLoading || my.data?.submitted || maxAmount <= 0) return null;

  const save = async () => {
    try {
      const res = await submit.mutateAsync({ nationalId, idName });
      toast.success(res.message || 'National ID recorded.');
      onSubmitted?.();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Could not record your National ID.');
    }
  };

  return (
    <Card
      className={`p-4 space-y-3 ${blocking ? 'border-2 border-destructive bg-destructive/5' : 'border-2 border-primary/40 bg-primary/5'}`}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {blocking ? (
            <ShieldAlert className="h-5 w-5 text-destructive" />
          ) : (
            <BadgeCheck className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="space-y-1">
          <h4 className="font-semibold leading-tight">
            {blocking ? 'Verify your wallet before you withdraw' : 'Add your National ID'}
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Enter your National ID number and your name exactly as printed on the ID. Financial Ops
            will confirm it matches the mobile money or bank account name before any money is sent.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="nid-number">National ID number</Label>
        <Input
          id="nid-number"
          value={nationalId}
          onChange={(e) => setNationalId(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="CM90000000000"
          inputMode="text"
          autoComplete="off"
          maxLength={14}
          disabled={submit.isPending}
          className="h-12 text-base tracking-wider"
        />
        <p className="text-xs text-muted-foreground">10 to 14 letters and numbers, no spaces.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="nid-name">Name exactly as printed on the ID</Label>
        <Input
          id="nid-name"
          value={idName}
          onChange={(e) => setIdName(e.target.value)}
          placeholder="e.g. NAKATO SARAH MIREMBE"
          autoComplete="off"
          disabled={submit.isPending}
          className="h-12 text-base"
        />
      </div>

      <Button onClick={save} disabled={submit.isPending} className="w-full h-12">
        {submit.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
          </>
        ) : (
          'Submit for verification'
        )}
      </Button>
    </Card>
  );
}

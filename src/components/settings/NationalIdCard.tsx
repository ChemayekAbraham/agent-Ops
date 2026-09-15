import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Loader2, Save, IdCard, Lock, Pencil, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useSubmitNationalId } from '@/hooks/usePayoutVerification';
import {
  normalizeNationalId,
  validateNationalId,
  validateNationalIdName,
  NATIONAL_ID_MAX_LENGTH,
} from '@/lib/nationalId';

interface Props {
  userId: string;
}

/**
 * National ID panel in Settings — allows users to proactively record their
 * National ID number and the exact name printed on it so Financial Ops can
 * verify payout destinations before withdrawals.
 */
export default function NationalIdCard({ userId }: Props) {
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

  const [savedNationalId, setSavedNationalId] = useState('');
  const [savedIdName, setSavedIdName] = useState('');

  const [nationalId, setNationalId] = useState('');
  const [idName, setIdName] = useState('');
  const [touched, setTouched] = useState<{ id: boolean; name: boolean }>({ id: false, name: false });

  const submit = useSubmitNationalId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('profiles')
        .select('national_id, national_id_name, full_name')
        .eq('id', userId)
        .maybeSingle();
      if (cancelled) return;

      const nid = (data?.national_id ?? '').trim();
      const nnm = (data?.national_id_name ?? '').trim();
      const fn = (data?.full_name ?? '').trim();

      setSavedNationalId(nid);
      setSavedIdName(nnm);
      setNationalId(nid);
      setIdName(nnm || fn);
      setEditing(!nid || !nnm);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const idCheck = validateNationalId(nationalId);
  const nameCheck = validateNationalIdName(idName);

  const handleSave = async () => {
    setTouched({ id: true, name: true });
    if (!idCheck.valid) {
      toast.error(idCheck.error || 'Enter a valid National ID number');
      return;
    }
    if (!nameCheck.valid) {
      toast.error(nameCheck.error || 'Enter your name exactly as printed on the National ID');
      return;
    }

    try {
      await submit.mutateAsync({
        nationalId: idCheck.value,
        idName: nameCheck.value,
      });

      setSavedNationalId(idCheck.value);
      setSavedIdName(nameCheck.value);
      setNationalId(idCheck.value);
      setIdName(nameCheck.value);
      setEditing(false);
      setTouched({ id: false, name: false });
      toast.success('National ID saved for Financial Ops verification');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not save National ID';
      toast.error(msg);
    }
  };

  const isSaved = !!savedNationalId && !!savedIdName;

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <IdCard className="h-4 w-4 text-primary" /> National ID
        </CardTitle>
        <CardDescription>
          The National Identification Number (NIN) and exact name on your ID.
          Financial Ops confirms these match your withdrawal account before
          funds are released.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !editing && isSaved ? (
          <>
            <div className="rounded-xl border bg-muted/40 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  NIN / ID Number
                </span>
                <span className="font-bold tracking-wider font-mono">{savedNationalId}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  Name on ID
                </span>
                <span className="font-semibold text-right truncate">{savedIdName}</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" />
              Recorded on file for payout verification. Must match the registered name on your withdrawal destination.
            </p>
            <Button
              variant="outline"
              className="w-full gap-2 h-12 rounded-xl text-sm font-bold"
              onClick={() => {
                setEditing(true);
                setTouched({ id: false, name: false });
              }}
            >
              <Pencil className="h-4 w-4" /> Edit National ID details
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label
                htmlFor="settings-nin"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                National ID number (NIN)
              </Label>
              <Input
                id="settings-nin"
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="e.g. CM12345678ABCD"
                value={nationalId}
                maxLength={NATIONAL_ID_MAX_LENGTH}
                onChange={(e) => setNationalId(normalizeNationalId(e.target.value))}
                onBlur={() => setTouched((t) => ({ ...t, id: true }))}
                disabled={submit.isPending}
                className="h-12 rounded-xl font-mono tracking-wider"
                aria-invalid={touched.id && !idCheck.valid}
              />
              {touched.id && idCheck.error ? (
                <p className="text-[11px] text-destructive">{idCheck.error}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {nationalId.length}/{NATIONAL_ID_MAX_LENGTH} characters, letters and numbers only.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="settings-id-name"
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider"
              >
                Full name exactly as printed on the ID
              </Label>
              <Input
                id="settings-id-name"
                type="text"
                autoComplete="name"
                placeholder="e.g. WATSALA ENOCK"
                value={idName}
                onChange={(e) => setIdName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                disabled={submit.isPending}
                className="h-12 rounded-xl"
                aria-invalid={touched.name && !nameCheck.valid}
              />
              {touched.name && nameCheck.error ? (
                <p className="text-[11px] text-destructive">{nameCheck.error}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  Must match the name on your National ID card word-for-word.
                </p>
              )}
            </div>

            <div className="flex gap-2">
              {isSaved && (
                <Button
                  variant="outline"
                  className="h-12 rounded-xl"
                  disabled={submit.isPending}
                  onClick={() => {
                    setNationalId(savedNationalId);
                    setIdName(savedIdName);
                    setEditing(false);
                    setTouched({ id: false, name: false });
                  }}
                >
                  Cancel
                </Button>
              )}
              <Button
                className="flex-1 gap-2 h-12 rounded-xl text-sm font-bold"
                onClick={handleSave}
                disabled={submit.isPending}
              >
                {submit.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save National ID
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5" />
              Your National ID is stored securely and used strictly for identity confirmation and payout security.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

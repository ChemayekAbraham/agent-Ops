import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

interface ConflictRow {
  id: string;
  phone_last9: string;
  attempted_user_id: string;
  existing_user_id: string | null;
  existing_source: string;
  detected_via: string;
  notes: string | null;
  created_at: string;
}

/**
 * Deposit-number link conflicts. Raised when a number discovered on a
 * positively-identified deposit is already linked to a DIFFERENT user
 * (likely a SIM swap or an earlier mistake). Nothing is relinked
 * automatically — Financial Ops reviews and resolves here.
 */
export function DepositNumberConflictsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['deposit-number-conflicts'],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('user_deposit_number_conflicts')
        .select('id, phone_last9, attempted_user_id, existing_user_id, existing_source, detected_via, notes, created_at')
        .is('resolved_at', null)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const conflicts = (rows ?? []) as ConflictRow[];
      const ids = Array.from(
        new Set(conflicts.flatMap((c) => [c.attempted_user_id, c.existing_user_id].filter(Boolean) as string[])),
      );
      const names = new Map<string, string>();
      if (ids.length) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        for (const p of profs ?? []) {
          names.set(p.id, `${p.full_name ?? 'Unnamed'}${p.phone ? ` (${p.phone})` : ''}`);
        }
      }
      return { conflicts, names };
    },
    staleTime: 60_000,
  });

  const resolve = useMutation({
    mutationFn: async (id: string) => {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('user_deposit_number_conflicts')
        .update({ resolved_at: new Date().toISOString(), resolved_by: auth.user?.id ?? null })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: 'Conflict marked reviewed' });
      qc.invalidateQueries({ queryKey: ['deposit-number-conflicts'] });
    },
    onError: (e: any) => toast({ title: 'Could not resolve', description: e.message, variant: 'destructive' }),
  });

  const conflicts = data?.conflicts ?? [];
  if (!isLoading && conflicts.length === 0) return null;

  return (
    <Card className="border-amber-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Number link conflicts
          {conflicts.length > 0 && <Badge variant="secondary">{conflicts.length}</Badge>}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          A deposit number already belongs to another user, so it was not relinked. Review each case
          (possible SIM swap or earlier mis-route).
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {conflicts.map((c) => (
          <div key={c.id} className="rounded border border-border p-2 text-xs space-y-1">
            <p className="font-mono font-medium">…{c.phone_last9}</p>
            <p>
              Tried to link to <span className="font-medium">{data?.names.get(c.attempted_user_id) ?? c.attempted_user_id}</span>
            </p>
            <p className="text-muted-foreground">
              Already owned by{' '}
              <span className="font-medium">
                {(c.existing_user_id && data?.names.get(c.existing_user_id)) ?? 'unknown user'}
              </span>{' '}
              via {c.existing_source} · detected on {c.detected_via.replace(/_/g, ' ')}
            </p>
            <div className="flex items-center justify-between pt-1">
              <span className="text-muted-foreground">{new Date(c.created_at).toLocaleString()}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(c.id)}
              >
                <Check className="h-3 w-3" />
                Mark reviewed
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

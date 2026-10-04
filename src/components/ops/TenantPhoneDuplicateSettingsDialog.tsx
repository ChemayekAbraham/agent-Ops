import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface DuplicateSettings {
  match_digits: number;
  min_group_size: number;
  enabled: boolean;
}

const DIGIT_HELP: Record<number, string> = {
  7: 'Loosest — flags numbers sharing the last 7 digits. More matches, more false positives.',
  8: 'Balanced — flags numbers sharing the last 8 digits (recommended).',
  9: 'Strictest — only full 9-digit collisions (mostly handled by the unique constraint).',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TenantPhoneDuplicateSettingsDialog({ open, onOpenChange }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['tenant-phone-duplicate-settings'],
    enabled: open,
    queryFn: async (): Promise<DuplicateSettings> => {
      const { data, error } = await supabase
        .from('tenant_phone_duplicate_settings')
        .select('match_digits, min_group_size, enabled')
        .eq('id', true)
        .maybeSingle();
      if (error) throw error;
      return (
        (data as DuplicateSettings) ?? { match_digits: 8, min_group_size: 2, enabled: true }
      );
    },
  });

  const [matchDigits, setMatchDigits] = useState(8);
  const [minGroup, setMinGroup] = useState(2);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (data) {
      setMatchDigits(data.match_digits);
      setMinGroup(data.min_group_size);
      setEnabled(data.enabled);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('tenant_phone_duplicate_settings')
        .upsert(
          {
            id: true,
            match_digits: matchDigits,
            min_group_size: minGroup,
            enabled,
            updated_by: u.user?.id ?? null,
          },
          { onConflict: 'id' },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast({
        title: 'Settings saved',
        description: 'The next scan will use the updated configuration.',
      });
      queryClient.invalidateQueries({ queryKey: ['tenant-phone-duplicate-settings'] });
      onOpenChange(false);
    },
    onError: (e) =>
      toast({ title: 'Save failed', description: (e as Error).message, variant: 'destructive' }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate Monitor Settings</DialogTitle>
          <DialogDescription>
            Tune how tenant phone near-duplicates are detected and when an alert is raised.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
          </div>
        ) : (
          <div className="space-y-5 py-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm">Monitor enabled</Label>
                <p className="text-xs text-muted-foreground">
                  When off, the hourly scan is skipped.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Signature length (trailing digits)</Label>
              <Select
                value={String(matchDigits)}
                onValueChange={(v) => setMatchDigits(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">Last 7 digits</SelectItem>
                  <SelectItem value="8">Last 8 digits</SelectItem>
                  <SelectItem value="9">Last 9 digits</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{DIGIT_HELP[matchDigits]}</p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">Alert threshold (minimum records in a group)</Label>
              <Input
                type="number"
                min={2}
                max={50}
                value={minGroup}
                onChange={(e) =>
                  setMinGroup(Math.min(50, Math.max(2, Number(e.target.value) || 2)))
                }
              />
              <p className="text-xs text-muted-foreground">
                A group is only flagged when it contains at least this many matching records (2–50).
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || isLoading}>
            {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
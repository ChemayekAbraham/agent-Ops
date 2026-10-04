import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { History, Plus, Minus, User, FileText } from 'lucide-react';

interface FundEdit {
  id: string;
  user_id: string | null;
  metadata: {
    adjustment_type: string;
    amount: number;
    reason: string;
    previous_balance: number;
    reference_id: string;
    manager_email?: string;
    target_user_name?: string;
  };
  created_at: string;
}

interface FundEditHistoryProps {
  userId: string;
  userName?: string;
}

export default function FundEditHistory({ userId, userName }: FundEditHistoryProps) {
  const { data: edits, isLoading } = useQuery({
    queryKey: ['fund-edit-history', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, user_id, metadata, created_at')
        .eq('action_type', 'manager_fund_edit')
        .eq('record_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as unknown as FundEdit[];
    },
  });

  const { data: managerProfiles } = useQuery({
    queryKey: ['manager-profiles-for-fund-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name');
      if (error) throw error;
      return data;
    },
  });

  const getManagerName = (managerId: string | null) => {
    if (!managerId) return 'System';
    const profile = managerProfiles?.find((p) => p.id === managerId);
    return profile?.full_name || 'Unknown Manager';
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  if (!edits || edits.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground">
        <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
        <p className="text-sm font-medium">No fund edit history</p>
        <p className="text-xs mt-1">Manager adjustments will appear here</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <History className="h-4 w-4 text-primary" />
        <h4 className="font-bold text-sm">Fund Edit History</h4>
        {userName && (
          <span className="text-xs text-muted-foreground">for {userName}</span>
        )}
        <Badge variant="outline" className="ml-auto text-[10px]">
          {edits.length} edit{edits.length !== 1 ? 's' : ''}
        </Badge>
      </div>

      <ScrollArea className="h-[300px]">
        <div className="space-y-2 pr-3">
          {edits.map((edit) => {
            const meta = edit.metadata;
            const isCredit = meta?.adjustment_type === 'credit';
            return (
              <div
                key={edit.id}
                className={`p-3 rounded-xl border transition-colors ${
                  isCredit
                    ? 'bg-success/5 border-success/20 hover:border-success/40'
                    : 'bg-destructive/5 border-destructive/20 hover:border-destructive/40'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <div className={`p-1.5 rounded-full ${isCredit ? 'bg-success/15' : 'bg-destructive/15'}`}>
                    {isCredit ? (
                      <Plus className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <Minus className="h-3.5 w-3.5 text-destructive" />
                    )}
                  </div>
                  <span className={`font-black text-sm ${isCredit ? 'text-success' : 'text-destructive'}`}>
                    {isCredit ? '+' : '-'} UGX {(meta?.amount || 0).toLocaleString()}
                  </span>
                  <Badge
                    variant="outline"
                    className={`text-[10px] px-1.5 py-0 ml-auto ${
                      isCredit ? 'bg-success/10 text-success border-success/30' : 'bg-destructive/10 text-destructive border-destructive/30'
                    }`}
                  >
                    {isCredit ? 'Credit' : 'Debit'}
                  </Badge>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                  <User className="h-3 w-3" />
                  <span className="font-semibold text-foreground">{getManagerName(edit.user_id)}</span>
                  <span>•</span>
                  <span>{format(new Date(edit.created_at), "MMM d, yyyy 'at' h:mm a")}</span>
                </div>

                {meta?.reason && (
                  <div className="flex items-start gap-1.5 text-xs text-muted-foreground mt-1">
                    <FileText className="h-3 w-3 mt-0.5 shrink-0" />
                    <span className="italic">"{meta.reason}"</span>
                  </div>
                )}

                {meta?.reference_id && (
                  <div className="text-[10px] text-muted-foreground mt-1 font-mono">
                    Ref: {meta.reference_id}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Check, X, Clock } from 'lucide-react';

export default function HRLeaveManagement() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ['hr-leave-requests'],
    queryFn: async () => {
      const { data } = await supabase
        .from('leave_requests')
        .select('*, profiles:employee_id(full_name, email)')
        .order('created_at', { ascending: false });
      return data || [];
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: string; note: string }) => {
      if (note.length < 10) throw new Error('Review note must be at least 10 characters');
      const { error } = await supabase
        .from('leave_requests')
        .update({
          status,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
          review_note: note,
        })
        .eq('id', id);
      if (error) throw error;

      // If approved, update balance
      if (status === 'approved') {
        const request = requests.find((r: any) => r.id === id);
        if (request) {
          // Event already emitted by DB trigger
        }
      }
    },
    onSuccess: () => {
      toast.success('Leave request updated');
      queryClient.invalidateQueries({ queryKey: ['hr-leave-requests'] });
      queryClient.invalidateQueries({ queryKey: ['hr-pending-leave'] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const statusColors: Record<string, string> = {
    pending: 'bg-warning/20 text-warning',
    approved: 'bg-success/20 text-success',
    rejected: 'bg-destructive/20 text-destructive',
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold text-foreground">Leave Management</h2>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : requests.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No leave requests</p>
      ) : (
        <div className="space-y-3">
          {requests.map((req: any) => (
            <Card key={req.id} className="border-border/50">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{req.profiles?.full_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {req.leave_type} • {req.days_count} day{req.days_count > 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(req.start_date).toLocaleDateString()} – {new Date(req.end_date).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge className={statusColors[req.status] || ''}>{req.status}</Badge>
                </div>

                <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">{req.reason}</p>

                {req.status === 'pending' && (
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Review note (min 10 chars)..."
                      value={reviewNote[req.id] || ''}
                      onChange={(e) => setReviewNote((prev) => ({ ...prev, [req.id]: e.target.value }))}
                      className="text-xs min-h-[60px]"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => reviewMutation.mutate({ id: req.id, status: 'approved', note: reviewNote[req.id] || '' })}
                        disabled={reviewMutation.isPending}
                        className="gap-1"
                      >
                        <Check className="h-3 w-3" /> Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => reviewMutation.mutate({ id: req.id, status: 'rejected', note: reviewNote[req.id] || '' })}
                        disabled={reviewMutation.isPending}
                        className="gap-1"
                      >
                        <X className="h-3 w-3" /> Reject
                      </Button>
                    </div>
                  </div>
                )}

                {req.review_note && req.status !== 'pending' && (
                  <p className="text-xs text-muted-foreground italic">Review: {req.review_note}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

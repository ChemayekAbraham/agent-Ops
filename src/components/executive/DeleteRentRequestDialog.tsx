import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, Trash2, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';

interface DeleteRentRequestDialogProps {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  tenant: {
    tenant_id: string;
    tenant_name: string;
    phone: string;
    rent_request_id: string;
    rent_amount: number;
    amount_repaid: number;
    total_repayment: number;
    daily_repayment: number;
  };
}

export function DeleteRentRequestDialog({ open, onClose, onDeleted, tenant }: DeleteRentRequestDialogProps) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);

  const outstanding = tenant.total_repayment - tenant.amount_repaid;

  const handleDelete = async () => {
    if (reason.length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }

    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const { data, error } = await supabase.functions.invoke('delete-rent-request', {
        body: {
          rent_request_id: tenant.rent_request_id,
          reason,
        },
      });

      if (error) {
        const msg = typeof data?.error === 'string' ? data.error : error.message || 'Deletion failed';
        throw new Error(msg);
      }

      toast.success(data?.message || 'Rent request deleted successfully');
      setReason('');
      onDeleted();
      onClose();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete rent request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Delete Rent Request
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                This will remove <strong>{tenant.tenant_name}</strong>'s active rent request from all reports and dashboards.
              </p>
              
              <div className="bg-muted/50 rounded-lg p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Rent Amount</span>
                  <span className="font-medium">{formatUGX(tenant.rent_amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Repaid</span>
                  <span className="font-medium text-emerald-600">{formatUGX(tenant.amount_repaid)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Outstanding</span>
                  <span className="font-bold text-destructive">{formatUGX(outstanding)}</span>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                A snapshot will be saved for 7 days and can be downloaded from the delete history.
              </p>

              <Textarea
                placeholder="Reason for deletion (minimum 10 characters)..."
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="min-h-[80px]"
              />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading || reason.length < 10}
            className="gap-2"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete Request
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

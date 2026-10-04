import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShoppingBag, Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface SellerApplication {
  id: string;
  full_name: string;
  phone: string;
  seller_application_status: string;
}

export function PendingSellerApplicationsWidget() {
  const queryClient = useQueryClient();
  const [processing, setProcessing] = useState<string | null>(null);

  const { data: applications, isLoading } = useQuery({
    queryKey: ['pending-seller-applications'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, seller_application_status')
        .eq('seller_application_status', 'pending')
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data || []) as SellerApplication[];
    },
    staleTime: 60000,
  });

  const handleAction = async (userId: string, approve: boolean) => {
    setProcessing(userId);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          is_seller: approve,
          seller_application_status: approve ? 'approved' : 'rejected',
        })
        .eq('id', userId);
      if (error) throw error;
      toast.success(approve ? 'Seller approved' : 'Application rejected');
      queryClient.invalidateQueries({ queryKey: ['pending-seller-applications'] });
    } catch (err: any) {
      toast.error(err?.message || 'Action failed');
    } finally {
      setProcessing(null);
    }
  };

  if (isLoading) return null;
  if (!applications || applications.length === 0) return null;

  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-warning" />
          Pending Seller Applications
          <Badge variant="secondary" className="ml-auto">{applications.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {applications.map((app) => (
          <div key={app.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">{app.full_name}</p>
              <p className="text-xs text-muted-foreground">{app.phone}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2 border-success/50 text-success hover:bg-success/10"
                disabled={processing === app.id}
                onClick={() => handleAction(app.id, true)}
              >
                {processing === app.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2 border-destructive/50 text-destructive hover:bg-destructive/10"
                disabled={processing === app.id}
                onClick={() => handleAction(app.id, false)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

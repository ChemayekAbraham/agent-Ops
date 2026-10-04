import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { StorageImage } from '@/components/ui/StorageImage';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  Package, 
  CheckCircle, 
  XCircle, 
  Clock, 
  Loader2, 
  User,
  ShoppingCart,
  Truck,
  Calendar
} from 'lucide-react';
import { format } from 'date-fns';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface ProductOrder {
  id: string;
  product_id: string;
  buyer_id: string;
  agent_id: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  agent_commission: number;
  status: string;
  delivery_notes: string | null;
  estimated_delivery_date: string | null;
  created_at: string;
  product?: { name: string; image_url: string | null };
  buyer?: { full_name: string; phone: string };
  agent?: { full_name: string };
}

export function OrdersManager() {
  const { toast } = useToast();
  const [orders, setOrders] = useState<ProductOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    setLoading(true);
    
    const { data: ordersData, error } = await supabase
      .from('product_orders')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
      setLoading(false);
      return;
    }

    // Fetch products
    const productIds = [...new Set((ordersData || []).map(o => o.product_id))];
    const { data: products } = productIds.length > 0
      ? await supabase.from('products').select('id, name, image_url').in('id', productIds)
      : { data: [] };

    // Fetch buyer profiles
    const buyerIds = [...new Set((ordersData || []).map(o => o.buyer_id))];
    const agentIds = [...new Set((ordersData || []).map(o => o.agent_id))];
    const allUserIds = [...new Set([...buyerIds, ...agentIds])];
    const { data: profiles } = allUserIds.length > 0
      ? await supabase.from('profiles').select('id, full_name, phone').in('id', allUserIds)
      : { data: [] };

    const ordersWithDetails = (ordersData || []).map(o => ({
      ...o,
      product: products?.find(p => p.id === o.product_id),
      buyer: profiles?.find(p => p.id === o.buyer_id),
      agent: profiles?.find(p => p.id === o.agent_id)
    }));

    setOrders(ordersWithDetails);
    setLoading(false);
  };

  const handleStatusChange = async (orderId: string, newStatus: string) => {
    setUpdatingId(orderId);
    
    const { error } = await supabase
      .from('product_orders')
      .update({ 
        status: newStatus,
        status_updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: 'Status Updated', description: `Order status changed to ${newStatus}` });
      fetchOrders();
    }
    setUpdatingId(null);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="bg-warning/10 text-warning border-warning/30 gap-1"><Clock className="h-3 w-3" />Pending</Badge>;
      case 'processing':
        return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1"><Package className="h-3 w-3" />Processing</Badge>;
      case 'shipped':
        return <Badge variant="outline" className="bg-chart-5/10 text-chart-5 border-chart-5/30 gap-1"><Truck className="h-3 w-3" />Shipped</Badge>;
      case 'delivered':
        return <Badge className="bg-success text-success-foreground gap-1"><CheckCircle className="h-3 w-3" />Delivered</Badge>;
      case 'cancelled':
        return <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const pendingOrders = orders.filter(o => ['pending', 'processing'].includes(o.status));
  const totalSales = orders.filter(o => o.status === 'delivered').reduce((sum, o) => sum + o.total_price, 0);
  const totalCommissions = orders.filter(o => o.status === 'delivered').reduce((sum, o) => sum + o.agent_commission, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-warning/5 border-warning/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Clock className="h-5 w-5 text-warning" />
              <div>
                <p className="text-sm text-muted-foreground">Pending</p>
                <p className="text-xl font-bold text-warning">{pendingOrders.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-success/5 border-success/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-success" />
              <div>
                <p className="text-sm text-muted-foreground">Delivered</p>
                <p className="text-xl font-bold text-success">{orders.filter(o => o.status === 'delivered').length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <ShoppingCart className="h-5 w-5 text-primary" />
              <div>
                <p className="text-sm text-muted-foreground">Total Sales</p>
                <p className="text-lg font-bold text-primary">{formatUGX(totalSales)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <Package className="h-5 w-5 text-muted-foreground" />
              <div>
                <p className="text-sm text-muted-foreground">Commissions</p>
                <p className="text-lg font-bold">{formatUGX(totalCommissions)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Orders List */}
      <div className="space-y-3">
        <h3 className="font-semibold">All Orders ({orders.length})</h3>
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} className={pendingOrders.some(p => p.id === order.id) ? 'border-warning/30' : ''}>
              <CardContent className="p-4">
                <div className="flex flex-col gap-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      {order.product?.image_url ? (
                        <StorageImage 
                          src={order.product.image_url} 
                          alt={order.product.name} 
                          className="h-12 w-12 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="h-12 w-12 rounded-lg bg-muted flex items-center justify-center">
                          <Package className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                      <div>
                        <p className="font-semibold">{order.product?.name || 'Unknown Product'}</p>
                        <p className="text-sm text-muted-foreground">Qty: {order.quantity} × {formatUGX(order.unit_price)}</p>
                      </div>
                    </div>
                    {getStatusBadge(order.status)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span>{order.buyer?.full_name || 'Unknown Buyer'}</span>
                    </div>
                    <div className="text-right font-bold">
                      {formatUGX(order.total_price)}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(order.created_at), 'MMM d, yyyy h:mm a')}
                    </div>
                    {order.status !== 'delivered' && order.status !== 'cancelled' && (
                      <Select
                        value={order.status}
                        onValueChange={(value) => handleStatusChange(order.id, value)}
                        disabled={updatingId === order.id}
                      >
                        <SelectTrigger className="w-[140px] h-8">
                          {updatingId === order.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <SelectValue />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pending">Pending</SelectItem>
                          <SelectItem value="processing">Processing</SelectItem>
                          <SelectItem value="shipped">Shipped</SelectItem>
                          <SelectItem value="delivered">Delivered</SelectItem>
                          <SelectItem value="cancelled">Cancelled</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {orders.length === 0 && (
            <p className="text-center text-muted-foreground py-8">No orders yet</p>
          )}
        </div>
      </div>
    </div>
  );
}

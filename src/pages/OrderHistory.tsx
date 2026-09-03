import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { 
  ArrowLeft, 
  ShoppingBag, 
  Store, 
  Package, 
  Loader2,
  Calendar,
  Coins,
  Truck,
  CheckCircle,
  Clock,
  PackageCheck
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import AppBreadcrumb from '@/components/AppBreadcrumb';
import { ThemeToggle } from '@/components/ThemeToggle';
import WelileLogo from '@/components/WelileLogo';
import { toast } from 'sonner';
import ScreenLoader from '@/components/common/ScreenLoader';

type OrderStatus = 'pending' | 'processing' | 'shipped' | 'delivered' | 'completed';

const ORDER_STATUSES: { value: OrderStatus; label: string; icon: React.ReactNode }[] = [
  { value: 'pending', label: 'Pending', icon: <Clock className="h-3 w-3" /> },
  { value: 'processing', label: 'Processing', icon: <Package className="h-3 w-3" /> },
  { value: 'shipped', label: 'Shipped', icon: <Truck className="h-3 w-3" /> },
  { value: 'delivered', label: 'Delivered', icon: <PackageCheck className="h-3 w-3" /> },
  { value: 'completed', label: 'Completed', icon: <CheckCircle className="h-3 w-3" /> },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case 'pending': return 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20';
    case 'processing': return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
    case 'shipped': return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
    case 'delivered': return 'bg-green-500/10 text-green-500 border-green-500/20';
    case 'completed': return 'bg-primary/10 text-primary border-primary/20';
    default: return 'bg-muted text-muted-foreground';
  }
};

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'pending': return <Clock className="h-3 w-3" />;
    case 'processing': return <Package className="h-3 w-3" />;
    case 'shipped': return <Truck className="h-3 w-3" />;
    case 'delivered': return <PackageCheck className="h-3 w-3" />;
    case 'completed': return <CheckCircle className="h-3 w-3" />;
    default: return <Clock className="h-3 w-3" />;
  }
};

interface OrderWithProduct {
  id: string;
  product_id: string;
  buyer_id: string;
  agent_id: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  agent_commission: number;
  status: string;
  created_at: string;
  status_updated_at?: string;
  delivery_notes?: string;
  product_name?: string;
  product_image?: string | null;
  buyer_name?: string;
  agent_name?: string;
}

export default function OrderHistory() {
  const navigate = useNavigate();
  const { user, role, roles } = useAuth();
  const [purchases, setPurchases] = useState<OrderWithProduct[]>([]);
  const [sales, setSales] = useState<OrderWithProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('purchases');

  const isAgent = roles.includes('agent');

  useEffect(() => {
    if (user) {
      fetchOrders();
    }
  }, [user]);

  // Realtime removed — product_orders not in realtime whitelist

  const fetchOrders = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // Fetch purchases (orders where user is buyer)
      const { data: purchaseData, error: purchaseError } = await supabase
        .from('product_orders')
        .select('*')
        .eq('buyer_id', user.id)
        .order('created_at', { ascending: false });

      if (purchaseError) throw purchaseError;

      // Enrich purchases with product details
      const enrichedPurchases = await Promise.all(
        (purchaseData || []).map(async (order) => {
          const { data: product } = await supabase
            .from('products')
            .select('name, image_url')
            .eq('id', order.product_id)
            .maybeSingle();

          const { data: agent } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', order.agent_id)
            .maybeSingle();

          return {
            ...order,
            product_name: product?.name || 'Unknown Product',
            product_image: product?.image_url,
            agent_name: agent?.full_name || 'Unknown Seller',
          };
        })
      );

      setPurchases(enrichedPurchases);

      // If user is an agent, also fetch sales
      if (isAgent) {
        const { data: salesData, error: salesError } = await supabase
          .from('product_orders')
          .select('*')
          .eq('agent_id', user.id)
          .order('created_at', { ascending: false });

        if (salesError) throw salesError;

        // Enrich sales with product and buyer details
        const enrichedSales = await Promise.all(
          (salesData || []).map(async (order) => {
            const { data: product } = await supabase
              .from('products')
              .select('name, image_url')
              .eq('id', order.product_id)
              .maybeSingle();

            const { data: buyer } = await supabase
              .from('profiles')
              .select('full_name')
              .eq('id', order.buyer_id)
              .maybeSingle();

            return {
              ...order,
              product_name: product?.name || 'Unknown Product',
              product_image: product?.image_url,
              buyer_name: buyer?.full_name || 'Unknown Buyer',
            };
          })
        );

        setSales(enrichedSales);
      }
    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-UG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const totalPurchases = purchases.reduce((sum, o) => sum + Number(o.total_price), 0);
  const totalSales = sales.reduce((sum, o) => sum + Number(o.total_price), 0);
  const totalCommission = sales.reduce((sum, o) => sum + Number(o.agent_commission), 0);

  if (loading) {
    return (
      <ScreenLoader />
    );
  }

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      {/* Header */}
      <header className="sticky top-0 z-50 glass-card border-b border-border/50 pt-safe">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={() => navigate(roleToSlug(role))}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <WelileLogo showText={false} />
              <h1 className="text-lg font-semibold">Order History</h1>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6 animate-fade-in">
        <AppBreadcrumb />

        {/* Stats */}
        <div className={`grid gap-4 ${isAgent ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1'}`}>
          <Card className="elevated-card">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5">
                  <ShoppingBag className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Spent</p>
                  <p className="text-xl font-bold">{formatUGX(totalPurchases)}</p>
                  <p className="text-xs text-muted-foreground">{purchases.length} orders</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {isAgent && (
            <>
              <Card className="elevated-card">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-gradient-to-br from-success/20 to-success/5">
                      <Store className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Total Sales</p>
                      <p className="text-xl font-bold text-success">{formatUGX(totalSales)}</p>
                      <p className="text-xs text-muted-foreground">{sales.length} orders</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="elevated-card">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-gradient-to-br from-warning/20 to-warning/5">
                      <Coins className="h-5 w-5 text-warning" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Commission Earned</p>
                      <p className="text-xl font-bold">{formatUGX(totalCommission)}</p>
                      <p className="text-xs text-muted-foreground">1% per sale</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {/* Orders */}
        {isAgent ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="purchases" className="gap-2">
                <ShoppingBag className="h-4 w-4" />
                My Purchases ({purchases.length})
              </TabsTrigger>
              <TabsTrigger value="sales" className="gap-2">
                <Store className="h-4 w-4" />
                My Sales ({sales.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="purchases" className="mt-6">
              <OrderList orders={purchases} type="purchase" formatDate={formatDate} onStatusUpdate={fetchOrders} />
            </TabsContent>

            <TabsContent value="sales" className="mt-6">
              <OrderList orders={sales} type="sale" formatDate={formatDate} onStatusUpdate={fetchOrders} />
            </TabsContent>
          </Tabs>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShoppingBag className="h-5 w-5" />
                My Purchases
              </CardTitle>
            </CardHeader>
            <CardContent>
              <OrderList orders={purchases} type="purchase" formatDate={formatDate} onStatusUpdate={fetchOrders} />
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

interface OrderListProps {
  orders: OrderWithProduct[];
  type: 'purchase' | 'sale';
  formatDate: (date: string) => string;
  onStatusUpdate: () => void;
}

function OrderList({ orders, type, formatDate, onStatusUpdate }: OrderListProps) {
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);

  const handleStatusChange = async (orderId: string, newStatus: string) => {
    setUpdatingOrderId(orderId);
    try {
      const { error } = await supabase
        .from('product_orders')
        .update({ 
          status: newStatus,
          status_updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (error) throw error;
      toast.success('Order status updated');
      onStatusUpdate();
    } catch (error: any) {
      toast.error('Failed to update status', { description: error.message });
    } finally {
      setUpdatingOrderId(null);
    }
  };

  if (orders.length === 0) {
    return (
      <div className="text-center py-12">
        <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
        <p className="text-muted-foreground">
          {type === 'purchase' ? 'No purchases yet' : 'No sales yet'}
        </p>
        <p className="text-sm text-muted-foreground">
          {type === 'purchase' 
            ? 'Browse the marketplace to find products!' 
            : 'Add products to your shop to start selling!'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {orders.map((order) => (
        <div 
          key={order.id}
          className="p-4 rounded-xl bg-secondary/30 border border-border/50 hover:border-primary/30 transition-colors"
        >
          <div className="flex items-start gap-4">
            {/* Product Image */}
            <div className="w-16 h-16 rounded-lg bg-muted overflow-hidden flex-shrink-0">
              {order.product_image ? (
                <img 
                  src={order.product_image} 
                  alt={order.product_name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Package className="h-6 w-6 text-muted-foreground" />
                </div>
              )}
            </div>

            {/* Order Details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold truncate">{order.product_name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {type === 'purchase' 
                      ? `Sold by: ${order.agent_name}` 
                      : `Buyer: ${order.buyer_name}`}
                  </p>
                </div>
                
                {/* Status Badge or Selector */}
                {type === 'sale' ? (
                  <Select
                    value={order.status}
                    onValueChange={(value) => handleStatusChange(order.id, value)}
                    disabled={updatingOrderId === order.id}
                  >
                    <SelectTrigger className={`w-[140px] h-8 text-xs ${getStatusColor(order.status)}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ORDER_STATUSES.map((status) => (
                        <SelectItem key={status.value} value={status.value} className="text-xs">
                          <div className="flex items-center gap-2">
                            {status.icon}
                            {status.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Badge className={`shrink-0 gap-1 ${getStatusColor(order.status)}`}>
                    {getStatusIcon(order.status)}
                    {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                  </Badge>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-muted-foreground">
                  Qty: {order.quantity} × UGX {Number(order.unit_price).toLocaleString()}
                </span>
                <span className="font-semibold">
                  Total: {formatUGX(Number(order.total_price))}
                </span>
                {type === 'sale' && (
                  <span className="text-success font-medium">
                    +{formatUGX(Number(order.agent_commission))} commission
                  </span>
                )}
              </div>

              <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                <Calendar className="h-3 w-3" />
                {formatDate(order.created_at)}
              </div>
            </div>
          </div>

          {/* Order Tracking Timeline for buyers */}
          {type === 'purchase' && (
            <div className="mt-4 pt-4 border-t border-border/50">
              <p className="text-xs font-medium text-muted-foreground mb-3">Order Progress</p>
              <div className="flex items-center gap-1">
                {ORDER_STATUSES.map((status, index) => {
                  const statusIndex = ORDER_STATUSES.findIndex(s => s.value === order.status);
                  const isCompleted = index <= statusIndex;
                  const isCurrent = status.value === order.status;
                  
                  return (
                    <div key={status.value} className="flex-1 flex items-center">
                      <div className={`flex flex-col items-center flex-1`}>
                        <div className={`
                          w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors
                          ${isCompleted 
                            ? 'bg-primary text-primary-foreground' 
                            : 'bg-muted text-muted-foreground'}
                          ${isCurrent ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}
                        `}>
                          {status.icon}
                        </div>
                        <span className={`text-[10px] mt-1 text-center ${isCompleted ? 'text-foreground' : 'text-muted-foreground'}`}>
                          {status.label}
                        </span>
                      </div>
                      {index < ORDER_STATUSES.length - 1 && (
                        <div className={`h-0.5 flex-1 mx-1 ${
                          index < statusIndex ? 'bg-primary' : 'bg-muted'
                        }`} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

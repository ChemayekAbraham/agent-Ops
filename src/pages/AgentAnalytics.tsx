import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  TrendingUp, 
  Package, 
  ShoppingCart, 
  DollarSign,
  BarChart3,
  Calendar
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend
} from 'recharts';
import { format, subDays, startOfDay, endOfDay, eachDayOfInterval } from 'date-fns';

interface Order {
  id: string;
  product_id: string;
  quantity: number;
  total_price: number;
  agent_commission: number;
  status: string;
  created_at: string;
  product?: {
    name: string;
    category: string;
  };
}

interface ProductStats {
  name: string;
  sales: number;
  revenue: number;
  quantity: number;
}

const COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))', 'hsl(var(--chart-5))'];

export default function AgentAnalytics() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState('30');

  useEffect(() => {
    if (user) {
      fetchOrders();
    }
  }, [user, dateRange]);

  const fetchOrders = async () => {
    if (!user) return;
    setLoading(true);

    try {
      const startDate = subDays(new Date(), parseInt(dateRange));
      
      const { data, error } = await supabase
        .from('product_orders')
        .select(`
          id,
          product_id,
          quantity,
          total_price,
          agent_commission,
          status,
          created_at
        `)
        .eq('agent_id', user.id)
        .gte('created_at', startDate.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;

      // Fetch product details
      const productIds = [...new Set((data || []).map(o => o.product_id))];
      const { data: products } = await supabase
        .from('products')
        .select('id, name, category')
        .in('id', productIds);

      const productMap = new Map(products?.map(p => [p.id, p]) || []);
      
      const enrichedOrders = (data || []).map(order => ({
        ...order,
        product: productMap.get(order.product_id),
      }));

      setOrders(enrichedOrders);
    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate statistics
  const stats = useMemo(() => {
    const totalRevenue = orders.reduce((sum, o) => sum + o.total_price, 0);
    const totalCommission = orders.reduce((sum, o) => sum + o.agent_commission, 0);
    const totalOrders = orders.length;
    const totalItems = orders.reduce((sum, o) => sum + o.quantity, 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    return { totalRevenue, totalCommission, totalOrders, totalItems, avgOrderValue };
  }, [orders]);

  // Daily sales chart data
  const dailySalesData = useMemo(() => {
    const days = parseInt(dateRange);
    const interval = eachDayOfInterval({
      start: subDays(new Date(), days - 1),
      end: new Date(),
    });

    return interval.map(day => {
      const dayStart = startOfDay(day);
      const dayEnd = endOfDay(day);
      
      const dayOrders = orders.filter(o => {
        const orderDate = new Date(o.created_at);
        return orderDate >= dayStart && orderDate <= dayEnd;
      });

      return {
        date: format(day, 'MMM d'),
        revenue: dayOrders.reduce((sum, o) => sum + o.total_price, 0),
        orders: dayOrders.length,
        commission: dayOrders.reduce((sum, o) => sum + o.agent_commission, 0),
      };
    });
  }, [orders, dateRange]);

  // Top products data
  const topProductsData = useMemo(() => {
    const productStats = new Map<string, ProductStats>();

    orders.forEach(order => {
      const name = order.product?.name || 'Unknown';
      const existing = productStats.get(name) || { name, sales: 0, revenue: 0, quantity: 0 };
      
      productStats.set(name, {
        name,
        sales: existing.sales + 1,
        revenue: existing.revenue + order.total_price,
        quantity: existing.quantity + order.quantity,
      });
    });

    return Array.from(productStats.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
  }, [orders]);

  // Category breakdown
  const categoryData = useMemo(() => {
    const categoryStats = new Map<string, number>();

    orders.forEach(order => {
      const category = order.product?.category || 'Other';
      const existing = categoryStats.get(category) || 0;
      categoryStats.set(category, existing + order.total_price);
    });

    return Array.from(categoryStats.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [orders]);

  // Order status breakdown
  const statusData = useMemo(() => {
    const statusStats = new Map<string, number>();

    orders.forEach(order => {
      const status = order.status || 'completed';
      const existing = statusStats.get(status) || 0;
      statusStats.set(status, existing + 1);
    });

    return Array.from(statusStats.entries())
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value }));
  }, [orders]);

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-6xl py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <BarChart3 className="h-6 w-6 text-primary" />
                Sales Analytics
              </h1>
              <p className="text-muted-foreground">Track your product performance</p>
            </div>
          </div>

          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-40">
              <Calendar className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <DollarSign className="h-4 w-4" />
                Total Revenue
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">UGX {stats.totalRevenue.toLocaleString()}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <TrendingUp className="h-4 w-4" />
                Commission Earned
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-primary">UGX {stats.totalCommission.toLocaleString()}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <ShoppingCart className="h-4 w-4" />
                Total Orders
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.totalOrders}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Package className="h-4 w-4" />
                Items Sold
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold">{stats.totalItems}</p>
            </CardContent>
          </Card>
        </div>

        {/* Charts */}
        <Tabs defaultValue="revenue" className="space-y-4">
          <TabsList>
            <TabsTrigger value="revenue">Revenue Trend</TabsTrigger>
            <TabsTrigger value="products">Top Products</TabsTrigger>
            <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
          </TabsList>

          <TabsContent value="revenue">
            <Card>
              <CardHeader>
                <CardTitle>Revenue Over Time</CardTitle>
                <CardDescription>Daily revenue and commission for the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="h-80 flex items-center justify-center text-muted-foreground">
                    Loading...
                  </div>
                ) : dailySalesData.length === 0 ? (
                  <div className="h-80 flex items-center justify-center text-muted-foreground">
                    No sales data for this period
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <LineChart data={dailySalesData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis 
                        dataKey="date" 
                        className="text-xs fill-muted-foreground"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis 
                        className="text-xs fill-muted-foreground"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                        }}
                        formatter={(value: number) => [`UGX ${value.toLocaleString()}`, '']}
                      />
                      <Legend />
                      <Line 
                        type="monotone" 
                        dataKey="revenue" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        dot={false}
                        name="Revenue"
                      />
                      <Line 
                        type="monotone" 
                        dataKey="commission" 
                        stroke="hsl(var(--chart-2))" 
                        strokeWidth={2}
                        dot={false}
                        name="Commission"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="products">
            <Card>
              <CardHeader>
                <CardTitle>Top Selling Products</CardTitle>
                <CardDescription>Products by revenue in the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="h-80 flex items-center justify-center text-muted-foreground">
                    Loading...
                  </div>
                ) : topProductsData.length === 0 ? (
                  <div className="h-80 flex items-center justify-center text-muted-foreground">
                    No product data for this period
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={topProductsData} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis 
                        type="number"
                        className="text-xs fill-muted-foreground"
                        tick={{ fontSize: 12 }}
                        tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                      />
                      <YAxis 
                        type="category"
                        dataKey="name"
                        className="text-xs fill-muted-foreground"
                        tick={{ fontSize: 12 }}
                        width={120}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                        }}
                        formatter={(value: number, name: string) => [
                          name === 'revenue' ? `UGX ${value.toLocaleString()}` : value,
                          name === 'revenue' ? 'Revenue' : 'Quantity Sold'
                        ]}
                      />
                      <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="breakdown">
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle>Sales by Category</CardTitle>
                  <CardDescription>Revenue distribution by product category</CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="h-64 flex items-center justify-center text-muted-foreground">
                      Loading...
                    </div>
                  ) : categoryData.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-muted-foreground">
                      No category data
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={256}>
                      <PieChart>
                        <Pie
                          data={categoryData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {categoryData.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px',
                          }}
                          formatter={(value: number) => [`UGX ${value.toLocaleString()}`, 'Revenue']}
                        />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Order Status</CardTitle>
                  <CardDescription>Distribution of order statuses</CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <div className="h-64 flex items-center justify-center text-muted-foreground">
                      Loading...
                    </div>
                  ) : statusData.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-muted-foreground">
                      No status data
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={256}>
                      <PieChart>
                        <Pie
                          data={statusData}
                          cx="50%"
                          cy="50%"
                          innerRadius={60}
                          outerRadius={100}
                          paddingAngle={2}
                          dataKey="value"
                        >
                          {statusData.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip 
                          contentStyle={{ 
                            backgroundColor: 'hsl(var(--card))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '8px',
                          }}
                          formatter={(value: number) => [value, 'Orders']}
                        />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>

        {/* Top Products Table */}
        <Card>
          <CardHeader>
            <CardTitle>Product Performance</CardTitle>
            <CardDescription>Detailed breakdown of product sales</CardDescription>
          </CardHeader>
          <CardContent>
            {topProductsData.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No sales data available</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-2 font-medium">Product</th>
                      <th className="text-right py-3 px-2 font-medium">Orders</th>
                      <th className="text-right py-3 px-2 font-medium">Qty Sold</th>
                      <th className="text-right py-3 px-2 font-medium">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topProductsData.map((product, index) => (
                      <tr key={product.name} className="border-b last:border-0">
                        <td className="py-3 px-2">
                          <div className="flex items-center gap-2">
                            <span 
                              className="w-3 h-3 rounded-full" 
                              style={{ backgroundColor: COLORS[index % COLORS.length] }}
                            />
                            {product.name}
                          </div>
                        </td>
                        <td className="text-right py-3 px-2">{product.sales}</td>
                        <td className="text-right py-3 px-2">{product.quantity}</td>
                        <td className="text-right py-3 px-2 font-medium">
                          UGX {product.revenue.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

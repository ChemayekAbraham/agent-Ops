import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Zap, 
  ArrowLeft, 
  Flame,
  Clock,
  ShoppingBag,
  TrendingUp
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { ThemeToggle } from '@/components/ThemeToggle';
import WelileLogo from '@/components/WelileLogo';
import { useAuth } from '@/hooks/useAuth';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
  image_url: string | null;
  stock: number;
  agent_id: string;
  discount_percentage: number | null;
  discount_ends_at: string | null;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { 
    opacity: 1, 
    y: 0,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 }
  },
};

export default function FlashSales() {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchFlashSaleProducts();
    if (user) fetchWishlist();
  }, [user]);

  const fetchFlashSaleProducts = async () => {
    setLoading(true);
    try {
      const now = new Date().toISOString();
      
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('active', true)
        .gt('stock', 0)
        .gt('discount_percentage', 0)
        .gt('discount_ends_at', now)
        .order('discount_percentage', { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching flash sale products:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchWishlist = async () => {
    if (!user) return;
    
    const { data } = await supabase
      .from('wishlists')
      .select('product_id')
      .eq('user_id', user.id);
    
    if (data) {
      setWishlistIds(new Set(data.map(w => w.product_id)));
    }
  };

  const stats = [
    { value: products.length, label: 'Active Deals', icon: Flame },
    { value: `${Math.max(...products.map(p => p.discount_percentage || 0), 0)}%`, label: 'Max Discount', icon: TrendingUp },
    { value: products.reduce((sum, p) => sum + p.stock, 0), label: 'Items Available', icon: ShoppingBag },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <motion.header 
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl"
      >
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/">
              <motion.div whileHover={{ scale: 1.05 }} transition={{ type: 'spring', stiffness: 400, damping: 17 }}>
                <WelileLogo />
              </motion.div>
            </Link>
            <Badge variant="outline" className="bg-gradient-to-r from-amber-500/20 to-orange-500/20 border-amber-500/50 text-amber-600 dark:text-amber-400 gap-1">
              <Zap className="h-3 w-3 fill-current" />
              Flash Sales
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link to={user ? "/dashboard/tenant" : "/auth"}>
              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Button variant="outline" size="sm" className="gap-2">
                  <ArrowLeft className="h-4 w-4" />
                  {user ? 'Dashboard' : 'Sign In'}
                </Button>
              </motion.div>
            </Link>
          </div>
        </div>
      </motion.header>

      {/* Hero Banner */}
      <section className="relative overflow-hidden border-b border-border/50">
        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-background" />
        
        {/* Animated background elements */}
        <motion.div
          animate={{ 
            scale: [1, 1.2, 1],
            opacity: [0.3, 0.5, 0.3]
          }}
          transition={{ duration: 3, repeat: Infinity }}
          className="absolute top-10 left-10 w-32 h-32 bg-gradient-to-br from-amber-500/30 to-orange-500/20 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ 
            scale: [1.2, 1, 1.2],
            opacity: [0.4, 0.2, 0.4]
          }}
          transition={{ duration: 4, repeat: Infinity, delay: 1 }}
          className="absolute bottom-10 right-10 w-48 h-48 bg-gradient-to-br from-orange-500/25 to-red-500/20 rounded-full blur-3xl"
        />
        
        <div className="container mx-auto px-4 py-16 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-3xl mx-auto"
          >
            <motion.div 
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', delay: 0.2 }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/30 mb-6"
            >
              <motion.div
                animate={{ rotate: [0, 10, -10, 0] }}
                transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
              >
                <Flame className="h-5 w-5 text-amber-500" />
              </motion.div>
              <span className="font-semibold text-amber-600 dark:text-amber-400">Limited Time Offers</span>
              <Clock className="h-4 w-4 text-amber-500/70" />
            </motion.div>
            
            <h1 className="text-4xl md:text-6xl font-bold mb-4">
              <span className="bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 bg-clip-text text-transparent">
                Flash Sales
              </span>
            </h1>
            <p className="text-lg text-muted-foreground mb-8">
              Grab these amazing deals before they're gone! Limited quantities at unbeatable prices.
            </p>

            {/* Stats */}
            {!loading && products.length > 0 && (
              <motion.div 
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                className="flex justify-center gap-8 md:gap-16"
              >
                {stats.map((stat, i) => (
                  <motion.div key={i} variants={itemVariants} className="text-center">
                    <div className="flex items-center justify-center gap-2 mb-1">
                      <stat.icon className="h-5 w-5 text-amber-500" />
                      <span className="text-2xl md:text-3xl font-bold">{stat.value}</span>
                    </div>
                    <span className="text-sm text-muted-foreground">{stat.label}</span>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </motion.div>
        </div>
      </section>

      {/* Products Grid */}
      <section className="container mx-auto px-4 py-12">
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="space-y-3">
                <Skeleton className="aspect-square w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ))}
          </div>
        ) : products.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-20"
          >
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
              <Zap className="h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-bold mb-2">No Flash Sales Right Now</h2>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Check back soon for amazing deals! Our agents are always adding new discounted products.
            </p>
            <Link to="/dashboard/tenant">
              <Button className="gap-2">
                <ShoppingBag className="h-4 w-4" />
                Browse All Products
              </Button>
            </Link>
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6"
          >
            {products.map((product) => (
              <motion.div key={product.id} variants={itemVariants}>
                <ProductCard
                  product={product}
                  onPurchaseComplete={fetchFlashSaleProducts}
                  isOwnProduct={product.agent_id === user?.id}
                  isInWishlist={wishlistIds.has(product.id)}
                  onWishlistChange={fetchWishlist}
                />
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>

      {/* Footer CTA */}
      {!loading && products.length > 0 && (
        <section className="border-t border-border/50 bg-card/30">
          <div className="container mx-auto px-4 py-12">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="text-center"
            >
              <h2 className="text-2xl font-bold mb-2">Want to List Your Products?</h2>
              <p className="text-muted-foreground mb-6">
                Become an agent and start selling with flash sale discounts!
              </p>
              <Link to="/auth">
                <Button size="lg" className="gap-2">
                  Get Started as Agent
                  <Zap className="h-4 w-4" />
                </Button>
              </Link>
            </motion.div>
          </div>
        </section>
      )}
    </div>
  );
}

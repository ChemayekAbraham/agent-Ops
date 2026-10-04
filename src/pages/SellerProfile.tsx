import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { 
  ArrowLeft, 
  Store, 
  Star, 
  Package, 
  ShoppingBag,
  Calendar,
  MapPin,
  Phone,
  Mail,
  TrendingUp
} from 'lucide-react';
import { VerifiedBadge } from '@/components/marketplace/VerifiedBadge';
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
  discount_percentage?: number | null;
  discount_ends_at?: string | null;
  created_at: string;
}

interface SellerProfile {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  created_at: string;
  verified: boolean;
}

interface SellerStats {
  totalProducts: number;
  totalOrders: number;
  averageRating: number;
  totalReviews: number;
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

export default function SellerProfile() {
  const { sellerId } = useParams<{ sellerId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [seller, setSeller] = useState<SellerProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [stats, setStats] = useState<SellerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (sellerId) {
      fetchSellerData();
    }
  }, [sellerId]);

  useEffect(() => {
    if (user) fetchWishlist();
  }, [user]);

  const fetchSellerData = async () => {
    if (!sellerId) return;
    
    setLoading(true);
    try {
      // Fetch seller profile
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', sellerId)
        .maybeSingle();

      if (profileError) throw profileError;
      setSeller(profileData);

      // Fetch seller's products
      const { data: productsData, error: productsError } = await supabase
        .from('products')
        .select('*')
        .eq('agent_id', sellerId)
        .eq('active', true)
        .order('created_at', { ascending: false });

      if (productsError) throw productsError;
      setProducts(productsData || []);

      // Fetch seller stats
      const productIds = (productsData || []).map(p => p.id);
      
      let totalOrders = 0;
      let averageRating = 0;
      let totalReviews = 0;

      if (productIds.length > 0) {
        // Get order count
        const { count: orderCount } = await supabase
          .from('product_orders')
          .select('*', { count: 'exact', head: true })
          .eq('agent_id', sellerId);
        
        totalOrders = orderCount || 0;

        // Get reviews for all products
        const { data: reviewsData } = await supabase
          .from('product_reviews')
          .select('rating')
          .in('product_id', productIds);

        if (reviewsData && reviewsData.length > 0) {
          totalReviews = reviewsData.length;
          averageRating = reviewsData.reduce((sum, r) => sum + r.rating, 0) / reviewsData.length;
        }
      }

      setStats({
        totalProducts: productsData?.length || 0,
        totalOrders,
        averageRating,
        totalReviews,
      });

    } catch (error) {
      console.error('Error fetching seller data:', error);
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

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
          <div className="container mx-auto px-4 py-4 flex items-center gap-4">
            <Skeleton className="h-10 w-24" />
            <Skeleton className="h-6 w-32" />
          </div>
        </header>
        <main className="container mx-auto px-4 py-8">
          <div className="flex flex-col md:flex-row gap-8">
            <div className="md:w-1/3">
              <Skeleton className="h-64 w-full rounded-xl" />
            </div>
            <div className="md:w-2/3 space-y-4">
              <Skeleton className="h-8 w-48" />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-24 rounded-lg" />
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!seller) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Store className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
          <h1 className="text-2xl font-bold mb-2">Seller Not Found</h1>
          <p className="text-muted-foreground mb-6">This seller profile doesn't exist or has been removed.</p>
          <Button onClick={() => navigate('/marketplace')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Marketplace
          </Button>
        </div>
      </div>
    );
  }

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
              <motion.div whileHover={{ scale: 1.05 }}>
                <WelileLogo />
              </motion.div>
            </Link>
            <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary gap-1">
              <Store className="h-3 w-3" />
              Seller Profile
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={() => navigate(-1)} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      </motion.header>

      <main className="container mx-auto px-4 py-8">
        {/* Seller Info Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <Card className="overflow-hidden">
            <div className="h-24 bg-gradient-to-r from-primary/20 via-primary/10 to-accent/20" />
            <CardContent className="relative pt-0">
              <div className="flex flex-col md:flex-row gap-6 -mt-12">
                {/* Avatar */}
                <Avatar className="h-24 w-24 border-4 border-background shadow-lg">
                  <AvatarImage src={seller.avatar_url || undefined} />
                  <AvatarFallback className="text-2xl bg-primary text-primary-foreground">
                    {getInitials(seller.full_name)}
                  </AvatarFallback>
                </Avatar>

                {/* Info */}
                <div className="flex-1 pt-4 md:pt-8">
                  <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div>
                      <h1 className="text-2xl font-bold flex items-center gap-2">
                        {seller.full_name}
                        {seller.verified && <VerifiedBadge size="lg" />}
                      </h1>
                      <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          Joined {new Date(seller.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                        </span>
                        {stats && stats.averageRating > 0 && (
                          <span className="flex items-center gap-1">
                            <Star className="h-4 w-4 fill-warning text-warning" />
                            {stats.averageRating.toFixed(1)} ({stats.totalReviews} reviews)
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stats */}
                    {stats && (
                      <div className="flex gap-6">
                        <div className="text-center">
                          <p className="text-2xl font-bold">{stats.totalProducts}</p>
                          <p className="text-xs text-muted-foreground">Products</p>
                        </div>
                        <div className="text-center">
                          <p className="text-2xl font-bold">{stats.totalOrders}</p>
                          <p className="text-xs text-muted-foreground">Sales</p>
                        </div>
                        <div className="text-center">
                          <div className="flex items-center justify-center gap-1">
                            <Star className="h-5 w-5 fill-warning text-warning" />
                            <span className="text-2xl font-bold">
                              {stats.averageRating > 0 ? stats.averageRating.toFixed(1) : '-'}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground">Rating</p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Products Section */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
        >
          <motion.div variants={itemVariants} className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Package className="h-5 w-5" />
              Products by {seller.full_name.split(' ')[0]}
            </h2>
            <Badge variant="secondary">{products.length} items</Badge>
          </motion.div>

          {products.length === 0 ? (
            <motion.div variants={itemVariants}>
              <Card className="py-12">
                <div className="text-center">
                  <ShoppingBag className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground">This seller hasn't listed any products yet.</p>
                </div>
              </Card>
            </motion.div>
          ) : (
            <motion.div 
              variants={containerVariants}
              className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
            >
              {products.map((product) => (
                <motion.div key={product.id} variants={itemVariants}>
                  <ProductCard
                    product={product}
                    onPurchaseComplete={fetchSellerData}
                    isOwnProduct={product.agent_id === user?.id}
                    isInWishlist={wishlistIds.has(product.id)}
                    onWishlistChange={fetchWishlist}
                  />
                </motion.div>
              ))}
            </motion.div>
          )}
        </motion.div>
      </main>
    </div>
  );
}

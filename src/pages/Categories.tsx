import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Grid3X3, 
  ArrowLeft, 
  ArrowRight,
  Store,
  Package,
  ShoppingBag,
  Utensils,
  Coffee,
  Shirt,
  Smartphone,
  Home as HomeIcon,
  Sparkles
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
  discount_percentage?: number | null;
  discount_ends_at?: string | null;
}

interface CategoryData {
  name: string;
  products: Product[];
  totalCount: number;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1, delayChildren: 0.1 },
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

// Category icons and colors
const categoryConfig: Record<string, { icon: typeof Package; color: string; bgColor: string }> = {
  food: { icon: Utensils, color: 'text-green-500', bgColor: 'bg-green-500/10' },
  drinks: { icon: Coffee, color: 'text-blue-500', bgColor: 'bg-blue-500/10' },
  groceries: { icon: ShoppingBag, color: 'text-orange-500', bgColor: 'bg-orange-500/10' },
  clothing: { icon: Shirt, color: 'text-pink-500', bgColor: 'bg-pink-500/10' },
  electronics: { icon: Smartphone, color: 'text-purple-500', bgColor: 'bg-purple-500/10' },
  home: { icon: HomeIcon, color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  general: { icon: Package, color: 'text-muted-foreground', bgColor: 'bg-gray-500/10' },
};

const getIconForCategory = (category: string) => {
  const config = categoryConfig[category.toLowerCase()] || categoryConfig.general;
  return config;
};

export default function Categories() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [categories, setCategories] = useState<CategoryData[]>([]);
  const [loading, setLoading] = useState(true);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchCategories();
    if (user) fetchWishlist();
  }, [user]);

  const fetchCategories = async () => {
    setLoading(true);
    try {
      // Fetch all active products
      const { data: products, error } = await supabase
        .from('products')
        .select('*')
        .eq('active', true)
        .gt('stock', 0)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Group by category
      const categoryMap = new Map<string, Product[]>();
      (products || []).forEach(product => {
        const cat = product.category || 'general';
        if (!categoryMap.has(cat)) {
          categoryMap.set(cat, []);
        }
        categoryMap.get(cat)!.push(product);
      });

      // Convert to array and sort by product count
      const categoryData: CategoryData[] = Array.from(categoryMap.entries())
        .map(([name, prods]) => ({
          name,
          products: prods.slice(0, 4), // Featured products (first 4)
          totalCount: prods.length,
        }))
        .sort((a, b) => b.totalCount - a.totalCount);

      setCategories(categoryData);
    } catch (error) {
      console.error('Error fetching categories:', error);
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

  const totalProducts = categories.reduce((sum, cat) => sum + cat.totalCount, 0);

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
            <Badge variant="outline" className="bg-primary/10 border-primary/30 text-primary gap-1">
              <Grid3X3 className="h-3 w-3" />
              Categories
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/marketplace">
              <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                <Button variant="outline" size="sm" className="gap-2">
                  <Store className="h-4 w-4" />
                  <span className="hidden sm:inline">Marketplace</span>
                </Button>
              </motion.div>
            </Link>
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

      {/* Hero Section */}
      <section className="relative border-b border-border/50 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
        <div className="container mx-auto px-4 py-12 relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center max-w-2xl mx-auto"
          >
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-4">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium text-primary">Browse by Category</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mb-3">
              Shop by Categories
            </h1>
            <p className="text-muted-foreground">
              Explore our {categories.length} categories with {totalProducts} products from trusted agents
            </p>
          </motion.div>
        </div>
      </section>

      {/* Categories Grid */}
      <section className="container mx-auto px-4 py-8">
        {loading ? (
          <div className="space-y-8">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-4">
                <Skeleton className="h-8 w-48" />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[...Array(4)].map((_, j) => (
                    <div key={j} className="space-y-3">
                      <Skeleton className="aspect-square w-full rounded-lg" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-1/2" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : categories.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-20"
          >
            <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-6">
              <Grid3X3 className="h-10 w-10 text-muted-foreground" />
            </div>
            <h2 className="text-2xl font-bold mb-2">No Categories Yet</h2>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              Products will appear here once agents start listing them.
            </p>
            <Link to="/auth">
              <Button className="gap-2">
                Become an Agent
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </motion.div>
        ) : (
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="space-y-12"
          >
            {categories.map((category) => {
              const config = getIconForCategory(category.name);
              const IconComponent = config.icon;
              
              return (
                <motion.div key={category.name} variants={itemVariants}>
                  <Card className="overflow-hidden">
                    <CardHeader className="flex flex-row items-center justify-between pb-4">
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-xl ${config.bgColor}`}>
                          <IconComponent className={`h-5 w-5 ${config.color}`} />
                        </div>
                        <div>
                          <CardTitle className="capitalize text-xl">{category.name}</CardTitle>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            {category.totalCount} product{category.totalCount !== 1 ? 's' : ''} available
                          </p>
                        </div>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="gap-2"
                        onClick={() => navigate(`/marketplace?category=${category.name}`)}
                      >
                        View All
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {category.products.map((product) => (
                          <ProductCard
                            key={product.id}
                            product={product}
                            onPurchaseComplete={fetchCategories}
                            isOwnProduct={product.agent_id === user?.id}
                            isInWishlist={wishlistIds.has(product.id)}
                            onWishlistChange={fetchWishlist}
                          />
                        ))}
                      </div>
                      {category.totalCount > 4 && (
                        <div className="mt-4 text-center">
                          <Button 
                            variant="ghost" 
                            className="text-muted-foreground hover:text-foreground gap-2"
                            onClick={() => navigate(`/marketplace?category=${category.name}`)}
                          >
                            +{category.totalCount - 4} more products
                            <ArrowRight className="h-4 w-4" />
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </section>
    </div>
  );
}

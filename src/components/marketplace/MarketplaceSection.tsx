import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Package, Loader2, SlidersHorizontal, Heart, Search, X, Grid3X3, LayoutGrid, Sparkles } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { ProductCard } from './ProductCard';
import { CartDrawer } from './CartDrawer';
import { RecentlyViewedProducts } from './RecentlyViewedProducts';
import { ProductRecommendations } from './ProductRecommendations';
import { ComparisonDrawer } from './ComparisonDrawer';
import { SearchSuggestions } from './SearchSuggestions';
import { ProductDetailDialog } from './ProductDetailDialog';
import { HeroBanner } from './HeroBanner';
import { CategoryCarousel } from './CategoryCarousel';
import { PromoStrip } from './PromoStrip';
import { useAuth } from '@/hooks/useAuth';
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed';

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: string;
  image_url: string | null;
  stock: number;
  agent_id: string;
  created_at: string;
}

interface MarketplaceSectionProps {
  showAllProducts?: boolean;
  initialCategory?: string;
  externalSearchQuery?: string;
  selectedProductId?: string | null;
  onProductDialogClose?: () => void;
}

type SortOption = 'newest' | 'oldest' | 'price_low' | 'price_high' | 'name_az' | 'name_za';
type GridSize = '2' | '3' | '4';

export function MarketplaceSection({ 
  showAllProducts = true, 
  initialCategory, 
  externalSearchQuery = '',
  selectedProductId: externalSelectedProductId,
  onProductDialogClose
}: MarketplaceSectionProps) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { recentIds } = useRecentlyViewed();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState(initialCategory || 'all');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Combine internal and external search queries
  const effectiveSearchQuery = externalSearchQuery || searchQuery;
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [showInStock, setShowInStock] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showWishlistOnly, setShowWishlistOnly] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<Set<string>>(new Set());
  const [internalSelectedProductId, setInternalSelectedProductId] = useState<string | null>(null);
  const [gridSize, setGridSize] = useState<GridSize>('2');

  // Use external or internal selected product
  const selectedProductId = externalSelectedProductId ?? internalSelectedProductId;
  const setSelectedProductId = (id: string | null) => {
    setInternalSelectedProductId(id);
    if (id === null && onProductDialogClose) {
      onProductDialogClose();
    }
  };

  const selectedProduct = useMemo(() => 
    products.find(p => p.id === selectedProductId) || null,
    [products, selectedProductId]
  );

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .eq('active', true)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setProducts(data || []);
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchWishlist = async () => {
    if (!user) {
      setWishlistIds(new Set());
      return;
    }
    try {
      const { data, error } = await supabase
        .from('wishlists')
        .select('product_id')
        .eq('user_id', user.id);

      if (error) throw error;
      setWishlistIds(new Set(data?.map(w => w.product_id) || []));
    } catch (error) {
      console.error('Error fetching wishlist:', error);
    }
  };

  useEffect(() => {
    fetchProducts();
    fetchWishlist();
    // Realtime removed — products not in realtime whitelist
  }, [user]);

  const categories = useMemo(() => 
    ['all', ...new Set(products.map(p => p.category))],
    [products]
  );

  const filteredAndSortedProducts = useMemo(() => {
    let result = [...products];

    if (activeCategory !== 'all') {
      result = result.filter(p => p.category === activeCategory);
    }

    if (effectiveSearchQuery.trim()) {
      const query = effectiveSearchQuery.toLowerCase();
      result = result.filter(p => 
        p.name.toLowerCase().includes(query) ||
        (p.description?.toLowerCase().includes(query)) ||
        p.category.toLowerCase().includes(query)
      );
    }

    if (showInStock) {
      result = result.filter(p => p.stock > 0);
    }

    if (showWishlistOnly) {
      result = result.filter(p => wishlistIds.has(p.id));
    }

    switch (sortBy) {
      case 'newest':
        result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        break;
      case 'oldest':
        result.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
        break;
      case 'price_low':
        result.sort((a, b) => a.price - b.price);
        break;
      case 'price_high':
        result.sort((a, b) => b.price - a.price);
        break;
      case 'name_az':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name_za':
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
    }

    return result;
  }, [products, activeCategory, effectiveSearchQuery, sortBy, showInStock, showWishlistOnly, wishlistIds]);

  const activeFiltersCount = [
    activeCategory !== 'all',
    showInStock,
    showWishlistOnly,
    sortBy !== 'newest',
    effectiveSearchQuery.trim().length > 0
  ].filter(Boolean).length;

  const clearFilters = () => {
    setActiveCategory('all');
    setSearchQuery('');
    setSortBy('newest');
    setShowInStock(false);
    setShowWishlistOnly(false);
  };

  const gridClasses = {
    '2': 'grid-cols-2',
    '3': 'grid-cols-2 sm:grid-cols-3',
    '4': 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
  };

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Skeleton Hero */}
        <div className="h-48 sm:h-64 bg-muted rounded-2xl animate-pulse" />
        
        {/* Skeleton Categories */}
        <div className="flex gap-3 overflow-hidden">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2 min-w-[80px]">
              <div className="w-12 h-12 rounded-full bg-muted animate-pulse" />
              <div className="w-14 h-3 bg-muted rounded animate-pulse" />
            </div>
          ))}
        </div>
        
        {/* Skeleton Products */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="bg-card rounded-xl overflow-hidden border border-border/50">
              <div className="aspect-square bg-muted animate-pulse" />
              <div className="p-4 space-y-3">
                <div className="h-4 bg-muted rounded animate-pulse" />
                <div className="h-4 w-2/3 bg-muted rounded animate-pulse" />
                <div className="h-8 bg-muted rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="space-y-6">
        <HeroBanner />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 rounded-full bg-muted mb-4">
            <Package className="h-12 w-12 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No products available yet</h3>
          <p className="text-muted-foreground mb-4">Check back soon for amazing deals!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero Banner */}
      <HeroBanner />

      {/* Promo Strip */}
      <PromoStrip />
      
      {/* Category Carousel */}
      <CategoryCarousel />
      
      {/* Recently Viewed */}
      <RecentlyViewedProducts onProductPurchase={fetchProducts} />
      
      {/* Search & Filters */}
      <div className="sticky top-[73px] z-40 bg-background/95 backdrop-blur-lg py-3 -mx-3 px-3 sm:-mx-4 sm:px-4 border-b border-border/50">
        <div className="flex gap-2 items-center">
          <SearchSuggestions 
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onSelectProduct={setSelectedProductId}
            className="flex-1"
          />
          
          {/* Grid Size Toggle - Desktop only */}
          <div className="hidden md:flex items-center border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setGridSize('2')}
              className={`p-2 transition-colors ${gridSize === '2' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              <Grid3X3 className="h-4 w-4" />
            </button>
            <button
              onClick={() => setGridSize('4')}
              className={`p-2 transition-colors ${gridSize === '4' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>

          <Button
            variant={showFilters ? "default" : "outline"}
            size="icon"
            onClick={() => setShowFilters(!showFilters)}
            className="relative shrink-0"
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeFiltersCount > 0 && (
              <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground flex items-center justify-center">
                {activeFiltersCount}
              </span>
            )}
          </Button>
          
          {user && <CartDrawer />}
        </div>

        {/* Filter Options */}
        {showFilters && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 flex flex-wrap gap-3 p-4 rounded-xl bg-card border border-border/50 shadow-lg"
          >
            <div className="flex-1 min-w-[140px]">
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Sort By</label>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest First</SelectItem>
                  <SelectItem value="oldest">Oldest First</SelectItem>
                  <SelectItem value="price_low">Price: Low to High</SelectItem>
                  <SelectItem value="price_high">Price: High to Low</SelectItem>
                  <SelectItem value="name_az">Name: A to Z</SelectItem>
                  <SelectItem value="name_za">Name: Z to A</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 min-w-[140px]">
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Category</label>
              <Select value={activeCategory} onValueChange={setActiveCategory}>
                <SelectTrigger className="h-9 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((cat) => (
                    <SelectItem key={cat} value={cat} className="capitalize">
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-end gap-2 flex-wrap">
              <Button
                variant={showInStock ? "default" : "outline"}
                size="sm"
                onClick={() => setShowInStock(!showInStock)}
                className="h-9"
              >
                In Stock Only
              </Button>

              {user && (
                <Button
                  variant={showWishlistOnly ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowWishlistOnly(!showWishlistOnly)}
                  className="h-9 gap-1.5"
                >
                  <Heart className={`h-4 w-4 ${showWishlistOnly ? 'fill-current' : ''}`} />
                  Wishlist
                </Button>
              )}

              {activeFiltersCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="h-9 text-muted-foreground gap-1"
                >
                  <X className="h-4 w-4" />
                  Clear
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </div>

      {/* Product Recommendations */}
      {recentIds.length > 0 && (
        <ProductRecommendations 
          onProductPurchase={fetchProducts}
          excludeIds={recentIds}
        />
      )}

      {/* Results Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">
            {activeCategory === 'all' ? 'All Products' : activeCategory}
          </h2>
          <Badge variant="secondary" className="font-normal">
            {filteredAndSortedProducts.length}
          </Badge>
        </div>
        {searchQuery && (
          <Badge variant="outline" className="gap-1.5 font-normal">
            "{searchQuery}"
            <button onClick={() => setSearchQuery('')} className="ml-1 hover:text-foreground">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
      </div>

      {/* Products Grid */}
      {filteredAndSortedProducts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="p-4 rounded-full bg-muted mb-4">
            <Search className="h-10 w-10 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No products found</h3>
          <p className="text-muted-foreground mb-4">Try adjusting your filters or search query</p>
          <Button variant="outline" onClick={clearFilters}>
            Clear All Filters
          </Button>
        </div>
      ) : (
        <motion.div 
          layout
          className={`grid ${gridClasses[gridSize]} gap-3 sm:gap-4`}
        >
          {filteredAndSortedProducts.map((product, index) => (
            <motion.div
              key={product.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index * 0.05, 0.3) }}
            >
              <ProductCard 
                product={product} 
                onPurchaseComplete={fetchProducts}
                isOwnProduct={product.agent_id === user?.id}
                isInWishlist={wishlistIds.has(product.id)}
                onWishlistChange={fetchWishlist}
              />
            </motion.div>
          ))}
        </motion.div>
      )}
      
      {/* Comparison Drawer */}
      <ComparisonDrawer />

      {/* Product Detail Dialog from Search */}
      {selectedProduct && (
        <ProductDetailDialog
          product={selectedProduct}
          open={!!selectedProductId}
          onOpenChange={(open) => !open && setSelectedProductId(null)}
          onPurchaseComplete={fetchProducts}
        />
      )}
    </div>
  );
}

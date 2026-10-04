import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Store, ArrowLeft, Zap, Grid3X3, ShoppingBag, Heart, ShoppingCart, Menu } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import WelileLogo from '@/components/WelileLogo';
import { useAuth } from '@/hooks/useAuth';
import { MarketplaceSection } from '@/components/marketplace/MarketplaceSection';

import { CartDrawer } from '@/components/marketplace/CartDrawer';
import { useCart } from '@/hooks/useCart';
import { SearchSuggestions } from '@/components/marketplace/SearchSuggestions';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export default function Marketplace() {
  const { itemCount } = useCart();
  const { user, signOut, role } = useAuth();
  const [searchParams] = useSearchParams();
  const initialCategory = searchParams.get('category') || undefined;
  const [headerSearch, setHeaderSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);

  return (
    <div className="min-h-screen bg-background pb-20 md:pb-0">
      <Helmet>
        <title>Marketplace — Shop Essentials | Welile</title>
        <meta
          name="description"
          content="Browse the Welile Marketplace for everyday essentials, home goods, and more — shop trusted products and pay flexibly, delivered across Uganda."
        />
        <link rel="canonical" href="https://welileapp.com/marketplace" />
        <meta property="og:title" content="Welile Marketplace — Shop Essentials" />
        <meta
          property="og:description"
          content="Shop everyday essentials and home goods on the Welile Marketplace, with flexible payment options across Uganda."
        />
        <meta property="og:url" content="https://welileapp.com/marketplace" />
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            name: 'Welile Marketplace',
            description:
              'Browse everyday essentials, home goods, and more on the Welile Marketplace with flexible payment options across Uganda.',
            url: 'https://welileapp.com/marketplace',
            isPartOf: {
              '@type': 'WebSite',
              name: 'Welile.com',
              url: 'https://welileapp.com/',
            },
          })}
        </script>
      </Helmet>
      {/* Header */}
      <motion.header 
        initial={{ y: -100 }}
        animate={{ y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="sticky top-0 z-50 border-b border-border/50 bg-background/95 backdrop-blur-xl"
      >
        <div className="container mx-auto px-3 py-3 sm:px-4 sm:py-4">
          {/* Top Row - Logo and Actions */}
          <div className="flex items-center justify-between gap-3">
            {/* Left - Logo */}
            <div className="flex items-center gap-2 shrink-0">
              <Link to="/">
                <motion.div whileHover={{ scale: 1.05 }} transition={{ type: 'spring', stiffness: 400, damping: 17 }}>
                  <WelileLogo />
                </motion.div>
              </Link>
              <Badge variant="outline" className="hidden sm:flex bg-primary/10 border-primary/30 text-primary gap-1 text-xs">
                <Store className="h-3 w-3" />
                Marketplace
              </Badge>
            </div>

            {/* Center - Search Bar (Desktop) */}
            <div className="hidden md:flex flex-1 max-w-xl mx-4">
              <SearchSuggestions
                query={headerSearch}
                onQueryChange={setHeaderSearch}
                onSelectProduct={setSelectedProductId}
                className="w-full"
              />
            </div>

            {/* Right - Actions */}
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              {/* Cart */}
              {user && (
                <CartDrawer>
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="relative">
                    <Button variant="outline" size="sm" className="h-9 w-9 p-0">
                      <ShoppingCart className="h-4 w-4" />
                    </Button>
                    {itemCount > 0 && (
                      <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center">
                        {itemCount > 9 ? '9+' : itemCount}
                      </span>
                    )}
                  </motion.div>
                </CartDrawer>
              )}

              <ThemeToggle />

              {/* Menu Dropdown */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                    <Button variant="outline" size="sm" className="h-9 w-9 p-0 sm:w-auto sm:px-3 sm:gap-2">
                      <Menu className="h-4 w-4" />
                      <span className="hidden sm:inline">Menu</span>
                    </Button>
                  </motion.div>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48 bg-popover border border-border shadow-lg z-50">
                  <DropdownMenuItem asChild>
                    <Link to="/categories" className="flex items-center gap-2 cursor-pointer">
                      <Grid3X3 className="h-4 w-4" />
                      Categories
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/flash-sales" className="flex items-center gap-2 cursor-pointer text-amber-600 dark:text-amber-400">
                      <Zap className="h-4 w-4 fill-current" />
                      Flash Sales
                    </Link>
                  </DropdownMenuItem>
                  
                  {user && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link to="/orders" className="flex items-center gap-2 cursor-pointer">
                          <ShoppingBag className="h-4 w-4" />
                          My Orders
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to="/wishlist" className="flex items-center gap-2 cursor-pointer">
                          <Heart className="h-4 w-4" />
                          Wishlist
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                  
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to={user ? "/dashboard/tenant" : "/auth"} className="flex items-center gap-2 cursor-pointer">
                      <ArrowLeft className="h-4 w-4" />
                      {user ? 'Dashboard' : 'Sign In'}
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Mobile Search Bar */}
          <div className="md:hidden mt-3">
            <SearchSuggestions
              query={headerSearch}
              onQueryChange={setHeaderSearch}
              onSelectProduct={setSelectedProductId}
              className="w-full"
            />
          </div>

          {/* Category badge if filtered */}
          {initialCategory && (
            <div className="mt-2">
              <Badge className="capitalize">{initialCategory}</Badge>
            </div>
          )}
        </div>
      </motion.header>

      {/* Main Content */}
      <main className="container mx-auto px-3 py-4 sm:px-4 sm:py-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <MarketplaceSection 
            initialCategory={initialCategory} 
            externalSearchQuery={headerSearch}
            selectedProductId={selectedProductId}
            onProductDialogClose={() => setSelectedProductId(null)}
          />
        </motion.div>
      </main>

      {/* Floating Cart Button - Mobile */}
      {user && (
        <div className="fixed bottom-24 right-4 z-50 md:hidden">
          <CartDrawer>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="relative"
            >
              <Button 
                size="lg" 
                className="h-14 w-14 rounded-full shadow-lg bg-primary hover:bg-primary/90"
              >
                <ShoppingCart className="h-6 w-6" />
              </Button>
              {itemCount > 0 && (
                <span className="absolute -top-1 -right-1 h-6 w-6 rounded-full bg-destructive text-destructive-foreground text-xs font-bold flex items-center justify-center">
                  {itemCount > 99 ? '99+' : itemCount}
                </span>
              )}
            </motion.div>
          </CartDrawer>
        </div>
      )}

    </div>
  );
}

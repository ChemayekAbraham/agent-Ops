import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { StorageImage } from '@/components/ui/StorageImage';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Scale, X, Trash2, Package, Check, Minus } from 'lucide-react';
import { useProductComparison } from '@/hooks/useProductComparison';
import { cn } from '@/lib/utils';

const isDiscountActive = (product: { discount_percentage?: number | null; discount_ends_at?: string | null }): boolean => {
  if (!product.discount_percentage || product.discount_percentage <= 0) return false;
  if (!product.discount_ends_at) return true;
  return new Date(product.discount_ends_at) > new Date();
};

const getDiscountedPrice = (product: { price: number; discount_percentage?: number | null; discount_ends_at?: string | null }): number => {
  if (!isDiscountActive(product)) return product.price;
  return Math.round(product.price * (1 - (product.discount_percentage || 0) / 100));
};

export function ComparisonDrawer() {
  const { comparisonProducts, removeFromComparison, clearComparison, maxProducts } = useProductComparison();

  if (comparisonProducts.length === 0) {
    return null;
  }

  const specs = [
    { label: 'Price', key: 'price' },
    { label: 'Category', key: 'category' },
    { label: 'Stock', key: 'stock' },
    { label: 'Discount', key: 'discount' },
  ];

  const getLowestPrice = () => {
    return Math.min(...comparisonProducts.map(p => getDiscountedPrice(p)));
  };

  const getHighestStock = () => {
    return Math.max(...comparisonProducts.map(p => p.stock));
  };

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button 
          variant="default" 
          size="sm" 
          className="gap-2 fixed bottom-20 md:bottom-6 right-4 z-50 shadow-lg"
        >
          <Scale className="h-4 w-4" />
          Compare
          <Badge variant="secondary" className="ml-1">
            {comparisonProducts.length}/{maxProducts}
          </Badge>
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[80vh] md:h-[70vh]">
        <SheetHeader className="flex flex-row items-center justify-between pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Compare Products ({comparisonProducts.length})
          </SheetTitle>
          <Button variant="ghost" size="sm" onClick={clearComparison} className="gap-2">
            <Trash2 className="h-4 w-4" />
            Clear All
          </Button>
        </SheetHeader>
        
        <ScrollArea className="h-[calc(80vh-100px)] md:h-[calc(70vh-100px)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px]">
              <thead>
                <tr>
                  <th className="text-left p-3 bg-muted/50 rounded-tl-lg w-32">Feature</th>
                  {comparisonProducts.map((product) => (
                    <th key={product.id} className="p-3 bg-muted/50 last:rounded-tr-lg">
                      <div className="relative">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute -top-1 -right-1 h-6 w-6"
                          onClick={() => removeFromComparison(product.id)}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                        <div className="flex flex-col items-center gap-2">
                          {product.image_url ? (
                            <StorageImage 
                              src={product.image_url} 
                              alt={product.name}
                              className="w-20 h-20 object-cover rounded-lg"
                            />
                          ) : (
                            <div className="w-20 h-20 bg-muted rounded-lg flex items-center justify-center">
                              <Package className="h-8 w-8 text-muted-foreground" />
                            </div>
                          )}
                          <span className="font-medium text-sm text-center line-clamp-2">
                            {product.name}
                          </span>
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Price Row */}
                <tr className="border-b border-border/50">
                  <td className="p-3 font-medium text-muted-foreground">Price</td>
                  {comparisonProducts.map((product) => {
                    const discounted = getDiscountedPrice(product);
                    const isLowest = discounted === getLowestPrice();
                    return (
                      <td key={product.id} className="p-3 text-center">
                        <div className={cn(
                          "font-bold text-lg",
                          isLowest && comparisonProducts.length > 1 && "text-green-600 dark:text-green-400"
                        )}>
                          UGX {discounted.toLocaleString()}
                          {isLowest && comparisonProducts.length > 1 && (
                            <Badge variant="secondary" className="ml-2 text-xs">Lowest</Badge>
                          )}
                        </div>
                        {isDiscountActive(product) && (
                          <div className="text-sm text-muted-foreground line-through">
                            UGX {product.price.toLocaleString()}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>

                {/* Category Row */}
                <tr className="border-b border-border/50">
                  <td className="p-3 font-medium text-muted-foreground">Category</td>
                  {comparisonProducts.map((product) => (
                    <td key={product.id} className="p-3 text-center">
                      <Badge variant="outline" className="capitalize">
                        {product.category}
                      </Badge>
                    </td>
                  ))}
                </tr>

                {/* Stock Row */}
                <tr className="border-b border-border/50">
                  <td className="p-3 font-medium text-muted-foreground">Availability</td>
                  {comparisonProducts.map((product) => {
                    const isHighest = product.stock === getHighestStock();
                    return (
                      <td key={product.id} className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          {product.stock > 0 ? (
                            <>
                              <Check className="h-4 w-4 text-green-600" />
                              <span className={cn(
                                isHighest && comparisonProducts.length > 1 && "font-medium text-green-600 dark:text-green-400"
                              )}>
                                {product.stock} in stock
                              </span>
                            </>
                          ) : (
                            <>
                              <Minus className="h-4 w-4 text-destructive" />
                              <span className="text-destructive">Out of stock</span>
                            </>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>

                {/* Discount Row */}
                <tr className="border-b border-border/50">
                  <td className="p-3 font-medium text-muted-foreground">Discount</td>
                  {comparisonProducts.map((product) => (
                    <td key={product.id} className="p-3 text-center">
                      {isDiscountActive(product) ? (
                        <Badge className="bg-red-500 text-white">
                          {product.discount_percentage}% OFF
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  ))}
                </tr>

                {/* Description Row */}
                <tr>
                  <td className="p-3 font-medium text-muted-foreground align-top">Description</td>
                  {comparisonProducts.map((product) => (
                    <td key={product.id} className="p-3 text-center">
                      <p className="text-sm text-muted-foreground line-clamp-4">
                        {product.description || 'No description available'}
                      </p>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

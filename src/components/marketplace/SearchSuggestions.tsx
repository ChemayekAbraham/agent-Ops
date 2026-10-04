import { useState, useEffect, useRef } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import { Search, TrendingUp, Clock, Package, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface Product {
  id: string;
  name: string;
  category: string;
  price: number;
  image_url: string | null;
}

interface SearchSuggestionsProps {
  query: string;
  onQueryChange: (query: string) => void;
  onSelectProduct?: (productId: string) => void;
  className?: string;
}

export function SearchSuggestions({ 
  query, 
  onQueryChange, 
  onSelectProduct,
  className 
}: SearchSuggestionsProps) {
  const [suggestions, setSuggestions] = useState<Product[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [popularSearches] = useState(['electronics', 'clothing', 'accessories', 'food']);
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load recent searches from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('recentProductSearches');
    if (stored) {
      try {
        setRecentSearches(JSON.parse(stored).slice(0, 5));
      } catch {
        setRecentSearches([]);
      }
    }
  }, []);

  // Fetch suggestions when query changes
  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const fetchSuggestions = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('products')
          .select('id, name, category, price, image_url')
          .eq('active', true)
          .ilike('name', `%${query}%`)
          .limit(6);

        if (error) throw error;
        setSuggestions(data || []);
      } catch (error) {
        console.error('Error fetching suggestions:', error);
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    };

    const debounce = setTimeout(fetchSuggestions, 200);
    return () => clearTimeout(debounce);
  }, [query]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const saveRecentSearch = (term: string) => {
    if (!term.trim()) return;
    const updated = [term, ...recentSearches.filter(s => s !== term)].slice(0, 5);
    setRecentSearches(updated);
    localStorage.setItem('recentProductSearches', JSON.stringify(updated));
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
    localStorage.removeItem('recentProductSearches');
  };

  const handleSelectSuggestion = (product: Product) => {
    saveRecentSearch(product.name);
    setIsOpen(false);
    if (onSelectProduct) {
      onSelectProduct(product.id);
    }
  };

  const handleSelectSearch = (term: string) => {
    onQueryChange(term);
    saveRecentSearch(term);
    setIsOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      saveRecentSearch(query.trim());
      setIsOpen(false);
    }
  };

  const showDropdown = isOpen && (
    query.trim().length >= 2 || 
    recentSearches.length > 0 || 
    popularSearches.length > 0
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <form onSubmit={handleSubmit} className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search products..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => setIsOpen(true)}
          className="w-full h-10 pl-9 pr-9 rounded-md border border-input bg-background text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              onQueryChange('');
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-sm flex items-center justify-center hover:bg-accent"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
      </form>

      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden animate-in fade-in-0 zoom-in-95">
          {/* Product Suggestions */}
          {query.trim().length >= 2 && (
            <div className="p-2">
              {loading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Searching...
                </div>
              ) : suggestions.length > 0 ? (
                <>
                  <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Products</p>
                  {suggestions.map((product) => (
                    <button
                      key={product.id}
                      onClick={() => handleSelectSuggestion(product)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-accent transition-colors text-left"
                    >
                      {product.image_url ? (
                        <StorageImage 
                          src={product.image_url} 
                          alt={product.name}
                          className="h-10 w-10 rounded-md object-cover bg-muted"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center">
                          <Package className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{product.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{product.category}</p>
                      </div>
                      <span className="text-sm font-semibold text-primary">
                        UGX {product.price.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Search className="h-4 w-4" />
                  No products found for "{query}"
                </div>
              )}
            </div>
          )}

          {/* Separator */}
          {query.trim().length >= 2 && (recentSearches.length > 0 || popularSearches.length > 0) && (
            <div className="border-t border-border" />
          )}

          {/* Recent Searches */}
          {recentSearches.length > 0 && query.trim().length < 2 && (
            <div className="p-2">
              <div className="flex items-center justify-between px-3 py-1.5">
                <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  Recent Searches
                </p>
                <button 
                  onClick={clearRecentSearches}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              {recentSearches.map((term, i) => (
                <button
                  key={i}
                  onClick={() => handleSelectSearch(term)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-accent transition-colors text-left text-sm"
                >
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {term}
                </button>
              ))}
            </div>
          )}

          {/* Popular Searches */}
          {query.trim().length < 2 && (
            <div className="p-2 border-t border-border">
              <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <TrendingUp className="h-3 w-3" />
                Popular Categories
              </p>
              <div className="flex flex-wrap gap-1.5 px-3 py-1">
                {popularSearches.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSelectSearch(term)}
                    className="px-3 py-1 rounded-full bg-secondary text-secondary-foreground text-xs font-medium hover:bg-secondary/80 transition-colors capitalize"
                  >
                    {term}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

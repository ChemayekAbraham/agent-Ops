import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

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

interface ComparisonContextType {
  comparisonProducts: Product[];
  addToComparison: (product: Product) => boolean;
  removeFromComparison: (productId: string) => void;
  clearComparison: () => void;
  isInComparison: (productId: string) => boolean;
  maxProducts: number;
}

const ComparisonContext = createContext<ComparisonContextType | undefined>(undefined);

const MAX_COMPARISON_PRODUCTS = 4;

export function ComparisonProvider({ children }: { children: ReactNode }) {
  const [comparisonProducts, setComparisonProducts] = useState<Product[]>([]);

  const addToComparison = useCallback((product: Product): boolean => {
    if (comparisonProducts.length >= MAX_COMPARISON_PRODUCTS) {
      return false;
    }
    if (comparisonProducts.some(p => p.id === product.id)) {
      return false;
    }
    setComparisonProducts(prev => [...prev, product]);
    return true;
  }, [comparisonProducts]);

  const removeFromComparison = useCallback((productId: string) => {
    setComparisonProducts(prev => prev.filter(p => p.id !== productId));
  }, []);

  const clearComparison = useCallback(() => {
    setComparisonProducts([]);
  }, []);

  const isInComparison = useCallback((productId: string): boolean => {
    return comparisonProducts.some(p => p.id === productId);
  }, [comparisonProducts]);

  return (
    <ComparisonContext.Provider value={{
      comparisonProducts,
      addToComparison,
      removeFromComparison,
      clearComparison,
      isInComparison,
      maxProducts: MAX_COMPARISON_PRODUCTS,
    }}>
      {children}
    </ComparisonContext.Provider>
  );
}

// Safe fallback when provider hasn't loaded yet
const comparisonFallback: ComparisonContextType = {
  comparisonProducts: [],
  addToComparison: () => false,
  removeFromComparison: () => {},
  clearComparison: () => {},
  isInComparison: () => false,
  maxProducts: MAX_COMPARISON_PRODUCTS,
};

export function useProductComparison() {
  const context = useContext(ComparisonContext);
  return context ?? comparisonFallback;
}

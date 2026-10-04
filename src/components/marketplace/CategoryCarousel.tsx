import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { 
  ShoppingBasket, 
  Coffee, 
  Apple, 
  Package,
  Sparkles,
  Shirt,
  Home,
  Smartphone
} from 'lucide-react';

interface Category {
  id: string;
  name: string;
  icon: React.ElementType;
  color: string;
  bgColor: string;
}

const categories: Category[] = [
  { id: 'food', name: 'Food', icon: Apple, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/30' },
  { id: 'drinks', name: 'Drinks', icon: Coffee, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
  { id: 'groceries', name: 'Groceries', icon: ShoppingBasket, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-900/30' },
  { id: 'electronics', name: 'Electronics', icon: Smartphone, color: 'text-purple-600', bgColor: 'bg-purple-100 dark:bg-purple-900/30' },
  { id: 'fashion', name: 'Fashion', icon: Shirt, color: 'text-pink-600', bgColor: 'bg-pink-100 dark:bg-pink-900/30' },
  { id: 'home', name: 'Home', icon: Home, color: 'text-amber-600', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  { id: 'beauty', name: 'Beauty', icon: Sparkles, color: 'text-rose-600', bgColor: 'bg-rose-100 dark:bg-rose-900/30' },
  { id: 'general', name: 'General', icon: Package, color: 'text-gray-600', bgColor: 'bg-gray-100 dark:bg-gray-900/30' },
];

export function CategoryCarousel() {
  const navigate = useNavigate();

  return (
    <div className="py-4">
      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <span className="h-1 w-6 bg-primary rounded-full" />
        Browse Categories
      </h3>
      <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1">
        {categories.map((category, index) => (
          <motion.button
            key={category.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.05 }}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate(`/marketplace?category=${category.id}`)}
            className="flex flex-col items-center gap-2 p-3 min-w-[80px] rounded-xl border border-border/50 bg-card hover:border-primary/50 hover:shadow-lg transition-all group"
          >
            <div className={`p-3 rounded-full ${category.bgColor} group-hover:scale-110 transition-transform`}>
              <category.icon className={`h-5 w-5 ${category.color}`} />
            </div>
            <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors whitespace-nowrap">
              {category.name}
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

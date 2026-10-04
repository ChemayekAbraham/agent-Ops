import { motion } from 'framer-motion';
import { Truck, Shield, Clock, CreditCard } from 'lucide-react';

const promoItems = [
  { icon: Truck, text: 'Fast Delivery', subtext: '2-3 days' },
  { icon: Shield, text: 'Secure Payment', subtext: '100% Safe' },
  { icon: Clock, text: '24/7 Support', subtext: 'Always here' },
  { icon: CreditCard, text: 'Easy Returns', subtext: '7 days' },
];

export function PromoStrip() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {promoItems.map((item, index) => (
        <motion.div
          key={item.text}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.1 }}
          className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border/50 hover:border-primary/30 hover:shadow-md transition-all"
        >
          <div className="p-2 rounded-lg bg-primary/10">
            <item.icon className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.text}</p>
            <p className="text-xs text-muted-foreground">{item.subtext}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

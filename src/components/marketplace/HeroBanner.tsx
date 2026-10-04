import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, Zap, Truck, Shield, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';

interface BannerSlide {
  id: number;
  title: string;
  subtitle: string;
  cta: string;
  link: string;
  gradient: string;
  icon: React.ElementType;
  badge?: string;
}

const bannerSlides: BannerSlide[] = [
  {
    id: 1,
    title: "Flash Sales Live Now!",
    subtitle: "Up to 50% off on selected items. Limited time only!",
    cta: "Shop Now",
    link: "/flash-sales",
    gradient: "from-orange-500 via-red-500 to-pink-500",
    icon: Zap,
    badge: "HOT"
  },
  {
    id: 2,
    title: "Free Delivery",
    subtitle: "On orders above UGX 50,000. Shop more, save more!",
    cta: "Start Shopping",
    link: "/marketplace",
    gradient: "from-blue-500 via-purple-500 to-indigo-500",
    icon: Truck
  },
  {
    id: 3,
    title: "Buyer Protection",
    subtitle: "100% secure payments. Your money is safe with us.",
    cta: "Learn More",
    link: "/marketplace",
    gradient: "from-green-500 via-emerald-500 to-teal-500",
    icon: Shield
  }
];

export function HeroBanner() {
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % bannerSlides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const nextSlide = () => setCurrentSlide((prev) => (prev + 1) % bannerSlides.length);
  const prevSlide = () => setCurrentSlide((prev) => (prev - 1 + bannerSlides.length) % bannerSlides.length);

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <AnimatePresence mode="wait">
        {bannerSlides.map((slide, index) => (
          index === currentSlide && (
            <motion.div
              key={slide.id}
              initial={{ opacity: 0, x: 100 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -100 }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
              className={`relative bg-gradient-to-r ${slide.gradient} p-6 sm:p-10 md:p-12`}
            >
              {/* Background Pattern */}
              <div className="absolute inset-0 opacity-10">
                <div className="absolute inset-0" style={{
                  backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`
                }} />
              </div>
              
              <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-6">
                <div className="flex-1 text-center md:text-left">
                  {slide.badge && (
                    <Badge className="mb-3 bg-white/20 text-white border-white/30 animate-pulse">
                      {slide.badge}
                    </Badge>
                  )}
                  <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white mb-2 drop-shadow-lg">
                    {slide.title}
                  </h2>
                  <p className="text-white/90 text-sm sm:text-base md:text-lg mb-4 max-w-md">
                    {slide.subtitle}
                  </p>
                  <Link to={slide.link}>
                    <Button size="lg" className="bg-white text-gray-900 hover:bg-white/90 shadow-xl font-semibold">
                      {slide.cta}
                    </Button>
                  </Link>
                </div>
                
                <motion.div 
                  initial={{ scale: 0.8, rotate: -10 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ delay: 0.2, type: "spring" }}
                  className="hidden md:flex items-center justify-center"
                >
                  <div className="relative">
                    <div className="absolute inset-0 bg-white/20 rounded-full blur-3xl" />
                    <slide.icon className="h-32 w-32 text-white/80 relative z-10" />
                  </div>
                </motion.div>
              </div>
            </motion.div>
          )
        ))}
      </AnimatePresence>

      {/* Navigation Arrows */}
      <button 
        onClick={prevSlide}
        className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/20 backdrop-blur-sm text-white hover:bg-white/40 transition-colors z-20"
      >
        <ChevronLeft className="h-5 w-5" />
      </button>
      <button 
        onClick={nextSlide}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/20 backdrop-blur-sm text-white hover:bg-white/40 transition-colors z-20"
      >
        <ChevronRight className="h-5 w-5" />
      </button>

      {/* Dots Indicator */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-2 z-20">
        {bannerSlides.map((_, index) => (
          <button
            key={index}
            onClick={() => setCurrentSlide(index)}
            className={`h-2 rounded-full transition-all ${
              index === currentSlide 
                ? 'w-6 bg-white' 
                : 'w-2 bg-white/50 hover:bg-white/70'
            }`}
          />
        ))}
      </div>
    </div>
  );
}

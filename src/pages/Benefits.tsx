import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Home, Users, Wallet, Receipt, ShoppingBag, TrendingUp, 
  Shield, Clock, Gift, Share2, ArrowLeft, CheckCircle2,
  Smartphone, CreditCard, Percent, Building2, Coins, Star,
  Zap, Trophy, Target, Sparkles, BadgeDollarSign, Flame,
  Timer, AlertCircle, PartyPopper, MessageCircle, Search, X
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useLanguage } from '@/hooks/useLanguage';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { playCoinSound, playUrgencySound } from '@/lib/notificationSound';
import RegisterLandlordDialog from '@/components/tenant/RegisterLandlordDialog';

// Limited time offer component with countdown and spots remaining
function LimitedTimeOfferBanner({ onClaim }: { onClaim: () => void }) {
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [isVisible, setIsVisible] = useState(true);
  const [spotsRemaining, setSpotsRemaining] = useState(() => {
    // Initialize from localStorage or start with a random number between 47-89
    const stored = localStorage.getItem('welile-spots-remaining');
    const storedTime = localStorage.getItem('welile-spots-timestamp');
    const now = Date.now();
    
    // Reset if more than 24 hours have passed
    if (stored && storedTime && (now - parseInt(storedTime)) < 24 * 60 * 60 * 1000) {
      return parseInt(stored);
    }
    return Math.floor(Math.random() * 43) + 47; // 47-89 spots
  });
  const [claimedToday, setClaimedToday] = useState(() => {
    return Math.floor(Math.random() * 1500) + 2000; // 2000-3500
  });
  const [justClaimed, setJustClaimed] = useState(false);
  
  // Calculate end time - resets daily at midnight
  const endTime = useMemo(() => {
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end.getTime();
  }, []);

  // Countdown timer
  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = new Date().getTime();
      const difference = endTime - now;
      
      if (difference > 0) {
        setTimeLeft({
          hours: Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
          minutes: Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60)),
          seconds: Math.floor((difference % (1000 * 60)) / 1000)
        });
      }
    };

    calculateTimeLeft();
    const timer = setInterval(calculateTimeLeft, 1000);
    return () => clearInterval(timer);
  }, [endTime]);

  // Randomly decrease spots remaining to create urgency
  // Randomly decrease spots remaining to create urgency
  useEffect(() => {
    const decreaseSpots = () => {
      setSpotsRemaining(prev => {
        if (prev <= 5) return prev; // Don't go below 5
        const decrease = Math.random() > 0.7 ? 1 : 0; // 30% chance to decrease
        const newValue = prev - decrease;
        localStorage.setItem('welile-spots-remaining', String(newValue));
        localStorage.setItem('welile-spots-timestamp', String(Date.now()));
        
        if (decrease > 0) {
          setJustClaimed(true);
          setClaimedToday(prev => prev + 1);
          
          // Play notification sound when someone claims
          playCoinSound();
          
          // Play urgency sound if spots are critically low
          if (newValue <= 10) {
            setTimeout(() => playUrgencySound(), 300);
          }
          
          setTimeout(() => setJustClaimed(false), 2000);
        }
        
        return newValue;
      });
    };

    // Decrease every 3-8 seconds randomly
    const scheduleDecrease = () => {
      const delay = Math.floor(Math.random() * 5000) + 3000;
      return setTimeout(() => {
        decreaseSpots();
        scheduleDecrease();
      }, delay);
    };

    const timerId = scheduleDecrease();
    return () => clearTimeout(timerId);
  }, []);

  if (!isVisible) return null;

  // Determine urgency level based on spots
  const urgencyLevel = spotsRemaining <= 10 ? 'critical' : spotsRemaining <= 25 ? 'high' : 'normal';
  const spotsColor = urgencyLevel === 'critical' ? 'text-red-500' : urgencyLevel === 'high' ? 'text-orange-500' : 'text-amber-500';
  const spotsBg = urgencyLevel === 'critical' ? 'bg-red-500/10' : urgencyLevel === 'high' ? 'bg-orange-500/10' : 'bg-amber-500/10';

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="mb-6"
      >
        <Card className="relative overflow-hidden border-2 border-amber-500/50 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10">
          {/* Animated background shimmer */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_2s_infinite] -translate-x-full" 
               style={{ animation: 'shimmer 2s infinite' }} />
          
          {/* Pulsing border effect */}
          <div className="absolute inset-0 border-2 border-amber-400/30 rounded-lg animate-pulse" />
          
          <CardContent className="p-4 relative">
            {/* Close button */}
            <button 
              onClick={() => setIsVisible(false)}
              className="absolute top-2 right-2 text-muted-foreground hover:text-foreground transition-colors z-10"
            >
              ✕
            </button>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              {/* Icon with animation */}
              <motion.div
                animate={{ rotate: [0, -10, 10, -10, 0], scale: [1, 1.1, 1] }}
                transition={{ repeat: Infinity, duration: 2, repeatDelay: 1 }}
                className="shrink-0"
              >
                <div className="p-3 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg">
                  <PartyPopper className="h-8 w-8 text-white" />
                </div>
              </motion.div>

              <div className="flex-1 text-center sm:text-left">
                <div className="flex items-center justify-center sm:justify-start gap-2 mb-1 flex-wrap">
                  <Badge className="bg-red-500 text-white animate-pulse">
                    🔥 LIMITED TIME
                  </Badge>
                  <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400">
                    TODAY ONLY
                  </Badge>
                </div>
                
                <h3 className="font-bold text-lg mb-1">
                  🎁 Get <span className="text-amber-500">BONUS</span> - UGX 500 Per Referral!
                </h3>
                <p className="text-sm text-muted-foreground">
                  Invite friends and earn UGX 500 for each signup. Don't miss out!
                </p>

                {/* Countdown Timer & Spots Remaining */}
                <div className="flex flex-col sm:flex-row items-center justify-center sm:justify-start gap-3 mt-3">
                  {/* Timer */}
                  <div className="flex items-center gap-2">
                    <Timer className="h-4 w-4 text-red-500" />
                    <span className="text-xs font-medium text-muted-foreground">Ends in:</span>
                    <div className="flex gap-1">
                      <span className="bg-foreground text-background px-1.5 py-0.5 rounded font-mono font-bold text-xs">
                        {String(timeLeft.hours).padStart(2, '0')}
                      </span>
                      <span className="font-bold text-xs">:</span>
                      <span className="bg-foreground text-background px-1.5 py-0.5 rounded font-mono font-bold text-xs">
                        {String(timeLeft.minutes).padStart(2, '0')}
                      </span>
                      <span className="font-bold text-xs">:</span>
                      <span className="bg-foreground text-background px-1.5 py-0.5 rounded font-mono font-bold text-xs animate-pulse">
                        {String(timeLeft.seconds).padStart(2, '0')}
                      </span>
                    </div>
                  </div>

                  <span className="hidden sm:block text-muted-foreground">•</span>

                  {/* Spots Remaining Counter */}
                  <motion.div 
                    className={`flex items-center gap-2 px-2 py-1 rounded-full ${spotsBg}`}
                    animate={justClaimed ? { scale: [1, 1.1, 1] } : {}}
                    transition={{ duration: 0.3 }}
                  >
                    <motion.div
                      animate={urgencyLevel === 'critical' ? { scale: [1, 1.2, 1] } : {}}
                      transition={{ repeat: Infinity, duration: 0.5 }}
                    >
                      <Users className={`h-4 w-4 ${spotsColor}`} />
                    </motion.div>
                    <span className="text-xs font-bold">
                      Only <motion.span 
                        key={spotsRemaining}
                        initial={{ scale: 1.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className={spotsColor}
                      >
                        {spotsRemaining}
                      </motion.span> spots left!
                    </span>
                  </motion.div>
                </div>
              </div>

              {/* CTA Button */}
              <motion.div
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                className="shrink-0"
              >
                <Button 
                  onClick={onClaim}
                  className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold shadow-lg"
                >
                  <Zap className="h-4 w-4 mr-1" />
                  Claim Now
                </Button>
              </motion.div>
            </div>

            {/* Urgency indicator with live updates */}
            <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-border/50">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-500" />
                <span className="text-xs text-muted-foreground">
                  <motion.span 
                    key={claimedToday}
                    initial={{ color: '#22c55e' }}
                    animate={{ color: 'inherit' }}
                    className="font-bold text-amber-500"
                  >
                    {claimedToday.toLocaleString()}
                  </motion.span> people claimed today
                </span>
              </div>
              
              {justClaimed && (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1 text-xs text-success font-medium"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  Someone just claimed!
                </motion.div>
              )}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </AnimatePresence>
  );
}
import { ReferralLeaderboard } from '@/components/ReferralLeaderboard';

// Category visual configurations with icons and gradients
const categoryVisuals: Record<string, { icon: typeof Coins; gradient: string; bgPattern: string }> = {
  "💰 EARN & GROW MONEY": {
    icon: Coins,
    gradient: "from-amber-500 via-yellow-500 to-orange-500",
    bgPattern: "bg-gradient-to-br from-amber-500/10 via-yellow-500/5 to-orange-500/10"
  },
  "🏠 RENT SOLUTIONS": {
    icon: Home,
    gradient: "from-primary via-blue-500 to-indigo-500",
    bgPattern: "bg-gradient-to-br from-primary/10 via-blue-500/5 to-indigo-500/10"
  },
  "💳 FINANCIAL SERVICES": {
    icon: Wallet,
    gradient: "from-rose-500 via-pink-500 to-purple-500",
    bgPattern: "bg-gradient-to-br from-rose-500/10 via-pink-500/5 to-purple-500/10"
  },
  "🛒 MARKETPLACE & SHOPPING": {
    icon: ShoppingBag,
    gradient: "from-orange-500 via-red-500 to-pink-500",
    bgPattern: "bg-gradient-to-br from-orange-500/10 via-red-500/5 to-pink-500/10"
  },
  "🤝 COMMUNITY & SUPPORT": {
    icon: Users,
    gradient: "from-teal-500 via-cyan-500 to-blue-500",
    bgPattern: "bg-gradient-to-br from-teal-500/10 via-cyan-500/5 to-blue-500/10"
  },
  "📊 BUSINESS TOOLS": {
    icon: TrendingUp,
    gradient: "from-indigo-500 via-violet-500 to-purple-500",
    bgPattern: "bg-gradient-to-br from-indigo-500/10 via-violet-500/5 to-purple-500/10"
  },
  "✅ SECURITY & TRUST": {
    icon: Shield,
    gradient: "from-emerald-500 via-green-500 to-teal-500",
    bgPattern: "bg-gradient-to-br from-emerald-500/10 via-green-500/5 to-teal-500/10"
  }
};

// Comprehensive services for all users
const services = [
  {
    category: "💰 EARN & GROW MONEY",
    items: [
      {
        icon: Coins,
        title: "Referral Rewards - UGX 100 Per Friend",
        description: "No limits! Invite 10 friends = UGX 1,000. Invite 100 friends = UGX 10,000. The more you share, the more you earn!",
        color: "bg-success/10 text-success",
        highlight: true,
        tag: "INSTANT CASH"
      },
      {
        icon: Trophy,
        title: "Monthly Leaderboard Prizes - Up to UGX 3,000!",
        description: "Top 3 referrers every month win BONUS rewards: 1st = UGX 3,000, 2nd = UGX 2,000, 3rd = UGX 1,000. Could be YOU!",
        color: "bg-amber-500/10 text-amber-500",
        highlight: true,
        tag: "MONTHLY CONTEST"
      },
      {
        icon: TrendingUp,
        title: "Investment Returns - Earn 10-15%",
        description: "Be a Supporter! Fund verified rent requests and earn guaranteed returns. Your money works for you 24/7.",
        color: "bg-indigo-500/10 text-indigo-500",
        tag: "INVESTORS"
      },
      {
        icon: BadgeDollarSign,
        title: "Agent Commission - Build Your Business",
        description: "Earn commission on every deposit, withdrawal, loan, and sale in your area. No capital needed to start!",
        color: "bg-violet-500/10 text-violet-500",
        tag: "ENTREPRENEURS"
      }
    ]
  },
  {
    category: "🏠 RENT SOLUTIONS",
    items: [
      {
        icon: Home,
        title: "Rent Advance - Get Money TODAY",
        description: "Landlord breathing down your neck? Access up to 100% of your rent NOW and repay in small daily amounts.",
        color: "bg-primary/10 text-primary",
        tag: "TENANTS"
      },
      {
        icon: Percent,
        title: "Rent Discounts - Save Up to 70%",
        description: "Every purchase you make with Welile receipts earns 1% back as rent credit. Shop smart, save BIG on rent!",
        color: "bg-emerald-500/10 text-emerald-500",
        tag: "EXCLUSIVE"
      },
      {
        icon: Receipt,
        title: "Receipt-Based Loan Limits",
        description: "Submit verified shopping receipts to unlock higher loan limits. Turn everyday spending into borrowing power!",
        color: "bg-blue-500/10 text-blue-500",
        tag: "GENIUS HACK"
      },
      {
        icon: Building2,
        title: "Landlord Direct Payments",
        description: "Never chase tenants again! Receive rent directly to your wallet. We handle collection - you enjoy peace of mind.",
        color: "bg-cyan-500/10 text-cyan-500",
        tag: "LANDLORDS"
      }
    ]
  },
  {
    category: "💳 FINANCIAL SERVICES",
    items: [
      {
        icon: Wallet,
        title: "Digital Wallet - Store & Manage Money",
        description: "Keep your money safe in your Welile wallet. Track all transactions, send and receive instantly.",
        color: "bg-rose-500/10 text-rose-500"
      },
      {
        icon: CreditCard,
        title: "Instant Loans - No Guarantors",
        description: "Emergency? Bills due? Access instant loans based on your history. No paperwork, approved in minutes!",
        color: "bg-pink-500/10 text-pink-500",
        tag: "FAST APPROVAL"
      },
      {
        icon: Smartphone,
        title: "Mobile Money Integration",
        description: "Deposit and withdraw using MTN Mobile Money, Airtel Money, or through local agents near you.",
        color: "bg-yellow-500/10 text-yellow-500"
      },
      {
        icon: Users,
        title: "Peer-to-Peer Transfers",
        description: "Send money to any Welile user instantly for FREE. No hidden fees, no delays.",
        color: "bg-sky-500/10 text-sky-500"
      }
    ]
  },
  {
    category: "🛒 MARKETPLACE & SHOPPING",
    items: [
      {
        icon: ShoppingBag,
        title: "Shop From Local Vendors",
        description: "Browse and buy products from verified local sellers. Pay with your wallet or on delivery.",
        color: "bg-orange-500/10 text-orange-500",
        tag: "BUYERS"
      },
      {
        icon: Star,
        title: "Flash Sales & Discounts",
        description: "Get exclusive deals and flash sales from top vendors. Save money on everyday items!",
        color: "bg-fuchsia-500/10 text-fuchsia-500"
      },
      {
        icon: BadgeDollarSign,
        title: "Sell Your Products - Zero Fees",
        description: "List your products on our marketplace. Reach thousands of buyers across East Africa!",
        color: "bg-lime-500/10 text-lime-500",
        tag: "VENDORS"
      },
      {
        icon: Gift,
        title: "Buy Now, Pay Later",
        description: "Purchase products and pay in installments. Flexible payment plans that fit your budget.",
        color: "bg-purple-500/10 text-purple-500",
        tag: "COMING SOON"
      }
    ]
  },
  {
    category: "🤝 COMMUNITY & SUPPORT",
    items: [
      {
        icon: Users,
        title: "Agent Network - Find Help Nearby",
        description: "Over 10,000 agents across Uganda ready to help with deposits, withdrawals, and support.",
        color: "bg-teal-500/10 text-teal-500"
      },
      {
        icon: Shield,
        title: "Verified User System",
        description: "All users are verified through LC1 chairpersons for maximum security and trust.",
        color: "bg-green-500/10 text-green-500"
      },
      {
        icon: MessageCircle,
        title: "24/7 Customer Support",
        description: "Need help? Our support team is available around the clock via WhatsApp and in-app chat.",
        color: "bg-blue-500/10 text-blue-500"
      },
      {
        icon: Target,
        title: "Financial Education",
        description: "Learn smart money management tips, budgeting strategies, and financial literacy resources.",
        color: "bg-amber-500/10 text-amber-500"
      }
    ]
  },
  {
    category: "📊 BUSINESS TOOLS",
    items: [
      {
        icon: TrendingUp,
        title: "Earnings Dashboard",
        description: "Track your referral earnings, commissions, and investment returns in real-time.",
        color: "bg-indigo-500/10 text-indigo-500"
      },
      {
        icon: Receipt,
        title: "Transaction History",
        description: "Complete record of all your transactions. Export reports for personal or business use.",
        color: "bg-slate-500/10 text-muted-foreground"
      },
      {
        icon: Clock,
        title: "Payment Schedules",
        description: "View and manage your repayment schedules. Get reminders before due dates.",
        color: "bg-orange-500/10 text-orange-500"
      },
      {
        icon: Sparkles,
        title: "Smart Notifications",
        description: "Stay updated with instant notifications for payments, approvals, and special offers.",
        color: "bg-pink-500/10 text-pink-500"
      }
    ]
  },
  {
    category: "✅ SECURITY & TRUST",
    items: [
      {
        icon: Shield,
        title: "Bank-Level Encryption",
        description: "Your data and money are protected by advanced encryption. We never share your information.",
        color: "bg-green-500/10 text-green-500"
      },
      {
        icon: Clock,
        title: "24/7 Access - Any Device",
        description: "Access your account anytime, anywhere. Works on smartphones, tablets, and computers.",
        color: "bg-teal-500/10 text-teal-500"
      },
      {
        icon: CheckCircle2,
        title: "Verified Transactions",
        description: "Every transaction is verified and recorded. Get instant receipts for all activities.",
        color: "bg-emerald-500/10 text-emerald-500"
      },
      {
        icon: Flame,
        title: "Fraud Protection",
        description: "Advanced systems detect and prevent fraudulent activities to keep your money safe.",
        color: "bg-red-500/10 text-red-500"
      }
    ]
  }
];

// Keep legacy name for backward compatibility
const opportunities = services;

export default function Benefits() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const { user } = useAuth();
  const [referralCount, setReferralCount] = useState(0);
  const [referralEarnings, setReferralEarnings] = useState(0);
  const [showLandlordDialog, setShowLandlordDialog] = useState(false);
  const [hasRegisteredLandlord, setHasRegisteredLandlord] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Filter services based on search query
  const filteredServices = useMemo(() => {
    if (!searchQuery.trim()) return services;
    
    const query = searchQuery.toLowerCase();
    return services
      .map(category => ({
        ...category,
        items: category.items.filter(item => 
          item.title.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          (item.tag && item.tag.toLowerCase().includes(query)) ||
          category.category.toLowerCase().includes(query)
        )
      }))
      .filter(category => category.items.length > 0);
  }, [searchQuery]);

  // Check if user has registered a landlord
  useEffect(() => {
    if (!user) return;
    
    const checkLandlord = async () => {
      const { data } = await supabase
        .from('landlords')
        .select('id')
        .eq('tenant_id', user.id)
        .limit(1);
      
      setHasRegisteredLandlord(data && data.length > 0);
    };
    
    checkLandlord();
  }, [user]);

  // Generate share URL with user's referral code if logged in
  const shareUrl = user 
    ? `${window.location.origin}/auth?ref=${user.id}`
    : `${window.location.origin}/auth`;

  const shareMessage = `🔥 STOP! This Changed My Life! 🔥

💰 I just discovered Welile - and I'm making money daily!

HERE'S WHAT YOU GET:
✅ UGX 100 CASH for every friend you invite (unlimited!)
✅ Up to 70% OFF your rent - yes, really!
✅ Get rent money TODAY, pay back slowly
✅ Win up to UGX 30,000 monthly prizes
✅ Instant loans - no guarantors needed
✅ Send/receive money FREE

40 MILLION people in East Africa are already using it!

👇 JOIN FREE NOW - Start earning TODAY:
${shareUrl}

Trust me, you'll thank me later! 🙏`;

  // Fetch referral stats with realtime updates
  // Referral DB calls stubbed for performance

  const handleWhatsAppShare = () => {
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareMessage)}`;
    window.open(whatsappUrl, '_blank');
    toast.success('Opening WhatsApp to share');
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Link copied to clipboard!');
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Welile - Make Money & Save on Rent!',
          text: shareMessage,
          url: shareUrl
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          handleWhatsAppShare();
        }
      }
    } else {
      handleWhatsAppShare();
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b border-border">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Your Opportunity Awaits</h1>
          <Button variant="ghost" size="icon" onClick={handleNativeShare}>
            <Share2 className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 pb-32 max-w-2xl">
        {/* Search Bar */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6"
        >
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search services, features, or keywords..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-10 h-12 text-base bg-muted/50 border-border/50 focus:bg-background"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                onClick={() => setSearchQuery('')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          {searchQuery && (
            <p className="text-sm text-muted-foreground mt-2">
              Found {filteredServices.reduce((acc, cat) => acc + cat.items.length, 0)} services in {filteredServices.length} categories
            </p>
          )}
        </motion.div>

        {/* Hero - More Compelling */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <motion.div 
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ repeat: Infinity, duration: 2 }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-600 dark:text-amber-400 text-sm font-bold mb-4"
          >
            <Flame className="h-4 w-4" />
            <span>40M+ Users Can't Be Wrong!</span>
            <Flame className="h-4 w-4" />
          </motion.div>
          <h2 className="text-2xl md:text-3xl font-bold mb-3">
            <span className="text-primary">Make Money.</span>{' '}
            <span className="text-emerald-500">Save on Rent.</span>{' '}
            <span className="text-amber-500">Live Better.</span>
          </h2>
          <p className="text-muted-foreground text-lg">
            Join the financial revolution sweeping East Africa 🌍
          </p>
        </motion.div>

        {/* Limited Time Offer Banner - Only for non-logged in users */}
        {!user && (
          <LimitedTimeOfferBanner onClaim={() => navigate('/auth')} />
        )}

        {/* Urgent CTA Banner */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
          className="mb-6"
        >
          <Card className="border-2 border-primary/50 bg-gradient-to-r from-primary/10 via-amber-500/10 to-success/10 overflow-hidden">
            <CardContent className="p-4 text-center">
              <div className="flex items-center justify-center gap-2 mb-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <span className="font-bold text-lg">🎁 JOIN FREE TODAY</span>
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground mb-3">
                No fees. No hidden charges. Start earning in 2 minutes!
              </p>
              <Button 
                size="lg" 
                className="w-full bg-gradient-to-r from-primary to-amber-500 hover:from-primary/90 hover:to-amber-500/90"
                onClick={() => navigate('/auth')}
              >
                <Zap className="h-4 w-4 mr-2" />
                Start Making Money NOW
              </Button>
            </CardContent>
          </Card>
        </motion.div>

        {/* Referral Stats - Only show for logged in users */}
        {user && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.2 }}
            className="mb-8"
          >
            <Card className="border-success/30 bg-gradient-to-r from-success/5 to-primary/5 overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg bg-success/10">
                    <Coins className="h-5 w-5 text-success" />
                  </div>
                  <div>
                    <h3 className="font-semibold">💰 Your Earnings Dashboard</h3>
                    <p className="text-xs text-muted-foreground">Keep inviting - no limits on how much you can earn!</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg bg-background/60 text-center">
                    <p className="text-2xl font-bold text-success">{referralCount}</p>
                    <p className="text-xs text-muted-foreground">Friends Earning With You</p>
                  </div>
                  <div className="p-3 rounded-lg bg-background/60 text-center">
                    <p className="text-2xl font-bold text-success">{formatUGX(referralEarnings)}</p>
                    <p className="text-xs text-muted-foreground">Cash Earned So Far</p>
                  </div>
                </div>
                {referralCount > 0 && (
                  <p className="text-center text-xs text-success mt-3 font-medium">
                    🔥 You're doing great! Invite {10 - referralCount > 0 ? 10 - referralCount : 'more'} friends to earn {formatUGX((10 - referralCount) * 100)}+ more!
                  </p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Rent Discount Registration CTA - For logged in users who haven't registered */}
        {user && !hasRegisteredLandlord && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.25 }}
            className="mb-8"
          >
            <Card className="border-2 border-emerald-500/50 bg-gradient-to-r from-emerald-500/10 via-teal-500/10 to-green-500/10 overflow-hidden relative">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent animate-[shimmer_2s_infinite]" />
              <CardContent className="p-4 relative">
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <motion.div
                    animate={{ scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] }}
                    transition={{ repeat: Infinity, duration: 3 }}
                    className="shrink-0"
                  >
                    <div className="p-4 rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg">
                      <Home className="h-8 w-8 text-white" />
                    </div>
                  </motion.div>
                  
                  <div className="flex-1 text-center sm:text-left">
                    <Badge className="bg-emerald-500 text-white mb-2">
                      🏠 UNLOCK 70% RENT DISCOUNT
                    </Badge>
                    <h3 className="font-bold text-lg mb-1">
                      Register Your Landlord to Start Saving!
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Submit your landlord's details and unlock massive rent discounts. Every receipt you collect earns you 1% back on rent!
                    </p>
                    <div className="flex items-center justify-center sm:justify-start gap-3 mt-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        Free to register
                      </span>
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        Takes 1 minute
                      </span>
                    </div>
                  </div>
                  
                  <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} className="shrink-0">
                    <Button 
                      onClick={() => setShowLandlordDialog(true)}
                      className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white font-bold"
                    >
                      <Percent className="h-4 w-4 mr-2" />
                      Register Now
                    </Button>
                  </motion.div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Already registered landlord badge */}
        {user && hasRegisteredLandlord && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.25 }}
            className="mb-6"
          >
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardContent className="p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Landlord Registered ✓</p>
                    <p className="text-xs text-muted-foreground">Upload receipts to earn rent discounts!</p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => navigate('/my-receipts')}>
                  Add Receipts
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Referral Leaderboard */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mb-8"
        >
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="h-5 w-5 text-amber-500" />
            <h3 className="font-bold text-lg">Top Earners This Month</h3>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            These people are earning REAL money. You could be next! 👇
          </p>
          <ReferralLeaderboard limit={10} />
        </motion.div>

        {/* Opportunities by Category - Enhanced with Visual Headers */}
        <Accordion type="single" collapsible defaultValue={filteredServices[0]?.category} className="space-y-4">
          {filteredServices.map((section, sectionIndex) => {
            const visual = categoryVisuals[section.category] || {
              icon: Star,
              gradient: "from-gray-500 to-gray-600",
              bgPattern: "bg-gradient-to-br from-gray-500/10 to-gray-600/10"
            };
            const CategoryIcon = visual.icon;
            
            // Calculate the starting number for this section
            const startingNumber = filteredServices
              .slice(0, sectionIndex)
              .reduce((acc, s) => acc + s.items.length, 0);
            
            return (
              <AccordionItem 
                key={section.category} 
                value={section.category}
                className="border-none"
              >
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3 + sectionIndex * 0.1 }}
                >
                  {/* Enhanced Category Header as Accordion Trigger */}
                  <AccordionTrigger className="hover:no-underline p-0 [&[data-state=open]>div]:ring-2 [&[data-state=open]>div]:ring-primary/30">
                    <div className={`relative overflow-hidden rounded-2xl ${visual.bgPattern} p-4 border border-border/30 w-full transition-all`}>
                      {/* Decorative background elements */}
                      <div className="absolute top-0 right-0 w-32 h-32 opacity-10">
                        <CategoryIcon className="w-full h-full" />
                      </div>
                      <motion.div 
                        className="absolute -bottom-4 -left-4 w-24 h-24 opacity-5"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                      >
                        <CategoryIcon className="w-full h-full" />
                      </motion.div>
                      
                      <div className="relative flex items-center gap-4">
                        {/* Animated Icon */}
                        <motion.div
                          whileHover={{ scale: 1.1, rotate: 5 }}
                          className={`p-3 rounded-xl bg-gradient-to-br ${visual.gradient} shadow-lg`}
                        >
                          <CategoryIcon className="h-6 w-6 text-white" />
                        </motion.div>
                        
                        <div className="text-left">
                          <h3 className="font-bold text-lg">
                            {section.category.replace(/^[^\s]+\s/, '')}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {section.items.length} services available
                          </p>
                        </div>
                        
                        {/* Floating decorative dots */}
                        <div className="ml-auto flex gap-1 mr-2">
                          {[...Array(3)].map((_, i) => (
                            <motion.div
                              key={i}
                              className={`w-2 h-2 rounded-full bg-gradient-to-br ${visual.gradient}`}
                              animate={{ y: [0, -4, 0] }}
                              transition={{ duration: 1.5, delay: i * 0.2, repeat: Infinity }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </AccordionTrigger>
                  
                  {/* Service Items Grid */}
                  <AccordionContent className="pt-4 pb-0">
                    <div className="grid gap-3">
                      {section.items.map((item, index) => {
                        const serviceNumber = startingNumber + index + 1;
                        return (
                          <motion.div
                            key={item.title}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: index * 0.05 }}
                          >
                            <Card 
                              className={`border-border/50 hover:border-primary/30 transition-all hover:shadow-lg hover:-translate-y-0.5 ${item.highlight ? 'ring-2 ring-success/30 bg-gradient-to-r from-success/5 to-amber-500/5' : ''}`}
                            >
                              <CardContent className="p-4 flex items-start gap-3">
                                {/* Service Number */}
                                <div className="flex items-center justify-center w-7 h-7 rounded-full bg-muted text-muted-foreground font-bold text-sm shrink-0">
                                  {serviceNumber}
                                </div>
                                <motion.div 
                                  className={`p-3 rounded-xl ${item.color} shrink-0`}
                                  whileHover={{ scale: 1.1 }}
                                >
                                  <item.icon className="h-5 w-5" />
                                </motion.div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap mb-1">
                                    <h4 className="font-semibold text-sm">{item.title}</h4>
                                    {item.tag && (
                                      <Badge 
                                        variant={item.highlight ? "success" : "secondary"} 
                                        className="text-[10px]"
                                      >
                                        {item.tag}
                                      </Badge>
                                    )}
                                  </div>
                                  <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
                                </div>
                                <CheckCircle2 className="h-5 w-5 text-primary shrink-0 mt-1" />
                              </CardContent>
                            </Card>
                          </motion.div>
                        );
                      })}
                    </div>
                  </AccordionContent>
                </motion.div>
              </AccordionItem>
            );
          })}
        </Accordion>

        {/* Social Proof Stats */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mb-8"
        >
          <h3 className="font-bold text-lg mb-4 text-center">📊 The Numbers Don't Lie</h3>
          <div className="grid grid-cols-2 gap-3">
            <Card className="text-center p-4 bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
              <p className="text-3xl font-bold text-primary">40M+</p>
              <p className="text-xs text-muted-foreground font-medium">Active Users</p>
            </Card>
            <Card className="text-center p-4 bg-gradient-to-br from-success/10 to-success/5 border-success/20">
              <p className="text-3xl font-bold text-success">5+</p>
              <p className="text-xs text-muted-foreground font-medium">Countries</p>
            </Card>
            <Card className="text-center p-4 bg-gradient-to-br from-amber-500/10 to-amber-500/5 border-amber-500/20">
              <p className="text-3xl font-bold text-amber-500">70%</p>
              <p className="text-xs text-muted-foreground font-medium">Max Rent Discount</p>
            </Card>
            <Card className="text-center p-4 bg-gradient-to-br from-violet-500/10 to-violet-500/5 border-violet-500/20">
              <p className="text-3xl font-bold text-violet-500">24/7</p>
              <p className="text-xs text-muted-foreground font-medium">Always Available</p>
            </Card>
          </div>
        </motion.div>

        {/* Testimonial */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7 }}
          className="mb-8"
        >
          <Card className="bg-muted/30 border-border/50">
            <CardContent className="p-4">
              <div className="flex items-center gap-1 mb-2">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-amber-400 text-amber-400" />
                ))}
              </div>
              <p className="text-sm italic mb-3">
                "I was struggling to pay rent every month. Now I invite friends, earn money, and even get discounts! Welile saved my life. If you're not using it, you're missing out!"
              </p>
              <p className="text-xs text-muted-foreground font-medium">
                — Sarah M., Kampala 🇺🇬
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Final CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8 }}
          className="text-center mb-6"
        >
          <Card className="border-2 border-dashed border-primary/50 bg-primary/5 p-6">
            <h3 className="font-bold text-xl mb-2">⏰ What Are You Waiting For?</h3>
            <p className="text-muted-foreground mb-4">
              Every minute you delay, someone else is earning. Join NOW and start making money TODAY!
            </p>
            <Button 
              size="lg" 
              className="w-full mb-3 bg-gradient-to-r from-success to-primary hover:from-success/90 hover:to-primary/90 text-white font-bold"
              onClick={() => navigate('/auth')}
            >
              <Gift className="h-5 w-5 mr-2" />
              YES! I Want to Start Earning FREE
            </Button>
            <p className="text-xs text-muted-foreground">
              ✓ 100% Free ✓ No Credit Card ✓ Takes 2 Minutes
            </p>
          </Card>
        </motion.div>
      </main>

      {/* Floating Share Button */}
      <motion.div
        initial={{ y: 100 }}
        animate={{ y: 0 }}
        className="fixed bottom-0 left-0 right-0 p-4 bg-background/95 backdrop-blur border-t border-border"
      >
        <div className="container mx-auto max-w-2xl">
          <p className="text-center text-xs text-muted-foreground mb-2 font-medium">
            👇 Share now & earn UGX 100 for every friend who joins!
          </p>
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              className="flex-1"
              onClick={handleCopyLink}
            >
              <Share2 className="h-4 w-4 mr-2" />
              Copy Link
            </Button>
            <Button 
              className="flex-1 bg-[#25D366] hover:bg-[#128C7E] text-white font-bold"
              onClick={handleWhatsAppShare}
            >
              <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
              Share & Earn UGX 100
            </Button>
          </div>
        </div>
      </motion.div>

      {/* Landlord Registration Dialog */}
      <RegisterLandlordDialog 
        open={showLandlordDialog} 
        onOpenChange={setShowLandlordDialog}
        onSuccess={() => setHasRegisteredLandlord(true)}
      />
    </div>
  );
}

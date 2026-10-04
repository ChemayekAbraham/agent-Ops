import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  Store, 
  ShoppingBag, 
  ArrowLeft, 
  TrendingUp, 
  Sparkles,
  CreditCard,
  ChevronRight
} from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import WelileLogo from '@/components/WelileLogo';

export default function ShopEntry() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-primary/5">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/95 backdrop-blur-xl">
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button 
                variant="ghost" 
                size="icon-sm" 
                onClick={() => navigate(-1)}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <WelileLogo />
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8 space-y-8">
        {/* Hero Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-4"
        >
          <div className="inline-flex p-4 rounded-2xl bg-primary/10 ring-2 ring-primary/20">
            <Store className="h-12 w-12 text-primary" />
          </div>
          <h1 className="text-3xl font-bold">Welile Shop</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            Buy, sell, and unlock shopping access up to <span className="text-primary font-semibold">UGX 30M</span>
          </p>
        </motion.div>

        {/* Loan Qualification Banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="border-2 border-success/30 bg-gradient-to-r from-success/10 via-primary/5 to-success/10 overflow-hidden">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-xl bg-success/20">
                  <TrendingUp className="h-6 w-6 text-success" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold">Shopping Credit Access</h3>
                    <Badge className="bg-success/20 text-success border-success/30 text-xs">
                      <Sparkles className="h-3 w-3 mr-1" />
                      Earn as you shop
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    The more you buy from Welile Shops, the higher your shopping access grows — from <span className="font-semibold text-foreground">UGX 30,000</span> up to <span className="font-semibold text-success">UGX 30,000,000</span>!
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Action Cards */}
        <div className="space-y-4">
          {/* Create Shop Option */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
          >
            <Card 
              className="border-2 border-primary/20 hover:border-primary/40 transition-all cursor-pointer active:scale-[0.98] overflow-hidden group"
              onClick={() => navigate('/my-products')}
            >
              <CardContent className="p-0">
                <div className="flex items-center">
                  <div className="p-6 bg-gradient-to-br from-primary/10 to-primary/5">
                    <div className="p-3 rounded-xl bg-primary/20 ring-2 ring-primary/30">
                      <Store className="h-8 w-8 text-primary" />
                    </div>
                  </div>
                  <div className="flex-1 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-xl font-bold mb-1">Create a Welile Shop</h2>
                        <p className="text-sm text-muted-foreground">
                          Sell your products and reach thousands of buyers
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge variant="outline" className="text-xs">
                            <CreditCard className="h-3 w-3 mr-1" />
                            Earn commissions
                          </Badge>
                          <Badge variant="outline" className="text-xs text-success border-success/30">
                            Free to start
                          </Badge>
                        </div>
                      </div>
                      <ChevronRight className="h-6 w-6 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Start Shopping Option */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3 }}
          >
            <Card 
              className="border-2 border-success/20 hover:border-success/40 transition-all cursor-pointer active:scale-[0.98] overflow-hidden group"
              onClick={() => navigate('/marketplace')}
            >
              <CardContent className="p-0">
                <div className="flex items-center">
                  <div className="p-6 bg-gradient-to-br from-success/10 to-success/5">
                    <div className="p-3 rounded-xl bg-success/20 ring-2 ring-success/30">
                      <ShoppingBag className="h-8 w-8 text-success" />
                    </div>
                  </div>
                  <div className="flex-1 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-xl font-bold mb-1">Start Shopping</h2>
                        <p className="text-sm text-muted-foreground">
                          Browse products and grow your shopping access
                        </p>
                        <div className="flex items-center gap-2 mt-2">
                          <Badge variant="outline" className="text-xs text-success border-success/30">
                            <TrendingUp className="h-3 w-3 mr-1" />
                            Build access
                          </Badge>
                          <Badge variant="outline" className="text-xs">
                            UGX 30K - 30M
                          </Badge>
                        </div>
                      </div>
                      <ChevronRight className="h-6 w-6 text-muted-foreground group-hover:text-success transition-colors" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* How it Works */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="space-y-4"
        >
          <h3 className="font-semibold text-center text-muted-foreground">How Shopping Access Works</h3>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 rounded-xl bg-muted/50">
              <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">1</div>
              <p className="text-xs text-muted-foreground">Shop on Welile</p>
            </div>
            <div className="p-3 rounded-xl bg-muted/50">
              <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">2</div>
              <p className="text-xs text-muted-foreground">Build your limit</p>
            </div>
            <div className="p-3 rounded-xl bg-muted/50">
              <div className="w-8 h-8 mx-auto mb-2 rounded-full bg-success/20 flex items-center justify-center text-success font-bold text-sm">3</div>
              <p className="text-xs text-muted-foreground">Unlock access</p>
            </div>
          </div>
        </motion.div>
      </main>
    </div>
  );
}

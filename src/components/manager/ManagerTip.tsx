import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Lightbulb, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const tips = [
  {
    title: "🔐 How to Reset a User's Password",
    description: "If a user forgets their password, tell them to go to the Sign In screen, tap \"Forgot Password?\", enter their phone number, and follow the OTP code sent via SMS to set a new password."
  },
  {
    title: "🔑 Manual Password Reset (Manager)",
    description: "If SMS reset fails, contact the Welile admin team to manually reset the password to 'Welile2024!' for the user. The user should change it after signing in."
  },
  {
    title: "📱 User Self-Service Reset Steps",
    description: "1) Open app → Sign In. 2) Tap 'Forgot Password?'. 3) Enter phone number. 4) Enter the 6-digit SMS code. 5) Set new password (min 6 characters). Done!"
  },
  {
    title: "Select Multiple Users",
    description: "Tap the checkbox on any user card to select them. Then use the action bar to notify or message them all at once!"
  },
  {
    title: "Quick WhatsApp",
    description: "Green WhatsApp button on each card opens a direct message. No need to save their number!"
  },
  {
    title: "Filter by Role",
    description: "Use the role pills at the top to quickly find all Tenants, Agents, or other user types."
  },
  {
    title: "Pull to Refresh",
    description: "Pull down the user list to refresh and see the latest users."
  },
  {
    title: "Tap User Card",
    description: "Tap anywhere on a user card to see their full details and manage their account."
  }
];

export function ManagerTip() {
  const [currentTip, setCurrentTip] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const wasDismissed = localStorage.getItem('manager-tips-dismissed');
    if (wasDismissed) {
      setDismissed(true);
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('manager-tips-dismissed', 'true');
  };

  const nextTip = () => {
    setCurrentTip((prev) => (prev + 1) % tips.length);
  };

  const prevTip = () => {
    setCurrentTip((prev) => (prev - 1 + tips.length) % tips.length);
  };

  if (dismissed) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
      >
        <Card className="border-2 border-warning/30 bg-gradient-to-br from-warning/10 via-background to-warning/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-warning/20 shrink-0">
                <Lightbulb className="h-5 w-5 text-warning" />
              </div>
              
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm text-warning">
                    💡 Tip {currentTip + 1}/{tips.length}
                  </h4>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 -mr-1 hover:bg-warning/10"
                    onClick={handleDismiss}
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
                
                <h5 className="font-semibold text-sm mt-1">{tips[currentTip].title}</h5>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {tips[currentTip].description}
                </p>
                
                <div className="flex items-center gap-2 mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={prevTip}
                    className="h-8 px-2 hover:bg-warning/10"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  
                  <div className="flex gap-1">
                    {tips.map((_, idx) => (
                      <div
                        key={idx}
                        className={`h-1.5 rounded-full transition-all ${
                          idx === currentTip ? 'w-4 bg-warning' : 'w-1.5 bg-muted'
                        }`}
                      />
                    ))}
                  </div>
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={nextTip}
                    className="h-8 px-2 hover:bg-warning/10"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDismiss}
                    className="ml-auto h-8 text-xs"
                  >
                    Got it!
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </AnimatePresence>
  );
}

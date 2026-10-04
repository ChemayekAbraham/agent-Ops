import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KeyRound, ChevronDown, ChevronUp, Smartphone, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export function PasswordResetGuide() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="border-2 border-primary/20 bg-gradient-to-br from-primary/5 via-background to-primary/10">
      <CardContent className="p-4">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-3 text-left touch-manipulation"
        >
          <div className="p-2.5 rounded-xl bg-primary/15 shrink-0">
            <KeyRound className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="font-bold text-sm">🔐 Password Reset Instructions</h4>
            <p className="text-xs text-muted-foreground">How to help users reset their password</p>
          </div>
          {expanded ? (
            <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
        </button>

        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="mt-4 space-y-3">
                {/* Method 1: Self-Service */}
                <div className="rounded-xl bg-card border p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-primary" />
                    <h5 className="font-semibold text-sm">Method 1: User Self-Service (SMS)</h5>
                  </div>
                  <p className="text-xs text-muted-foreground">Tell the user to follow these steps:</p>
                  <ol className="text-xs space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="font-bold text-primary shrink-0">1.</span>
                      <span>Open the app → Go to <strong>Sign In</strong> screen</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="font-bold text-primary shrink-0">2.</span>
                      <span>Tap <strong>"Forgot Password?"</strong></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="font-bold text-primary shrink-0">3.</span>
                      <span>Enter their <strong>phone number</strong></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="font-bold text-primary shrink-0">4.</span>
                      <span>Enter the <strong>6-digit OTP code</strong> sent via SMS</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="font-bold text-primary shrink-0">5.</span>
                      <span>Set a <strong>new password</strong> (minimum 6 characters)</span>
                    </li>
                  </ol>
                </div>

                {/* Method 2: Manual Reset */}
                <div className="rounded-xl bg-warning/5 border border-warning/20 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-warning" />
                    <h5 className="font-semibold text-sm">Method 2: Manual Reset (Admin)</h5>
                  </div>
                  <p className="text-xs text-muted-foreground">If SMS reset fails:</p>
                  <ul className="text-xs space-y-1.5 ml-1">
                    <li className="flex gap-2">
                      <span className="text-warning shrink-0">•</span>
                      <span>Contact the <strong>Welile admin team</strong> on WhatsApp</span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-warning shrink-0">•</span>
                      <span>Request a manual password reset to: <strong className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground">Welile2024!</strong></span>
                    </li>
                    <li className="flex gap-2">
                      <span className="text-warning shrink-0">•</span>
                      <span>Tell the user to <strong>change their password</strong> after signing in</span>
                    </li>
                  </ul>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

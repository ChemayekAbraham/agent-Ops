import { useState, useEffect } from 'react';
import { roleToSlug } from '@/lib/roleRoutes';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { Lock, KeyRound, ArrowLeft, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import WelileLogo from '@/components/WelileLogo';
import { z } from 'zod';

const passwordSchema = z.object({
  password: z.string().min(6, 'Password must be at least 6 characters'),
  confirmPassword: z.string().min(6, 'Please confirm your password'),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { 
    opacity: 1, 
    y: 0,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 }
  },
};

export default function UpdatePassword() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isValidSession, setIsValidSession] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    // Check if user has a valid recovery session
    const checkSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (session) {
        setIsValidSession(true);
      } else {
        toast({
          title: 'Invalid or Expired Link',
          description: 'Please request a new password reset link',
          variant: 'destructive'
        });
      }
      setCheckingSession(false);
    };

    checkSession();
  }, [toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const validation = passwordSchema.safeParse({ password, confirmPassword });
      if (!validation.success) {
        toast({
          title: 'Validation Error',
          description: validation.error.issues[0].message,
          variant: 'destructive'
        });
        setIsLoading(false);
        return;
      }

      const { error } = await supabase.auth.updateUser({ password });

      if (error) {
        toast({
          title: 'Update Failed',
          description: error.message,
          variant: 'destructive'
        });
      } else {
        // Fire-and-forget: the trigger-based IP capture used elsewhere can't
        // see this write (it goes through GoTrue directly, never PostgREST),
        // so this edge function call, from this same browser request, is
        // the only place the real IP is available.
        supabase.functions.invoke('record-password-change').catch(() => {});
        setIsSuccess(true);
        toast({
          title: 'Password Updated!',
          description: 'Your password has been successfully changed'
        });
        
        // Redirect to dashboard after 2 seconds
        setTimeout(() => {
          navigate('/dashboard/tenant');
        }, 2000);
      }
    } catch (err) {
      toast({
        title: 'Error',
        description: 'An unexpected error occurred',
        variant: 'destructive'
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted-foreground">Verifying your link...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background relative overflow-hidden flex items-center justify-center p-4">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.5 }}
          transition={{ duration: 1 }}
          className="absolute top-1/4 -left-20 w-72 h-72 bg-primary/20 rounded-full blur-3xl"
        />
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={{ duration: 1, delay: 0.3 }}
          className="absolute bottom-1/4 -right-20 w-96 h-96 bg-accent/20 rounded-full blur-3xl"
        />
      </div>

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-md relative z-10"
      >
        <motion.div variants={itemVariants}>
          <Link 
            to="/auth" 
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary mb-6 transition-colors group"
          >
            <motion.div
              whileHover={{ x: -4 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            >
              <ArrowLeft className="h-4 w-4" />
            </motion.div>
            <span>Back to Sign In</span>
          </Link>
        </motion.div>

        <motion.div variants={itemVariants} className="text-center mb-8">
          <motion.div 
            className="flex items-center justify-center mb-4"
            whileHover={{ scale: 1.05 }}
            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          >
            <WelileLogo linkToHome={false} />
          </motion.div>
          <p className="text-muted-foreground">Set Your New Password</p>
        </motion.div>

        <motion.div variants={itemVariants}>
          <Card className="glass-card border-border/50 shadow-elevated overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5 pointer-events-none" />
            
            <CardHeader className="relative">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              >
                <CardTitle className="flex items-center gap-2">
                  <motion.div
                    className="p-2 rounded-lg bg-primary/10"
                    whileHover={{ scale: 1.1, rotate: 5 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 17 }}
                  >
                    {isSuccess ? (
                      <CheckCircle className="h-5 w-5 text-success" />
                    ) : (
                      <KeyRound className="h-5 w-5 text-primary" />
                    )}
                  </motion.div>
                  {isSuccess ? 'Password Updated!' : 'Update Password'}
                </CardTitle>
                <CardDescription>
                  {isSuccess 
                    ? 'Redirecting you to your dashboard...'
                    : isValidSession 
                      ? 'Enter your new password below' 
                      : 'Your reset link has expired'}
                </CardDescription>
              </motion.div>
            </CardHeader>
            
            <CardContent className="relative">
              {isSuccess ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center py-6"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 20, delay: 0.2 }}
                    className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center mb-4"
                  >
                    <CheckCircle className="h-8 w-8 text-success" />
                  </motion.div>
                  <p className="text-muted-foreground text-center">
                    Your password has been successfully updated.
                  </p>
                </motion.div>
              ) : isValidSession ? (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <motion.div 
                    className="space-y-2"
                    layout
                    transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                  >
                    <Label htmlFor="password">New Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Enter new password"
                        className="pl-10 bg-background/50 border-border/50 focus:border-primary/50 transition-colors"
                        required
                      />
                    </div>
                  </motion.div>

                  <motion.div 
                    className="space-y-2"
                    layout
                    transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                  >
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        id="confirmPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Confirm new password"
                        className="pl-10 bg-background/50 border-border/50 focus:border-primary/50 transition-colors"
                        required
                      />
                    </div>
                  </motion.div>

                  <motion.div
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                  >
                    <Button 
                      type="submit" 
                      className="w-full gap-2 h-11 font-medium" 
                      disabled={isLoading}
                    >
                      {isLoading ? (
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                          className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full"
                        />
                      ) : (
                        <>
                          <KeyRound className="h-4 w-4" />
                          Update Password
                        </>
                      )}
                    </Button>
                  </motion.div>
                </form>
              ) : (
                <div className="text-center py-6">
                  <p className="text-muted-foreground mb-4">
                    This password reset link is invalid or has expired.
                  </p>
                  <Button 
                    onClick={() => navigate('/auth')}
                    variant="outline"
                  >
                    Request New Link
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        <motion.p 
          variants={itemVariants}
          className="text-center text-xs text-muted-foreground mt-6"
        >
          Make sure to use a strong password you can remember
        </motion.p>
      </motion.div>
    </div>
  );
}

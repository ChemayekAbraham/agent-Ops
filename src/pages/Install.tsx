import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { Share2, Download, Smartphone, Apple, Copy, Check, ArrowLeft, Square, ArrowDown, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { usePWAInstall } from '@/hooks/usePWAInstall';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';

export default function Install() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const { hasPrompt: isInstallable, isInstalled, promptInstall, isIOS } = usePWAInstall();
  const { user, loading, role } = useAuth();
  
  const appUrl = window.location.origin;
  const installUrl = `${appUrl}/install`;

  // Redirect based on auth status if app is installed
  useEffect(() => {
    if (isInstalled && !loading) {
      const timer = setTimeout(() => {
        if (user) {
          // User is logged in, go to dashboard
          navigate(roleToSlug(role), { replace: true });
        } else {
          // Not logged in, go to auth
          navigate('/auth', { replace: true });
        }
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [isInstalled, user, loading, navigate]);

  const handleInstallClick = async () => {
    if (isIOS) {
      toast('Use Safari → Share → Add to Home Screen');
      return;
    }

    if (isInstallable) {
      const installed = await promptInstall();
      if (installed) {
        if (user) {
          toast.success('App installed! Opening dashboard...');
          navigate(roleToSlug(role), { replace: true });
        } else {
          toast.success('App installed! Redirecting to login...');
          navigate('/auth', { replace: true });
        }
        return;
      }
    }

    toast('Open this page in your browser menu and tap Install app / Add to Home Screen');
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Install Welile.com',
          text: 'Get Welile.com - Africa\'s Rent Facilitation Platform. Install the app for quick access!',
          url: installUrl,
        });
      } catch (err) {
        // User cancelled or share failed
      }
    } else {
      handleCopyLink();
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(installUrl);
      setCopied(true);
      toast.success('Link copied to clipboard!');
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-primary/5 to-background">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b">
        <div className="container max-w-lg mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="font-semibold">Install Welile.com</h1>
        </div>
      </header>

      <main className="container max-w-lg mx-auto px-4 py-8 space-y-8">
        {/* Installed Success Message */}
        {isInstalled && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-green-500/10 border border-green-500/30 rounded-2xl p-6 text-center"
          >
            <div className="text-4xl mb-3">🎉</div>
            <h3 className="font-bold text-green-600 dark:text-green-400 text-lg">App Installed!</h3>
            <p className="text-sm text-muted-foreground mt-1">Redirecting to login...</p>
          </motion.div>
        )}

        {/* Hero Section */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center space-y-4"
        >
          <div className="w-24 h-24 mx-auto rounded-3xl overflow-hidden shadow-2xl ring-4 ring-primary/20">
            <img src="/welile-logo.png" alt="Welile" className="w-full h-full object-cover" />
          </div>
          <div>
            <h2 className="text-2xl font-bold" style={{ fontFamily: 'Chewy, cursive' }}>Welile.com</h2>
            <p className="text-muted-foreground">Africa's Rent Facilitation Platform</p>
          </div>
          
          {/* Direct Install Button for Android */}
          {isInstallable && !isInstalled && (
            <Button onClick={handleInstallClick} size="lg" className="gap-2 mt-4">
              <Download className="h-5 w-5" />
              Install App Now
            </Button>
          )}
        </motion.div>

        {/* QR Code Card */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="overflow-hidden">
            <CardContent className="p-6">
              <div className="text-center space-y-4">
                <p className="text-sm font-medium text-muted-foreground">Scan to install on any device</p>
                
                <div className="bg-card p-4 rounded-2xl inline-block shadow-inner">
                  <QRCodeSVG 
                    value={installUrl}
                    size={180}
                    level="H"
                    includeMargin={false}
                    imageSettings={{
                      src: "/welile-logo.png",
                      height: 40,
                      width: 40,
                      excavate: true,
                    }}
                  />
                </div>

                <div className="flex gap-2 justify-center">
                  <Button onClick={handleShare} className="gap-2">
                    <Share2 className="h-4 w-4" />
                    Share
                  </Button>
                  <Button variant="outline" onClick={handleCopyLink} className="gap-2">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Copied!' : 'Copy Link'}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Installation Instructions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Tabs defaultValue="iphone" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="iphone" className="gap-2">
                <Apple className="h-4 w-4" />
                iPhone
              </TabsTrigger>
              <TabsTrigger value="android" className="gap-2">
                <Smartphone className="h-4 w-4" />
                Android
              </TabsTrigger>
            </TabsList>

            <TabsContent value="iphone" className="mt-4 space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Apple className="h-5 w-5" />
                    Install on iPhone/iPad
                  </h3>
                  
                  <div className="space-y-4">
                    {/* Step 1 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        1
                      </div>
                      <div>
                        <p className="font-medium">Open in Safari</p>
                        <p className="text-sm text-muted-foreground">Make sure you're using Safari browser</p>
                      </div>
                    </div>

                    {/* Step 2 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        2
                      </div>
                      <div>
                        <p className="font-medium">Tap the Share button</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="p-1.5 bg-primary/10 rounded-md">
                            <Square className="h-4 w-4 text-primary" strokeWidth={1.5} />
                            <ArrowDown className="h-2 w-2 text-primary -mt-0.5 mx-auto" />
                          </div>
                          <span className="text-sm text-muted-foreground">at the bottom of Safari</span>
                        </div>
                      </div>
                    </div>

                    {/* Step 3 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        3
                      </div>
                      <div>
                        <p className="font-medium">Scroll and tap "Add to Home Screen"</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="p-1.5 bg-primary/10 rounded-md">
                            <Plus className="h-4 w-4 text-primary" />
                          </div>
                          <span className="text-sm text-muted-foreground">Add to Home Screen</span>
                        </div>
                      </div>
                    </div>

                    {/* Step 4 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        4
                      </div>
                      <div>
                        <p className="font-medium">Tap "Add" in the top right</p>
                        <p className="text-sm text-muted-foreground">Welile will appear on your home screen!</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="android" className="mt-4 space-y-4">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Smartphone className="h-5 w-5" />
                    Install on Android
                  </h3>
                  
                  <div className="space-y-4">
                    {/* Step 1 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        1
                      </div>
                      <div>
                        <p className="font-medium">Open in Chrome</p>
                        <p className="text-sm text-muted-foreground">Works best with Chrome browser</p>
                      </div>
                    </div>

                    {/* Step 2 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        2
                      </div>
                      <div>
                        <p className="font-medium">Tap the menu (⋮)</p>
                        <p className="text-sm text-muted-foreground">Three dots in the top right corner</p>
                      </div>
                    </div>

                    {/* Step 3 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        3
                      </div>
                      <div>
                        <p className="font-medium">Tap "Install app" or "Add to Home screen"</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div className="p-1.5 bg-primary/10 rounded-md">
                            <Download className="h-4 w-4 text-primary" />
                          </div>
                          <span className="text-sm text-muted-foreground">Install app</span>
                        </div>
                      </div>
                    </div>

                    {/* Step 4 */}
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">
                        4
                      </div>
                      <div>
                        <p className="font-medium">Confirm installation</p>
                        <p className="text-sm text-muted-foreground">Tap "Install" and you're done!</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </motion.div>

        {/* Benefits */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="p-4">
              <h3 className="font-semibold mb-3">Why install the app?</h3>
              <ul className="space-y-2 text-sm">
                <li className="flex items-center gap-2">
                  <span className="text-primary">✓</span>
                  <span>Quick access from your home screen</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-primary">✓</span>
                  <span>Works offline - no internet needed</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-primary">✓</span>
                  <span>Full-screen experience without browser bars</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-primary">✓</span>
                  <span>Faster loading times</span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="text-primary">✓</span>
                  <span>Get important notifications</span>
                </li>
              </ul>
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
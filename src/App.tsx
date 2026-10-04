import React, { Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { LanguageProvider } from "@/hooks/useLanguage";
import { CurrencyProvider } from "@/hooks/useCurrency";
import ScreenLoader from "@/components/common/ScreenLoader";

import AgentOpsStandalonePage from "@/pages/AgentOpsStandalonePage";
import Auth from "@/pages/Auth";
import AgentProductCategoryPage from "@/pages/AgentProductCategoryPage";
import TppoPortfolioPerformanceReport from "@/pages/tenant-ops/PortfolioPerformanceReport";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60 * 1000,
      gcTime: 10 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedAgentOpsRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <ScreenLoader />;
  }

  if (!user) {
    return <Navigate to="/auth" replace />;
  }

  return <>{children}</>;
}

export default function App() {
  return (
    <HelmetProvider>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            <LanguageProvider>
              <CurrencyProvider>
                <TooltipProvider>
                  <BrowserRouter>
                    <Suspense fallback={<ScreenLoader />}>
                      <Routes>
                        {/* Auth route */}
                        <Route path="/auth" element={<Auth />} />

                        {/* Main Agent Ops standalone dashboard */}
                        <Route
                          path="/"
                          element={
                            <ProtectedAgentOpsRoute>
                              <AgentOpsStandalonePage />
                            </ProtectedAgentOpsRoute>
                          }
                        />
                        <Route
                          path="/agent-ops"
                          element={
                            <ProtectedAgentOpsRoute>
                              <AgentOpsStandalonePage />
                            </ProtectedAgentOpsRoute>
                          }
                        />

                        {/* Sub-views and product detail categories */}
                        <Route
                          path="/agent-ops/products/:slug"
                          element={
                            <ProtectedAgentOpsRoute>
                              <AgentProductCategoryPage />
                            </ProtectedAgentOpsRoute>
                          }
                        />

                        {/* Reports */}
                        <Route
                          path="/agent-ops/reports/tenant-portfolio-performance"
                          element={
                            <ProtectedAgentOpsRoute>
                              <TppoPortfolioPerformanceReport />
                            </ProtectedAgentOpsRoute>
                          }
                        />

                        {/* Fallback to Agent Ops Home */}
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Routes>
                    </Suspense>
                  </BrowserRouter>
                  <Toaster />
                  <SonnerToaster />
                </TooltipProvider>
              </CurrencyProvider>
            </LanguageProvider>
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </HelmetProvider>
  );
}

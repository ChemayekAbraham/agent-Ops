import { useAuth } from "@/hooks/useAuth";
import { roleToSlug } from '@/lib/roleRoutes';
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ClipboardList } from "lucide-react";
import { AuditLogViewer } from "@/components/manager/AuditLogViewer";
import ScreenLoader from "@/components/common/ScreenLoader";

export default function AuditLog() {
  const { user, loading: authLoading, role } = useAuth();
  const navigate = useNavigate();

  const { data: isManager } = useQuery({
    queryKey: ["is-manager", user?.id],
    queryFn: async () => {
      if (!user?.id) return false;
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["manager", "super_admin", "coo", "ceo", "cto"] as any)
        .limit(1);
      return (data || []).length > 0;
    },
    enabled: !!user?.id,
  });

  if (authLoading) {
    return (
      <ScreenLoader />
    );
  }

  if (!user) {
    navigate("/auth");
    return null;
  }

  if (isManager === false) {
    navigate(roleToSlug(role));
    return null;
  }

  return (
    <div className="min-h-screen bg-background pb-20">
      <div className="sticky top-0 z-40 bg-background/95 backdrop-blur-lg border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="h-10 w-10">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold flex items-center gap-2">
              <ClipboardList className="h-5 w-5 text-primary" />
              Audit Log
            </h1>
            <p className="text-xs text-muted-foreground">Track all manager activities</p>
          </div>
        </div>
      </div>

      <div className="p-4">
        <AuditLogViewer />
      </div>
    </div>
  );
}

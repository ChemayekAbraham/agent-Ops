import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/UserAvatar';
import { AlertTriangle, Phone, Users, ChevronRight, X } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useEffect } from 'react';

interface DuplicatePhoneUsersSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  duplicateGroups: Map<string, string[]>;
  onUserClick?: (userId: string) => void;
}

interface UserProfile {
  id: string;
  full_name: string;
  phone: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
}

export function DuplicatePhoneUsersSheet({ 
  open, 
  onOpenChange, 
  duplicateGroups,
  onUserClick 
}: DuplicatePhoneUsersSheetProps) {
  const [userProfiles, setUserProfiles] = useState<Map<string, UserProfile>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open && duplicateGroups.size > 0) {
      fetchUserProfiles();
    }
  }, [open, duplicateGroups]);

  const fetchUserProfiles = async () => {
    setLoading(true);
    try {
      // Get all unique user IDs from duplicate groups
      const allUserIds: string[] = [];
      duplicateGroups.forEach((userIds) => {
        userIds.forEach(id => allUserIds.push(id));
      });

      if (allUserIds.length === 0) return;

      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, phone, email, avatar_url, created_at')
        .in('id', allUserIds);

      if (error) {
        console.error('Error fetching profiles:', error);
        return;
      }

      const profileMap = new Map<string, UserProfile>();
      profiles?.forEach(profile => {
        profileMap.set(profile.id, profile);
      });
      setUserProfiles(profileMap);
    } catch (err) {
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatPhone = (phone: string) => {
    // Format phone for display
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 9) {
      const last9 = digits.slice(-9);
      return `+256 ${last9.slice(0, 3)} ${last9.slice(3, 6)} ${last9.slice(6)}`;
    }
    return phone;
  };

  const totalDuplicateUsers = Array.from(duplicateGroups.values()).reduce(
    (sum, group) => sum + group.length, 
    0
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[95vh] rounded-t-3xl p-0">
        <div className="flex flex-col h-full">
          {/* Header */}
          <SheetHeader className="p-5 pb-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-destructive/15">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <SheetTitle className="text-lg">Duplicate Phone Numbers</SheetTitle>
                  <SheetDescription className="text-xs">
                    {totalDuplicateUsers} users in {duplicateGroups.size} groups
                  </SheetDescription>
                </div>
              </div>
              <Badge variant="destructive" className="text-xs">
                Action Needed
              </Badge>
            </div>
          </SheetHeader>

          {/* Content */}
          <ScrollArea className="flex-1 px-4 py-3">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : duplicateGroups.size === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground">No duplicate phone numbers found</p>
              </div>
            ) : (
              <div className="space-y-4">
                {Array.from(duplicateGroups.entries()).map(([normalizedPhone, userIds], groupIndex) => (
                  <Card 
                    key={normalizedPhone} 
                    className="border-destructive/30 bg-destructive/5 overflow-hidden"
                  >
                    <CardContent className="p-0">
                      {/* Group Header */}
                      <div className="px-4 py-3 bg-destructive/10 border-b border-destructive/20">
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-destructive" />
                          <span className="font-mono text-sm font-medium text-destructive">
                            ...{normalizedPhone}
                          </span>
                          <Badge variant="outline" className="ml-auto text-xs border-destructive/40 text-destructive">
                            {userIds.length} users
                          </Badge>
                        </div>
                      </div>

                      {/* Users List */}
                      <div className="divide-y divide-border/50">
                        {userIds.map((userId, userIndex) => {
                          const profile = userProfiles.get(userId);
                          if (!profile) return null;

                          return (
                            <div
                              key={userId}
                              className="flex items-center gap-3 p-4 hover:bg-muted/30 active:bg-muted/50 transition-colors cursor-pointer"
                              onClick={() => onUserClick?.(userId)}
                            >
                              <UserAvatar 
                                avatarUrl={profile.avatar_url} 
                                fullName={profile.full_name}
                                size="md"
                              />
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-sm truncate">
                                  {profile.full_name}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {formatPhone(profile.phone)}
                                </p>
                                <p className="text-xs text-muted-foreground/70 truncate">
                                  {profile.email}
                                </p>
                              </div>
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Footer */}
          <div className="p-4 border-t border-border/50 bg-background">
            <Button 
              variant="outline" 
              className="w-full"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

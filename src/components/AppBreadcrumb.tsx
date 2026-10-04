import { Link, useLocation } from 'react-router-dom';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import welileLogo from '@/assets/welile-logo.png';

interface BreadcrumbConfig {
  label: string;
  href?: string;
}

const routeLabels: Record<string, string> = {
  '/': 'Home',
  '/auth': 'Sign In',
  '/select-role': 'Select Role',
  '/dashboard/tenant': 'Dashboard',
  '/dashboard/agent': 'Dashboard',
  '/dashboard/landlord': 'Dashboard',
  '/dashboard/funder': 'Dashboard',
  '/dashboard/manager': 'Dashboard',
  '/manager-access': 'Manager Access',
};

export default function AppBreadcrumb() {
  const location = useLocation();
  const pathnames = location.pathname.split('/').filter((x) => x);

  const breadcrumbs: BreadcrumbConfig[] = [
    { label: 'Home', href: '/' },
  ];

  let currentPath = '';
  pathnames.forEach((segment) => {
    currentPath += `/${segment}`;
    const label = routeLabels[currentPath] || segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
    breadcrumbs.push({ label, href: currentPath });
  });

  // Don't show breadcrumb on home page
  if (location.pathname === '/') {
    return null;
  }

  return (
    <Breadcrumb className="mb-4">
      <BreadcrumbList>
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1;
          
          return (
            <BreadcrumbItem key={crumb.href || index}>
              {index === 0 ? (
                <BreadcrumbLink asChild>
                  <Link to="/" className="flex items-center gap-1">
                    <img src={welileLogo} alt="Welile" className="h-5 w-auto" />
                    <span className="sr-only md:not-sr-only">Home</span>
                  </Link>
                </BreadcrumbLink>
              ) : isLast ? (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={crumb.href!}>{crumb.label}</Link>
                </BreadcrumbLink>
              )}
              {!isLast && <BreadcrumbSeparator />}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

import type { ReactNode } from 'react';
import { AppSidebar } from './components/AppSidebar';
import { SiteHeader } from './components/SiteHeader';
import { ConsoleProvider } from './context/ConsoleContext';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar';
import { TooltipProvider } from './components/ui/tooltip';
import type { AuthState } from './lib/types';

export function ConsoleLayout({
  auth,
  onAuthRefresh,
  children,
}: {
  auth: AuthState;
  onAuthRefresh: (state: AuthState) => void;
  children: ReactNode;
}) {
  return (
    <ConsoleProvider auth={auth} onAuthRefresh={onAuthRefresh}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset id="main-content" tabIndex={-1} className="min-w-0 outline-none">
            <SiteHeader />
            <div className="min-w-0 flex-1">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </TooltipProvider>
    </ConsoleProvider>
  );
}

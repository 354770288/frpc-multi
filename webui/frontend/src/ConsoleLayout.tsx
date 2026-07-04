import type { ReactNode } from 'react';
import { Topbar } from './components/Topbar';
import { ConsoleProvider } from './context/ConsoleContext';
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
      <div className="flex min-h-screen flex-col">
        <Topbar />
        <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 outline-none">
          {children}
        </main>
      </div>
    </ConsoleProvider>
  );
}

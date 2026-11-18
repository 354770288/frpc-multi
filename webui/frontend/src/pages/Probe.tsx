import { DiscoveryPage } from './probe/DiscoveryPage';
import { ServersPage } from './probe/ServersPage';
import { TestsPage } from './probe/TestsPage';

export function Probe({ section = 'discover' }: { section?: 'discover' | 'servers' | 'test' }) {
  if (section === 'servers') return <ServersPage />;
  if (section === 'test') return <TestsPage />;
  return <DiscoveryPage />;
}

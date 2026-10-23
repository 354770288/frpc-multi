import { describe, expect, it } from 'vitest';
import { canEditFullConfigStructurally, canEditProxiesStructurally, emptyFrpcConfig, serializeFrpcConfig } from './proxyToml';

describe('TOML edit boundary', () => {
  it('allows the create form to edit its own generated config', () => {
    expect(canEditFullConfigStructurally(serializeFrpcConfig(emptyFrpcConfig()))).toBe(true);
  });
  it('keeps unsupported fields and proxy comments in raw mode', () => {
    const config=serializeFrpcConfig(emptyFrpcConfig()).replace('[log]', 'heartbeatInterval = 30\n\n[log]');
    expect(canEditFullConfigStructurally(config)).toBe(false);
    expect(canEditProxiesStructurally('[[proxies]]\nname = "demo"\n# keep this comment')).toBe(false);
    expect(canEditProxiesStructurally('[[proxies]]\nname = "demo"\nplugin = "http_proxy"')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  canEditFullConfigStructurally,
  canEditProxiesStructurally,
  emptyFrpcConfig,
  parseFrpcConfig,
  rewritePrefaceConnection,
  serializeFrpcConfig,
} from './proxyToml';

describe('TOML edit boundary', () => {
  it('allows the create form to edit its own generated config', () => {
    expect(canEditFullConfigStructurally(serializeFrpcConfig(emptyFrpcConfig()))).toBe(true);
  });

  it('keeps unsupported fields and proxy comments in raw mode', () => {
    const config = serializeFrpcConfig(emptyFrpcConfig()).replace('[log]', 'heartbeatInterval = 30\n\n[log]');
    expect(canEditFullConfigStructurally(config)).toBe(false);
    expect(canEditProxiesStructurally('[[proxies]]\nname = "demo"\n# keep this comment')).toBe(false);
    expect(canEditProxiesStructurally('[[proxies]]\nname = "demo"\nplugin = "http_proxy"')).toBe(false);
  });

  it('rewrites serverAddr, serverPort, and auth.token in preface while preserving [log] and [[proxies]]', () => {
    const original = [
      'serverAddr = "old.example.com"',
      'serverPort = 7000',
      '',
      '[log]',
      'to = "console"',
      'level = "info"',
      '',
      '[[proxies]]',
      'name = "ssh"',
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      'localPort = 22',
      'remotePort = 22022',
      '',
    ].join('\n');

    const updated = rewritePrefaceConnection(original, {
      serverAddr: 'hk1.zmfrp.eu.org',
      serverPort: '7000',
      authToken: 's3cr3t',
    });

    expect(updated).toContain('serverAddr = "hk1.zmfrp.eu.org"');
    expect(updated).toContain('token = "s3cr3t"');
    expect(updated).toContain('[log]\nto = "console"');
    expect(updated).toContain('remotePort = 22022');
    const parsed = parseFrpcConfig(updated);
    expect(parsed.serverAddr).toBe('hk1.zmfrp.eu.org');
    expect(parsed.authToken).toBe('s3cr3t');
    expect(parsed.proxies).toHaveLength(1);
    expect(canEditProxiesStructurally(updated)).toBe(true);
  });
});

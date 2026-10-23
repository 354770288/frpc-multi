import { describe, expect, it } from 'vitest';
import { probeEndpointHost } from './probeEndpoint';

describe('probe endpoint host',()=>{
  it('keeps bare IPv6 while splitting explicit ports',()=>{
    expect(probeEndpointHost('2001:db8::1')).toBe('2001:db8::1');
    expect(probeEndpointHost('[2001:db8::1]:7001')).toBe('2001:db8::1');
    expect(probeEndpointHost('[2001:db8::1]')).toBe('2001:db8::1');
    expect(probeEndpointHost('frps.example.com:7000')).toBe('frps.example.com');
    expect(probeEndpointHost('192.0.2.1')).toBe('192.0.2.1');
  });
});

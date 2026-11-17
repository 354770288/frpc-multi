import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestId } from './requestId';

afterEach(() => vi.unstubAllGlobals());

describe('createRequestId', () => {
  it('uses secure random bytes for RFC 4122 version 4 UUIDs when randomUUID is absent', () => {
    let seed = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index++) bytes[index] = (seed + index) & 0xff;
        seed++;
        return bytes;
      },
    });

    const first = createRequestId();
    const second = createRequestId();

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });

  it('uses the native randomUUID when available', () => {
    const randomUUID = vi.fn(() => 'native-uuid');
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() });

    expect(createRequestId()).toBe('native-uuid');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('fails clearly when no secure random source exists', () => {
    vi.stubGlobal('crypto', {});

    expect(() => createRequestId()).toThrow('Secure random number generation is unavailable');
  });
});

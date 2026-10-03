import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('configuration', () => {
  it('loads safe local defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.redisUrl).toBe('redis://localhost:6379');
  });

  it('rejects invalid numeric values and weak secrets', () => {
    expect(() => loadConfig({ PORT: 'zero' })).toThrow('PORT');
    expect(() => loadConfig({ KEY_HMAC_SECRET: 'short' })).toThrow('KEY_HMAC_SECRET');
  });
});

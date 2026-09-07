import { describe, it, expect } from 'vitest';
import { parsePlatformPort } from '../src/demo-runner.js';

describe('Demo Runner CLI Platform Port Parsing', () => {
  it('1) correctly passes through explicit safe port 3900 via CLI argument', () => {
    // Standard space-separated flag
    expect(parsePlatformPort(['up', '--port', '3900'])).toBe(3900);
    // Equals-separated flag
    expect(parsePlatformPort(['up', '--port=3900'])).toBe(3900);
    // Arbitrary position in args
    expect(parsePlatformPort(['up', '--json', '--port', '3900', '--allow-host'])).toBe(3900);
  });

  it('2) falls back to ENKEEP_PLATFORM_PORT environment variable when CLI flag is omitted, and prioritizes CLI over env', () => {
    // Env variable fallback
    expect(parsePlatformPort(['up'], { ENKEEP_PLATFORM_PORT: '3900' })).toBe(3900);
    expect(parsePlatformPort(['up', '--json'], { ENKEEP_PLATFORM_PORT: '4200' })).toBe(4200);

    // CLI flag takes precedence over env variable
    expect(
      parsePlatformPort(['up', '--port', '3900'], { ENKEEP_PLATFORM_PORT: '4200' })
    ).toBe(3900);
  });

  it('3) strictly rejects reserved ports 3000/3080, invalid non-integers, missing values, and out-of-range ports', () => {
    // Reserved / protected ports (3000 HappyClaw, 3080 DSH GUI)
    expect(() => parsePlatformPort(['up', '--port', '3000'])).toThrow(/Port 3000 is reserved\/protected/);
    expect(() => parsePlatformPort(['up', '--port', '3080'])).toThrow(/Port 3080 is reserved\/protected/);
    expect(() => parsePlatformPort(['up'], { ENKEEP_PLATFORM_PORT: '3000' })).toThrow(
      /Port 3000 is reserved\/protected/
    );
    expect(() => parsePlatformPort(['up'], { ENKEEP_PLATFORM_PORT: '3080' })).toThrow(
      /Port 3080 is reserved\/protected/
    );

    // Missing port value
    expect(() => parsePlatformPort(['up', '--port'])).toThrow(/--port requires a valid port number/);
    expect(() => parsePlatformPort(['up', '--port', '--json'])).toThrow(/--port requires a valid port number/);
    expect(() => parsePlatformPort(['up', '--port='])).toThrow(/--port requires a valid port number/);

    // Non-integer inputs
    expect(() => parsePlatformPort(['up', '--port', 'invalid'])).toThrow(/Must be an integer/);
    expect(() => parsePlatformPort(['up', '--port', '3900.5'])).toThrow(/Must be an integer/);
    expect(() => parsePlatformPort(['up'], { ENKEEP_PLATFORM_PORT: 'not-a-port' })).toThrow(
      /Must be an integer/
    );

    // Out of range (privileged <1024 except 0, >65535, negative)
    expect(() => parsePlatformPort(['up', '--port', '80'])).toThrow(/Invalid port 80/);
    expect(() => parsePlatformPort(['up', '--port', '99999'])).toThrow(/Invalid port 99999/);
    expect(() => parsePlatformPort(['up', '--port', '-1'])).toThrow(/--port requires a valid port number/);
  });

  it('defaults to 0 (dynamic loopback) when neither CLI flag nor env var is provided', () => {
    expect(parsePlatformPort(['up'])).toBe(0);
    expect(parsePlatformPort(['up'], {})).toBe(0);
    expect(parsePlatformPort(['up'], { ENKEEP_PLATFORM_PORT: '' })).toBe(0);
    expect(parsePlatformPort(['up', '--json', '--remove-vols'])).toBe(0);
  });
});

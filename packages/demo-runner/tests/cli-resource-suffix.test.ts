import { describe, it, expect } from 'vitest';
import { parseResourceSuffix } from '../src/demo-runner.js';

describe('Demo Runner CLI Resource Suffix Parsing', () => {
  it('1) correctly parses explicit resource suffix via CLI arguments (--resource-suffix)', () => {
    // Standard space-separated flag
    expect(parseResourceSuffix(['up', '--resource-suffix', 'stg'])).toBe('stg');
    // Equals-separated flag
    expect(parseResourceSuffix(['up', '--resource-suffix=stg'])).toBe('stg');
    // Arbitrary position in args
    expect(parseResourceSuffix(['up', '--json', '--resource-suffix', 'stg-01', '--port', '3900'])).toBe('stg-01');
    // Underscores and alphanumeric
    expect(parseResourceSuffix(['up', '--resource-suffix', 'test_env_123'])).toBe('test_env_123');
  });

  it('2) falls back to ENKEEP_RESOURCE_SUFFIX environment variable when CLI flag is omitted, and prioritizes CLI over env', () => {
    // Env variable fallback
    expect(parseResourceSuffix(['up'], { ENKEEP_RESOURCE_SUFFIX: 'stg' })).toBe('stg');
    expect(parseResourceSuffix(['up', '--json'], { ENKEEP_RESOURCE_SUFFIX: 'canary_v2' })).toBe('canary_v2');

    // CLI flag takes precedence over env variable
    expect(
      parseResourceSuffix(['up', '--resource-suffix', 'cli-stg'], { ENKEEP_RESOURCE_SUFFIX: 'env-stg' })
    ).toBe('cli-stg');
    expect(
      parseResourceSuffix(['up', '--resource-suffix=cli-stg'], { ENKEEP_RESOURCE_SUFFIX: 'env-stg' })
    ).toBe('cli-stg');
  });

  it('3) defaults to undefined when neither CLI flag nor env var is provided', () => {
    expect(parseResourceSuffix(['up'])).toBeUndefined();
    expect(parseResourceSuffix(['up'], {})).toBeUndefined();
    expect(parseResourceSuffix(['up'], { ENKEEP_RESOURCE_SUFFIX: '' })).toBeUndefined();
    expect(parseResourceSuffix(['up', '--json', '--port', '3900'])).toBeUndefined();
  });

  it('4) strictly rejects missing suffix value or empty suffix', () => {
    expect(() => parseResourceSuffix(['up', '--resource-suffix'])).toThrow(
      /--resource-suffix requires a valid suffix string/
    );
    expect(() => parseResourceSuffix(['up', '--resource-suffix', '--json'])).toThrow(
      /--resource-suffix requires a valid suffix string/
    );
    expect(() => parseResourceSuffix(['up', '--resource-suffix='])).toThrow(
      /--resource-suffix requires a valid suffix string/
    );
    expect(() => parseResourceSuffix(['up', '--resource-suffix', '   '])).toThrow(
      /--resource-suffix cannot be empty/
    );
  });

  it('5) strictly validates suffix format via validateResourceSuffix (regex ^[a-zA-Z0-9_-]{1,64}$)', () => {
    // Invalid characters: spaces, traversal, special characters
    expect(() => parseResourceSuffix(['up', '--resource-suffix', 'bad suffix'])).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up', '--resource-suffix', '../traversal'])).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up', '--resource-suffix', 'stg$bad'])).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up', '--resource-suffix', 'stg@prod'])).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up', '--resource-suffix', 'stg*'])).toThrow(/Safety Violation/);

    // Too long (> 64 characters)
    const tooLong = 'a'.repeat(65);
    expect(() => parseResourceSuffix(['up', '--resource-suffix', tooLong])).toThrow(/Safety Violation/);

    // Max length (64 characters) allowed
    const maxLen = 'a'.repeat(64);
    expect(parseResourceSuffix(['up', '--resource-suffix', maxLen])).toBe(maxLen);

    // Invalid env var validation
    expect(() => parseResourceSuffix(['up'], { ENKEEP_RESOURCE_SUFFIX: 'bad suffix' })).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up'], { ENKEEP_RESOURCE_SUFFIX: '../traversal' })).toThrow(/Safety Violation/);
    expect(() => parseResourceSuffix(['up'], { ENKEEP_RESOURCE_SUFFIX: 'stg$1' })).toThrow(/Safety Violation/);
  });
});

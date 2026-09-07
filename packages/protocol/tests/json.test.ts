import { describe, it, expect } from 'vitest';
import {
  strictJsonParse,
  strictJsonStringify,
  JsonLimitExceededError,
  JsonParseError,
} from '../src/index.js';

describe('Strict JSON parser and serializer', () => {
  describe('strictJsonParse', () => {
    it('parses valid JSON string and Buffer', () => {
      const obj = { str: 'hello', num: 42, arr: [1, 2, 3], nested: { ok: true } };
      const str = JSON.stringify(obj);

      const parsedStr = strictJsonParse<typeof obj>(str);
      expect(parsedStr).toEqual(obj);

      const parsedBuf = strictJsonParse<typeof obj>(Buffer.from(str));
      expect(parsedBuf).toEqual(obj);
    });

    it('enforces payload byte limit', () => {
      const payload = JSON.stringify({ data: 'x'.repeat(200) });
      expect(() =>
        strictJsonParse(payload, { maxPayloadBytes: 100 })
      ).toThrow(JsonLimitExceededError);

      expect(() =>
        strictJsonParse(Buffer.from(payload), { maxPayloadBytes: 100 })
      ).toThrow(JsonLimitExceededError);
    });

    it('enforces nesting depth limit', () => {
      let deep: any = { value: 1 };
      for (let i = 0; i < 20; i++) {
        deep = { child: deep };
      }
      const deepStr = JSON.stringify(deep);

      // Depth limit 5 should reject depth 20
      expect(() =>
        strictJsonParse(deepStr, { maxDepth: 5 })
      ).toThrow(JsonLimitExceededError);

      // Depth limit 30 should pass
      expect(() =>
        strictJsonParse(deepStr, { maxDepth: 30 })
      ).not.toThrow();
    });

    it('enforces maximum key count limit', () => {
      const manyKeys: Record<string, number> = {};
      for (let i = 0; i < 150; i++) {
        manyKeys[`key_${i}`] = i;
      }
      const payload = JSON.stringify(manyKeys);

      expect(() =>
        strictJsonParse(payload, { maxKeyCount: 50 })
      ).toThrow(JsonLimitExceededError);

      expect(() =>
        strictJsonParse(payload, { maxKeyCount: 200 })
      ).not.toThrow();
    });

    it('sanitizes prototype pollution keys by default', () => {
      const malicious = '{"normal":"ok","__proto__":{"polluted":true},"nested":{"constructor":"hack"}}';
      const parsed = strictJsonParse<any>(malicious, { sanitizeProtoKeys: true });

      expect(parsed.normal).toBe('ok');
      expect(parsed.__proto__).toBeUndefined();
      expect(parsed.nested.constructor).toBeUndefined();
      expect(({} as any).polluted).toBeUndefined();
    });

    it('throws error on prototype pollution keys when sanitizeProtoKeys is false', () => {
      const malicious = '{"normal":"ok","__proto__":{"polluted":true}}';
      expect(() =>
        strictJsonParse(malicious, { sanitizeProtoKeys: false })
      ).toThrow(JsonParseError);
    });

    it('throws JsonParseError on invalid JSON syntax or bad input', () => {
      expect(() => strictJsonParse('{ invalid json')).toThrow(JsonParseError);
      expect(() => strictJsonParse(123 as any)).toThrow(JsonParseError);
    });
  });

  describe('strictJsonStringify', () => {
    it('serializes valid objects', () => {
      const obj = { a: 1, b: ['two', 'three'] };
      const str = strictJsonStringify(obj);
      expect(JSON.parse(str)).toEqual(obj);
    });

    it('detects and rejects circular references', () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      expect(() => strictJsonStringify(circular)).toThrow(JsonParseError);
    });

    it('enforces serialization depth limit', () => {
      let deep: any = { value: 1 };
      for (let i = 0; i < 10; i++) {
        deep = { child: deep };
      }

      expect(() => strictJsonStringify(deep, { maxDepth: 4 })).toThrow(
        JsonLimitExceededError
      );
      expect(() => strictJsonStringify(deep, { maxDepth: 20 })).not.toThrow();
    });

    it('enforces serialization payload size limit', () => {
      const bigObj = { big: 'y'.repeat(500) };
      expect(() =>
        strictJsonStringify(bigObj, { maxPayloadBytes: 200 })
      ).toThrow(JsonLimitExceededError);
    });
  });
});

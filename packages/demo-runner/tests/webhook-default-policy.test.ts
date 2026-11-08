import { describe, it, expect, afterEach } from 'vitest';
import { validateWebhookUrl, resolveWebhookPolicyFlags, WebhookSecurityError } from '@enkeep/platform-server';
import { defaultWebhookSecurityOptions } from '../src/up/index.js';

async function rejectionCode(url: string, options: ReturnType<typeof defaultWebhookSecurityOptions>): Promise<string | null> {
  try {
    await validateWebhookUrl(url, options);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookSecurityError);
    return (err as WebhookSecurityError).code;
  }
}

describe('default webhook destination policy of upDemo', () => {
  const saved = process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
    else process.env.ALLOW_TEST_WEBHOOK_LOOPBACK = saved;
  });

  it('production (and unspecified) mode refuses loopback and requires https', () => {
    delete process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
    for (const mode of ['production', undefined] as const) {
      const opts = defaultWebhookSecurityOptions(mode);
      expect(opts).toEqual({ allowTestLoopback: false, enforceHttps: true });
      expect(resolveWebhookPolicyFlags(opts)).toEqual({ allowLoopback: false, enforceHttps: true });
    }
  });

  it('test mode keeps the loopback allowance for local fake receivers', () => {
    expect(defaultWebhookSecurityOptions('test')).toEqual({ allowTestLoopback: true, enforceHttps: false });
  });

  it('production defaults reject http, loopback and private destinations', async () => {
    delete process.env.ALLOW_TEST_WEBHOOK_LOOPBACK;
    const prod = defaultWebhookSecurityOptions('production');
    expect(await rejectionCode('http://127.0.0.1:8080/hook', prod)).toBe('INSECURE_PROTOCOL');
    expect(await rejectionCode('https://127.0.0.1:8443/hook', prod)).toBe('LOOPBACK_BLOCKED');
    expect(await rejectionCode('https://localhost/hook', prod)).toBe('LOOPBACK_BLOCKED');
    expect(await rejectionCode('https://10.0.0.5/hook', prod)).toBe('PRIVATE_IP_BLOCKED');
    expect(await rejectionCode('https://192.168.1.10/hook', prod)).toBe('PRIVATE_IP_BLOCKED');
    expect(await rejectionCode('https://100.64.0.10/hook', prod)).toBe('PRIVATE_IP_BLOCKED');
    expect(await rejectionCode('http://10.0.0.5/hook', prod)).toBe('INSECURE_PROTOCOL');
    // A public IP literal over https passes (no DNS lookup needed).
    expect(await rejectionCode('https://203.0.114.10/hook', prod)).toBeNull();
  });

  it('test defaults still accept a loopback receiver', async () => {
    expect(await rejectionCode('http://127.0.0.1:8080/hook', defaultWebhookSecurityOptions('test'))).toBeNull();
  });
});

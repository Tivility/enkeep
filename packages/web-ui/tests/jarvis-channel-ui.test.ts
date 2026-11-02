/**
 * Jarvis in the Web UI (synthetic, static checks): the session source label and the admin
 * channel card that creates a Jarvis account, shows its token once and rotates or deletes it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en, zhCN } from '../src/static/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');

describe('Jarvis channel in the Web UI', () => {
  it('labels Jarvis sessions', () => {
    const fnSource = appJsCode.match(/function getSessionSourceBadgeInfo\([\s\S]*?\n\}/);
    expect(fnSource).not.toBeNull();
    const badgeOf = new Function('state', 'session', 'tr', `${fnSource![0]}\nreturn getSessionSourceBadgeInfo(session);`).bind(null, { spaces: [] });
    const trZh = (k: string, _p: unknown, fb: string) => (zhCN as Record<string, string>)[k] || fb;
    const trEn = (k: string, _p: unknown, fb: string) => (en as Record<string, string>)[k] || fb;
    expect(badgeOf({ channel: 'jarvis' }, trZh)).toEqual({ type: 'jarvis', label: 'Jarvis', ariaLabel: '来源：Jarvis' });
    expect(badgeOf({ channel: 'Jarvis' }, trEn)).toEqual({ type: 'jarvis', label: 'Jarvis', ariaLabel: 'Source: Jarvis' });
    expect(appJsCode).toContain("'chat.channelJarvis': 'Jarvis'");
  });

  it('renders the daemons.json example with placeholders only', () => {
    const fnSource = appJsCode.match(/function jarvisDaemonsJsonExample\(\) \{[\s\S]*?\n\}/);
    expect(fnSource).not.toBeNull();
    const example = (port: string) =>
      new Function('window', `${fnSource![0]}\nreturn jarvisDaemonsJsonExample();`)({ location: { port } }) as string;
    expect(JSON.parse(example(''))).toEqual({
      daemons: [{ id: 'enkeep', name: 'Enkeep', agent: 'dsh', launcher: 'enkeep', url: 'ws://127.0.0.1:<port>/api/jarvis/runtime', token_file: '<token-file>' }],
    });
    expect(JSON.parse(example('4321')).daemons[0].url).toBe('ws://127.0.0.1:4321/api/jarvis/runtime');
  });

  it('creates, rotates and deletes through the channel account API (admins)', () => {
    expect(appJsCode).toContain('function renderJarvisChannelCard(account, isAdminUser)');
    expect(appJsCode).toMatch(/apiRequest\("\/api\/manage\/channels\/accounts", \{ method: "POST", body: \{ type: "jarvis" \} \}\)/);
    expect(appJsCode).toContain('"/token", { method: "POST"');
    expect(appJsCode).toContain('accounts = accounts.filter((a) => a.type !== "jarvis");');
  });
});

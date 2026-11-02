/**
 * Jarvis in the Web UI (synthetic, static checks): the session source label and the admin
 * channel card that creates a Jarvis account, shows its token once and rotates or deletes it, and
 * shows the account's connection status with a refresh button.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { en, zhCN } from '../src/static/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
const styleCss = readFileSync(join(__dirname, '../src/static/style.css'), 'utf-8');

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

  it('tells the user that jarvisd picks up daemons.json by itself (no restart)', () => {
    const fnSource = appJsCode.match(/function renderJarvisTokenPanel\(token\) \{[\s\S]*?\n\}/);
    expect(fnSource).not.toBeNull();
    expect(fnSource![0]).toContain('大约 10 秒内会自动读到并连上，不需要重启');
    expect(fnSource![0]).not.toContain('然后重启 jarvisd');
  });

  it('summarizes the connection status from account.jarvis', () => {
    const fnSource = appJsCode.match(/function jarvisStatusSummary\(status, fmt\) \{[\s\S]*?\n\}/);
    expect(fnSource).not.toBeNull();
    const summary = new Function('status', 'fmt', `${fnSource![0]}\nreturn jarvisStatusSummary(status, fmt);`) as (
      status: unknown,
      fmt: (v: string) => string
    ) => { connected: boolean; text: string; details: string[] };
    const fmt = (v: string) => `<${v}>`;
    expect(
      summary(
        {
          connected: true,
          connectedAt: '2026-01-02T03:04:05.000Z',
          lastConnectedAt: '2026-01-02T03:04:05.000Z',
          lastUsedAt: '2026-01-02T03:04:05.000Z',
          tokenCreatedAt: '2026-01-01T00:00:00.000Z',
        },
        fmt
      )
    ).toEqual({
      connected: true,
      text: '已连接（自 <2026-01-02T03:04:05.000Z>）',
      details: ['最近使用：<2026-01-02T03:04:05.000Z>', 'token 创建于：<2026-01-01T00:00:00.000Z>'],
    });
    expect(summary({ connected: false, lastDisconnectedAt: '2026-01-03T00:00:00.000Z' }, fmt)).toEqual({ connected: false, text: '未连接', details: [] });
    expect(summary({ connected: false, tokenCreatedAt: '2026-01-01T00:00:00.000Z' }, fmt).details).toEqual(['token 创建于：<2026-01-01T00:00:00.000Z>']);
    expect(summary(undefined, fmt)).toEqual({ connected: false, text: '未连接', details: [] });
  });

  it('shows the status line with a dot and a refresh button that reloads the Jarvis account (no timers)', () => {
    const card = appJsCode.match(/function renderJarvisChannelCard\(account, isAdminUser\) \{[\s\S]*?\n\}/);
    expect(card).not.toBeNull();
    const body = card![0];
    expect(body).toContain('renderJarvisStatusLine(account.jarvis)');
    expect(body).toContain('apiRequest("/api/manage/channels/accounts?type=jarvis")');
    expect(body).toContain('refreshBtn.textContent = "刷新";');
    expect(body).not.toMatch(/setInterval|setTimeout/);
    const line = appJsCode.match(/function renderJarvisStatusLine\(status\) \{[\s\S]*?\n\}/);
    expect(line).not.toBeNull();
    expect(line![0]).toContain('formatDate(value)');
    expect(line![0]).toContain('"jarvis-status-dot" + (summary.connected ? " is-connected" : "")');
    expect(styleCss).toMatch(/\.jarvis-status-dot \{[^}]*background: var\(--text-muted\)/);
    expect(styleCss).toMatch(/\.jarvis-status-dot\.is-connected \{[^}]*background: var\(--success\)/);
  });

  it('creates, rotates and deletes through the channel account API (admins)', () => {
    expect(appJsCode).toContain('function renderJarvisChannelCard(account, isAdminUser)');
    expect(appJsCode).toMatch(/apiRequest\("\/api\/manage\/channels\/accounts", \{ method: "POST", body: \{ type: "jarvis" \} \}\)/);
    expect(appJsCode).toContain('"/token", { method: "POST"');
    expect(appJsCode).toContain('accounts = accounts.filter((a) => a.type !== "jarvis");');
  });
});

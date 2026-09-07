import { chromium } from '../node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/index.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';

const secrets = JSON.parse(fs.readFileSync('.demo-data/secrets.json', 'utf8'));
const db = new DatabaseSync('.demo-data/platform.db');
const alice = db.prepare("SELECT * FROM users WHERE username='alice'").get();
const sessionId = 'inspect_ses_' + randomBytes(8).toString('hex');
const rawToken = randomBytes(32).toString('hex');
const tokenHash = createHash('sha256').update(rawToken).digest('hex');
const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
const expiresAtIso = new Date(expiresAt).toISOString();

db.prepare("INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").run(sessionId, alice.id, tokenHash, expiresAtIso);

const rawPayload = `${sessionId}.${rawToken}.${expiresAt}`;
const encodedPayload = Buffer.from(rawPayload, 'utf8').toString('base64url');
const signature = createHmac('sha256', secrets.cookieSecret).update(encodedPayload).digest('base64url');
const signedCookie = `${encodedPayload}.${signature}`;

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  await context.addCookies([
    {
      name: 'enkeep_session',
      value: signedCookie,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);

  const page = await context.newPage();

  const consoleLogs = [];
  page.on('console', (msg) => {
    consoleLogs.push({ type: msg.type(), text: msg.text() });
  });

  const networkRequests = [];
  page.on('requestfailed', (req) => {
    networkRequests.push({ url: req.url(), failure: req.failure()?.errorText });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      networkRequests.push({ url: res.url(), status: res.status(), statusText: res.statusText() });
    }
  });

  console.log('Navigating to http://127.0.0.1:64874 ...');
  await page.goto('http://127.0.0.1:64874', { waitUntil: 'networkidle' });

  // Wait a bit for any initial polling / data loading
  await page.waitForTimeout(3000);

  // Take screenshot to /tmp/enkeep-stall-main.png
  await page.screenshot({ path: '/tmp/enkeep-stall-main.png', fullPage: true });
  console.log('Screenshot saved to /tmp/enkeep-stall-main.png');

  // Inspect page state
  const state = await page.evaluate(() => {
    const btnSend = document.querySelector('#btn-send-message');
    const composer = document.querySelector('#chat-input');
    const statusBanner = document.querySelector('#chat-status-banner');
    const liveIndicator = document.querySelector('#live-sync-indicator');
    const turnControls = document.querySelector('#turn-active-controls');
    const activeTurnBanner = document.querySelector('#active-turn-banner');
    const msgElements = Array.from(document.querySelectorAll('.chat-bubble, .message-card, .chat-message-row')).map(el => ({
      text: el.textContent?.trim().slice(0, 100),
      className: el.className,
    }));
    const toasts = Array.from(document.querySelectorAll('.toast, .notification, .alert')).map(el => el.textContent);
    const win = window;
    const appState = win.state ? {
      activeSessionId: win.state.activeSessionId,
      activeSpaceId: win.state.activeSpaceId,
      isSending: win.state.isSending,
      polling: win.state.polling,
      turnStatus: win.state.turnStatus,
      isTurnActive: win.state.isTurnActive,
      pendingAttachments: win.state.pendingAttachments?.length,
      currentTurn: win.state.currentTurn,
      activeTurnId: win.state.activeTurnId,
      sessionGeneration: win.state.sessionGeneration,
      eventsCursor: win.state.eventsCursor,
      lastEventId: win.state.lastEventId,
    } : 'no window.state';

    return {
      btnSendDisabled: btnSend ? (btnSend).disabled : 'not found',
      btnSendText: btnSend?.textContent?.trim(),
      composerDisabled: composer ? (composer).disabled : 'not found',
      composerValue: composer ? (composer).value : 'not found',
      composerPlaceholder: composer?.placeholder,
      statusBannerText: statusBanner?.textContent?.trim(),
      liveIndicatorText: liveIndicator?.textContent?.trim(),
      activeTurnBannerText: activeTurnBanner?.textContent?.trim(),
      turnControlsVisible: turnControls ? !turnControls.classList.contains('hidden') : 'not found',
      messagesCount: msgElements.length,
      messages: msgElements,
      toasts,
      appState,
    };
  });

  console.log('Page state:', JSON.stringify(state, null, 2));
  console.log('Console logs:', JSON.stringify(consoleLogs, null, 2));
  console.log('Network errors:', JSON.stringify(networkRequests, null, 2));

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

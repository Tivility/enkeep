/**
 * End-to-end acceptance of the Jarvis channel (docs/jarvis-channel.md) against a real Docker runtime and a real
 * `jarvisd node`. Gated: runs only when JARVISD names a jarvisd binary (it is not part of this repository) and Docker
 * is available; the runtime image comes from ENKEEP_RUNTIME_IMAGE (default: the acceptance image).
 *
 *   JARVISD=<jarvisd binary> ENKEEP_RUNTIME_IMAGE=<image> \
 *     pnpm --filter @enkeep/demo-runner exec vitest run tests/jarvis-node-docker-e2e.test.ts
 *
 * The test plays the Jarvis hub on the node's stdio (one JSON object per line: requests {id, method, params},
 * responses {id, result | error}, events {event, params}); the node dials the platform's /api/jarvis/runtime from a
 * daemons.json in a temporary HOME. Everything lives in temporary directories and suffixed Docker resources; the
 * deterministic demo model answers (no model provider is called).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { getDemoPathConfig } from '../src/config.js';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

const JARVISD = process.env.JARVISD ?? '';
const RUNTIME_IMAGE = process.env.ENKEEP_RUNTIME_IMAGE ?? 'enkeep-demo-runtime:acceptance';
const DAEMON_ID = 'enkeep';

// A 1x1 PNG.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function loginUser(serverUrl: string, user: { username: string; password: string }) {
  const initCsrf = await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Origin: serverUrl } });
  const loginCsrf = ((await initCsrf.json()) as any).data.csrfToken;
  const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': loginCsrf, Origin: serverUrl },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0];
  const authCsrf = await fetch(`${serverUrl}/api/auth/csrf`, { headers: { Cookie: cookie, Origin: serverUrl } });
  const csrfToken = ((await authCsrf.json()) as any).data.csrfToken;
  return { cookie, csrfToken };
}

async function until<T>(what: string, ok: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ok();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface HubEvent { event: string; params: any }

/** A `jarvisd node --stdio` in an isolated HOME, with this test as its hub. */
class FakeHub {
  readonly events: HubEvent[] = [];
  readonly asked: any[] = [];
  readonly log: string[] = [];
  resolve: (ix: any) => any = () => ({ dismiss: true });
  private next = 0;
  private buffer = '';
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.dispatch(line);
      }
    });
    child.stderr.on('data', (d) => this.log.push(String(d)));
  }

  private write(m: unknown) {
    this.child.stdin.write(JSON.stringify(m) + '\n');
  }

  private dispatch(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m.method === 'string' && m.id !== undefined) {
      void (async () => {
        try {
          let result: any = {};
          if (m.method === 'state.load') result = { sessions: {} };
          else if (m.method === 'mcp.tools') result = { tools: [] };
          else if (m.method === 'interaction.create') {
            this.asked.push(m.params.interaction);
            result = await this.resolve(m.params.interaction);
          }
          this.write({ id: m.id, result });
        } catch (err: any) {
          this.write({ id: m.id, error: { message: String(err?.message ?? err) } });
        }
      })();
    } else if (typeof m.event === 'string') {
      this.events.push({ event: m.event, params: m.params });
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      else p.resolve(m.result);
    }
  }

  call(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    const id = `h${++this.next}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.write({ id, method, params });
    });
  }

  items(sid: string): any[] {
    return this.events.filter((e) => e.event === 'session.items' && e.params.session_id === sid).flatMap((e) => e.params.items ?? []);
  }

  batches(sid: string): any[] {
    return this.events.filter((e) => e.event === 'session.items' && e.params.session_id === sid).map((e) => e.params);
  }

  deltas(sid: string): string[] {
    return this.events.filter((e) => e.event === 'session.delta' && e.params.session_id === sid).map((e) => e.params.text);
  }

  stop() {
    try {
      this.child.kill('SIGTERM');
    } catch {}
  }
}

describe.skipIf(!JARVISD)('Jarvis channel with a real jarvisd node (Docker)', () => {
  let tempRepo: TempRepo | null = null;
  let suffix = '';
  let system: RunningDemoSystem | null = null;
  let hub: FakeHub | null = null;
  let jarvisHome = '';

  afterEach(async () => {
    hub?.stop();
    hub = null;
    if (system) {
      try {
        await system.close({ removeVolumes: true });
      } catch {}
      system = null;
    }
    if (tempRepo && suffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: suffix });
      if (fs.existsSync(paths.demoDataDir)) {
        try {
          await downDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix: suffix, removeVolumes: true });
        } catch {}
      }
      tempRepo.cleanup();
      tempRepo = null;
    }
    if (jarvisHome) fs.rmSync(jarvisHome, { recursive: true, force: true });
    delete process.env.ENKEEP_USER_QUESTIONS;
  });

  it('lists, streams, sends, interrupts, answers approvals and questions, and stays in its corner', async () => {
    try {
      await journey();
    } catch (err) {
      if (hub) {
        const sid = hub.events.find((e) => e.event === 'session.items')?.params.session_id;
        console.log('--- items ---\n' + JSON.stringify(sid ? hub.items(sid).map((i) => ({ seq: i.seq, role: i.role, kind: i.kind, tool: i.tool_name, err: i.is_error, text: String(i.text ?? '').slice(0, 160) })) : [], null, 1));
        console.log('--- asked ---\n' + JSON.stringify(hub.asked.map((x) => ({ kind: x.kind, tool: x.tool_name })), null, 1));
        console.log('--- node log ---\n' + hub.log.join('').slice(-3000));
      }
      throw err;
    }
  }, 900_000);

  async function journey() {
    // Questions are composed per user once a runtime is created for a user with a Jarvis account; for this run every
    // runtime gets the tool through the process-wide switch.
    process.env.ENKEEP_USER_QUESTIONS = '1';
    suffix = randomUUID().replace(/-/g, '').slice(0, 12);
    tempRepo = createTempRepo({ prefix: 'enkeep-jarvis-e2e-' });
    const reset = await resetDemo({ repoRoot: tempRepo.repoRoot, resourceSuffix: suffix, forceClean: true });
    expect(reset.ok).toBe(true);
    system = await launchDemoSystem({ repoRoot: tempRepo.repoRoot, resourceSuffix: suffix, runtimeImage: RUNTIME_IMAGE, timeoutMs: 60_000 });
    expect(system.result.ok).toBe(true);
    const url = system.result.platform.url!;
    const port = new URL(url).port;
    const admin = await loginUser(url, reset.credentials.admin);
    const user = await loginUser(url, reset.credentials.user);
    const post = (auth: { cookie: string; csrfToken: string }, p: string, body: unknown) =>
      fetch(`${url}${p}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': auth.csrfToken, Origin: url, Cookie: auth.cookie },
        body: JSON.stringify(body),
      });

    // ---- the account: admins only, one per user, the token once ----
    expect((await post(user, '/api/manage/channels/accounts', { type: 'jarvis' })).status).toBe(403);
    const created = await post(admin, '/api/manage/channels/accounts', { type: 'jarvis' });
    expect(created.status).toBe(201);
    const account = ((await created.json()) as any).data;
    expect(account.token).toMatch(/^ejv_/);
    expect((await post(admin, '/api/manage/channels/accounts', { type: 'jarvis' })).status).toBe(409);

    // ---- the node, dialing the platform from daemons.json ----
    jarvisHome = fs.mkdtempSync(path.join(os.tmpdir().length < 40 ? os.tmpdir() : '/tmp', 'jvh-'));
    fs.mkdirSync(path.join(jarvisHome, '.jarvis'), { recursive: true });
    const tokenFile = path.join(jarvisHome, 'token');
    fs.writeFileSync(tokenFile, account.token, { mode: 0o600 });
    fs.writeFileSync(path.join(jarvisHome, '.jarvis', 'daemons.json'), JSON.stringify({ daemons: [{
      id: DAEMON_ID, name: 'Enkeep', agent: 'dsh', launcher: 'enkeep',
      url: `ws://127.0.0.1:${port}/api/jarvis/runtime`, token_file: tokenFile,
    }] }), { mode: 0o600 });
    const child = spawn(JARVISD, ['node', '--stdio'], { env: { PATH: '/usr/bin:/bin', HOME: jarvisHome }, stdio: ['pipe', 'pipe', 'pipe'] });
    hub = new FakeHub(child);
    await hub.call('node.info', {}, 40_000);
    const h = hub;

    const launchers = await until('the enkeep launcher', async () => {
      const l = (await h.call('launchers.list')).launchers ?? [];
      return l.some((x: any) => x.name === 'enkeep') ? l : undefined;
    }, 60_000);
    expect(launchers.find((x: any) => x.name === 'enkeep').source).toBe(DAEMON_ID);

    // ---- a session started from the phone in the admin's space ----
    const spaces = ((await (await fetch(`${url}/api/spaces`, { headers: { Cookie: admin.cookie } })).json()) as any).data;
    const space = spaces[0];
    const cwd = `/home/dsh/spaces/${space.folder}`;
    const { session } = await h.call('session.start', { launcher: 'enkeep', cwd });
    const sid: string = session.session_id;
    expect(sid.startsWith(`${DAEMON_ID}.ses_`)).toBe(true);
    const row = await until('listed', async () => ((await h.call('sessions.list')).sessions ?? []).find((s: any) => s.session_id === sid));
    expect(row.source_kind).toBe('runtime');
    expect(row.agent).toBe('dsh');
    expect(row.capabilities?.send).toBe(true);
    expect(row.capabilities?.terminal).toBe(false);

    // ---- a text turn: the prompt and the reply come back as items, live text as deltas ----
    await h.call('session.watch', { session_id: sid, since_seq: 0 });
    const hello = 'hello from the phone';
    await h.call('session.send', { session_id: sid, text: hello, client_msg_id: 'm-1' });
    await h.call('session.send', { session_id: sid, text: hello, client_msg_id: 'm-1' }); // an app retry
    await until('the reply', () => h.items(sid).some((i) => i.role === 'assistant' && i.kind === 'text'), 120_000);
    expect(h.items(sid).filter((i) => i.role === 'user' && i.kind === 'text' && i.text === hello).length).toBe(1);
    expect(h.deltas(sid).some((t) => t.length > 0)).toBe(true);
    const page = await h.call('session.items', { session_id: sid, turns: 2 });
    expect(page.items.some((i: any) => i.kind === 'text' && i.role === 'assistant')).toBe(true);
    expect(page.history).toMatch(/^dsh:/);
    const b = h.batches(sid);
    expect(b.slice(1).filter((x, i) => x.from_seq !== b[i].to_seq)).toEqual([]);

    // ---- done or idle (issue #96): where the latest turn came from decides whether Jarvis treats it as unseen ----
    const routeId = sid.slice(`${DAEMON_ID}.`.length);
    const rowStatus = async () => ((await h.call('sessions.list')).sessions ?? []).find((s: any) => s.session_id === sid)?.status;
    // The turn sent from the phone above: unseen until opened in the app.
    await until('a Jarvis-started turn listed as done', async () => (await rowStatus()) === 'done', 60_000);

    // A turn sent from the Web UI: the user was at the computer, so it counts as seen.
    const webSend = await fetch(`${url}/api/sessions/${routeId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Enkeep-CSRF': admin.csrfToken, 'Idempotency-Key': randomUUID(), Origin: url, Cookie: admin.cookie },
      body: JSON.stringify({ content: 'sent from the web page' }),
    });
    expect(webSend.ok).toBe(true);
    await until('the web turn reply', () => h.items(sid).some((i) => i.role === 'assistant' && /sent from the web page/.test(i.text ?? '')), 120_000);
    await until('a Web UI turn listed as idle', async () => (await rowStatus()) === 'idle', 60_000);

    // Back on the phone: done again.
    await h.call('session.send', { session_id: sid, text: 'back on the phone', client_msg_id: 'm-seen-1' });
    await until('the phone turn reply', () => h.items(sid).some((i) => i.role === 'assistant' && /back on the phone/.test(i.text ?? '')), 120_000);
    await until('a Jarvis-started turn listed as done again', async () => (await rowStatus()) === 'done', 60_000);

    // A turn that came from a Lark chat (a synthetic, disabled Lark account: nothing is ever sent to Lark; the inbox
    // has no event for it, so the Lark manager has nothing to deliver).
    const adminId = (system.database.prepare('SELECT id FROM users WHERE username = ?').get(reset.credentials.admin.username) as { id: string }).id;
    const lark = await system.storage.forTenant(adminId).channels.createAccount({ type: 'lark', status: 'disabled' });
    const nativeEventId = 'om_test0000000000000000000000000001';
    const chat = 'oc_test0000000000000000000000000001';
    const dispatched = await (system.platformServer.runtimeGateway as any).dispatchInbound({
      id: `idem_lark_${lark.id}_${nativeEventId}`,
      userId: adminId,
      sessionId: routeId,
      content: 'asked in a Lark chat',
      timestamp: new Date().toISOString(),
      channelContext: { channel: 'lark', accountId: lark.id, chatId: chat, nativeContextId: chat, nativeEventId, senderId: 'ou_test0000000000000000000000000001', chatType: 'p2p' },
    });
    expect(dispatched?.turnId).toBeTruthy();
    const larkOrigin = system.database.prepare('SELECT channel FROM channel_turn_origins WHERE turn_id = ?').get(dispatched.turnId) as { channel: string } | undefined;
    expect(larkOrigin?.channel).toBe('lark');
    await until('the Lark turn reply', () => h.items(sid).some((i) => i.role === 'assistant' && /asked in a Lark chat/.test(i.text ?? '')), 120_000);
    await until('a Lark-started turn listed as idle', async () => (await rowStatus()) === 'idle', 60_000);

    // ---- autonomous continuations (issue #96): the runtime's own turns after background work show as working,
    // and their result counts as unseen when the chain started in Jarvis. In a second session: the demo model starts
    // a background job on every turn it reads the marker in, so the chain goes on until the runtime is torn down;
    // every turn first runs a 3 s command, so a running continuation can be seen.
    const { session: second } = await h.call('session.start', { launcher: 'enkeep', cwd });
    const sid2: string = second.session_id;
    const route2 = sid2.slice(`${DAEMON_ID}.`.length);
    await h.call('session.send', { session_id: sid2, text: 'start background work [enkeep-test-tool-call=bash:{"command":"sleep 3","description":"e2e foreground"}] [enkeep-test-tool-call=bash:{"command":"sleep 1; echo jarvis-e2e-bg","description":"e2e background","run_in_background":true}]', client_msg_id: 'm-auto-1' });
    const latestTurnStatus = () => {
      const r = system!.database.prepare("SELECT payload FROM web_events WHERE session_id = ? AND type = 'turn_status' ORDER BY rowid DESC LIMIT 1").get(route2) as { payload: string } | undefined;
      return r ? (JSON.parse(r.payload) as { status: string; turnId?: string; originTurnId?: string }) : undefined;
    };
    const platformRunning = () => system!.database.prepare("SELECT COUNT(*) AS n FROM turn_runs WHERE route_id = ? AND status IN ('queued', 'running')").get(route2) as { n: number };
    const autonomousCompleted = () => (system!.database.prepare("SELECT COUNT(*) AS n FROM web_events WHERE session_id = ? AND type = 'turn_status' AND json_extract(payload, '$.status') = 'completed' AND json_extract(payload, '$.turnId') LIKE 'turn_auto_%'").get(route2) as { n: number }).n;
    let sawAutonomousWorking = false;
    let sawChainDone = false;
    const autoEnd = Date.now() + 120_000;
    while (Date.now() < autoEnd && !(sawAutonomousWorking && sawChainDone)) {
      const st = ((await h.call('sessions.list')).sessions ?? []).find((x: any) => x.session_id === sid2)?.status;
      const last = latestTurnStatus();
      const auto = last?.turnId?.startsWith('turn_auto_') === true;
      if (st === 'working' && auto && last?.status === 'running' && platformRunning().n === 0) sawAutonomousWorking = true;
      if (st === 'done' && auto && last?.status === 'completed' && autonomousCompleted() >= 2) sawChainDone = true;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!(sawAutonomousWorking && sawChainDone)) {
      console.log('AUTO turn_status', JSON.stringify(system!.database.prepare("SELECT payload, created_at FROM web_events WHERE session_id = ? AND type IN ('turn_status', 'turn_failed', 'turn_cancelled') ORDER BY rowid").all(route2)));
      console.log('AUTO turn_runs', JSON.stringify(system!.database.prepare('SELECT turn_id, status, error FROM turn_runs WHERE route_id = ?').all(route2)));
      console.log('AUTO all turn_runs', JSON.stringify(system!.database.prepare("SELECT route_id, turn_id, status, error, started_at, finished_at FROM turn_runs ORDER BY rowid DESC LIMIT 8").all()));
      console.log('AUTO items', JSON.stringify(h.items(sid2).map((i) => ({ seq: i.seq, role: i.role, kind: i.kind, text: String(i.text ?? '').slice(0, 120) }))));
    }
    expect(autonomousCompleted()).toBeGreaterThanOrEqual(2);
    expect(sawAutonomousWorking).toBe(true); // a continuation in flight: no turn record, still working
    expect(sawChainDone).toBe(true); // continuation of continuation of a Jarvis turn: unseen

    // ---- a slash command is refused, nothing is sent ----
    await expect(h.call('session.send', { session_id: sid, text: '/status', client_msg_id: 'm-2' })).rejects.toThrow();

    // ---- an image from the phone ----
    await h.call('session.send', { session_id: sid, text: 'look at this', images: [{ mime: 'image/png', data: PNG_1PX }], client_msg_id: 'm-3' });
    const img = await until('the image item', () => h.items(sid).find((i) => i.kind === 'image' && i.role === 'user'), 120_000);
    expect(img.image?.lazy).toBe(true);
    const bytes = await h.call('session.image', { session_id: sid, item_id: img.id });
    expect(bytes.mime).toBe('image/png');
    expect(bytes.data.length).toBeGreaterThan(0);

    // ---- an approval card: allowed on the phone, the tool runs ----
    // The default workspace-write policy asks before a potentially destructive shell command (here a harmless dd
    // inside the workspace).
    h.resolve = (ix) => (ix.kind === 'permission' ? { allow: true } : { dismiss: true });
    await h.call('session.send', { session_id: sid, text: 'run it [enkeep-test-tool-call=bash:{"command":"dd if=/dev/zero of=./jarvis-e2e.bin bs=1 count=1","description":"e2e"}]', client_msg_id: 'm-4' });
    const card = await until('the approval card', () => h.asked.find((x) => x.kind === 'permission'), 120_000);
    expect(card.session_id).toBe(sid);
    expect(card.agent_label).toBe('Enkeep');
    expect(card.tool_name).toBe('Bash');
    expect(card.tool_input?.command).toContain('dd if=/dev/zero');
    await until('the tool result', () => h.items(sid).some((i) => i.kind === 'tool_result' && i.is_error !== true), 120_000);

    // ---- a refusal with words: the words come back as the next message ----
    const asked = h.asked.length;
    // Refuse once with words (the demo model may retry the same call after reading them: allow that one).
    let refused = false;
    h.resolve = (ix) => {
      if (ix.kind !== 'permission') return { dismiss: true };
      if (refused) return { allow: true };
      refused = true;
      return { allow: false, message: 'not this one JARVIS_E2E_WHY' };
    };
    await h.call('session.send', { session_id: sid, text: 'again [enkeep-test-tool-call=bash:{"command":"dd if=/dev/zero of=./jarvis-e2e-2.bin bs=1 count=1","description":"e2e"}]', client_msg_id: 'm-5' });
    await until('the second card', () => h.asked.length > asked, 120_000);
    await until('the reason as a message', () => h.items(sid).some((i) => i.role === 'user' && /JARVIS_E2E_WHY/.test(i.text ?? '')), 120_000);
    expect(h.items(sid).some((i) => i.kind === 'tool_result' && i.is_error === true && /rejected/.test(i.text ?? ''))).toBe(true);

    // ---- a question card: answered on the phone, the model reads the answer ----
    h.resolve = (ix) => (ix.kind === 'question' ? { answers: { 'Which database?': 'sqlite' } } : { dismiss: true });
    await h.call('session.send', { session_id: sid, text: 'ask me [enkeep-test-tool-call=ask_user_question:{"questions":[{"id":"db","question":"Which database?","options":[{"label":"postgres"},{"label":"sqlite"}]}]}]', client_msg_id: 'm-6' });
    const q = await until('the question card', () => h.asked.find((x) => x.kind === 'question'), 120_000);
    expect(q.questions?.[0]?.options?.length).toBe(2);
    await until('the answer as a tool result', () => h.items(sid).some((i) => i.kind === 'tool_result' && /sqlite/.test(i.text ?? '')), 120_000);

    // ---- a slow reply: live text, then an interrupt from the phone ----
    await h.call('session.send', { session_id: sid, text: 'say something long [enkeep-test-delay-ms=10000]', client_msg_id: 'm-7' });
    await until('working', async () => ((await h.call('sessions.list')).sessions ?? []).find((s: any) => s.session_id === sid)?.status === 'working', 60_000);
    await h.call('session.interrupt', { session_id: sid });
    await until('the interrupt notice', () => h.items(sid).some((i) => i.kind === 'notice' && i.text === '已中断'), 120_000);

    // ---- rename, terminal calls refused, close ----
    await h.call('session.rename', { session_id: sid, title: 'renamed from the phone' });
    await until('renamed', async () => ((await h.call('sessions.list')).sessions ?? []).find((s: any) => s.session_id === sid)?.title === 'renamed from the phone');
    await expect(h.call('session.keys', { session_id: sid, keys: ['enter'] })).rejects.toThrow(/unsupported/);
    await h.call('session.close', { session_id: sid });
    await until('closed', async () => !((await h.call('sessions.list')).sessions ?? []).some((s: any) => s.session_id === sid));

    // ---- the other user's sessions never show up ----
    const all = (await h.call('sessions.list')).sessions ?? [];
    const userSpaces = ((await (await fetch(`${url}/api/spaces`, { headers: { Cookie: user.cookie } })).json()) as any).data;
    expect(all.some((s: any) => userSpaces.some((sp: any) => s.space_id?.includes(sp.id)))).toBe(false);

    if (process.env.JARVIS_E2E_VERBOSE === '1') {
      console.log(JSON.stringify(h.items(sid).map((i) => ({ seq: i.seq, role: i.role, kind: i.kind, tool: i.tool_name, err: i.is_error, text: String(i.text ?? '').slice(0, 120) })), null, 1));
      console.log(JSON.stringify(h.asked.map((x) => ({ kind: x.kind, tool: x.tool_name, input: x.tool_input, questions: x.questions?.length })), null, 1));
    }

    // ---- rotating the token drops the node's connection ----
    const rotated = await post(admin, `/api/manage/channels/accounts/${account.id}/token`, {});
    expect(rotated.status).toBe(200);
    await until('the launcher gone', async () => !(((await h.call('launchers.list')).launchers ?? []).some((x: any) => x.name === 'enkeep')), 60_000);
  }
});

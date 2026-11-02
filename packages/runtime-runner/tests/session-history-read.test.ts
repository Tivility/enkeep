/**
 * Read-only DSH session history ops: `readSessionEvents` / `readAttachment` on the daemon, the
 * host-side helpers (chunk reassembly, typed `turn/event` / `turn/chunk` subscriptions) and the
 * host-mode UDS transport wiring. Real DSH boot in a temp DSH_HOME with the deterministic demo
 * model; no network, no Docker. All ids, paths and contents are synthetic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import {
  DaemonRpcDecoder,
  DaemonRpcEncoder,
  DaemonProtocolError,
  READ_SESSION_EVENTS_MAX_LIMIT,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStreamEvent,
  type ReadSessionEventsResult,
} from '../src/runtime/daemon-protocol.js';
import { selectSessionEventsPage } from '../src/runtime/session-history.js';
import {
  readAttachmentVia,
  readSessionEventsVia,
  subscribeSessionEvents,
  subscribeTurnChunks,
  type DaemonRequestFn,
  type HostSessionEvent,
  type HostTurnChunk,
} from '../src/transport/session-history-client.js';
import { HostDaemonTransport } from '../src/host/transport.js';

// Minimal synthetic 1x1 JPEG; a comment segment makes each fixture's bytes (and sha256) unique.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);
function syntheticJpeg(seed: string): Buffer {
  const comment = Buffer.from(`SYNTHETIC-JPEG-${seed}`);
  const marker = Buffer.from([0xff, 0xfe, (comment.length + 2) >> 8, (comment.length + 2) & 0xff]);
  return Buffer.concat([JPEG_1X1.subarray(0, 2), marker, comment, JPEG_1X1.subarray(2)]);
}

function turnId(n: number): string {
  return `turn_${n.toString(16).padStart(32, '0')}`;
}

/** Forward requests straight to a daemon, rejecting on `ok: false` like the real transports. */
function directRequest(daemon: RuntimeDaemon, extra: Record<string, unknown> = {}): DaemonRequestFn {
  return async (req: DaemonRequest) => {
    const res = await daemon.handleRequest({ ...req, ...extra } as DaemonRequest);
    if (!res.ok) {
      throw new DaemonProtocolError((res as any).error.code, (res as any).error.message);
    }
    return res as DaemonResponse;
  };
}

async function readEvents(daemon: RuntimeDaemon, params: Record<string, unknown>): Promise<any> {
  return daemon.handleRequest({ id: `r_${Math.random()}`, op: 'readSessionEvents', ...params } as any);
}

async function readPersisted(daemon: RuntimeDaemon, sessionId: string): Promise<readonly SessionEvent[]> {
  const persistence = (daemon as any).bootedRuntime.context.sessionPersistence;
  const handle = await persistence.open(SessionId(sessionId), 'read');
  try {
    return (await handle.read()).events;
  } finally {
    await handle.close();
  }
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function eventBytes(event: SessionEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
}

function findImageAttachmentId(events: readonly SessionEvent[]): string | undefined {
  const text = JSON.stringify(events);
  const m = /"type":"image","attachment":\{"attachmentId":"(sha256:[0-9a-f]{64})"/.exec(text);
  if (m) return m[1];
  const any = /"attachmentId":"(sha256:[0-9a-f]{64})"/.exec(text);
  return any?.[1];
}

/** Every file under `root` (relative path → size, mtime, content hash) plus every directory. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(abs);
      } else if (entry.isFile()) {
        const st = fs.statSync(abs);
        const hash = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        out[rel] = `${st.size}:${st.mtimeMs}:${hash}`;
      } else {
        out[rel] = 'other';
      }
    }
  };
  walk(root);
  return out;
}

describe('readSessionEvents / readAttachment (real DSH boot, demo model)', () => {
  const SID = 'ses_00000000000000000000000000000a01';
  const SPACE = 'space-history';
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spacePath: string;
  let daemon: RuntimeDaemon;
  let photo: Buffer;
  let upload: Buffer;
  const streamed: DaemonStreamEvent[] = [];

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-history-test-'));
    dshHome = path.join(tmpDir, 'alice', '.dsh');
    spacesDir = path.join(tmpDir, 'alice', 'spaces');
    spacePath = path.join(spacesDir, SPACE);
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacePath, '.attachments', 'incoming'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacesDir, 'space-other'), { recursive: true, mode: 0o700 });

    photo = syntheticJpeg('photo');
    upload = syntheticJpeg('upload');
    fs.writeFileSync(path.join(spacePath, 'photo.jpg'), photo);
    fs.writeFileSync(path.join(spacePath, '.attachments', 'incoming', 'upload.jpg'), upload);
    fs.writeFileSync(path.join(spacePath, 'notes.txt'), 'synthetic plain text note\n');
    fs.writeFileSync(path.join(spacePath, 'uncited.jpg'), syntheticJpeg('uncited'));
    fs.writeFileSync(path.join(spacesDir, 'space-other', 'outside.jpg'), syntheticJpeg('outside'));

    daemon = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir });
    await daemon.start();
    daemon.on('stream', (ev: DaemonStreamEvent) => streamed.push(ev));

    for (let i = 1; i <= 4; i++) {
      const res = await daemon.submitTurnAndWait({
        id: `req-${i}`,
        op: 'submitTurn',
        turnId: turnId(i),
        sessionId: SID,
        prompt: `Synthetic history turn ${i}`,
        workspaceFolder: SPACE,
      });
      expect(res.status).toBe('completed');
    }

    const imageTurn = await daemon.submitTurnAndWait({
      id: 'req-5',
      op: 'submitTurn',
      turnId: turnId(5),
      sessionId: SID,
      prompt: '[enkeep-test-tool-call=read_image:{"file_path":"photo.jpg"}] Look at the photo.',
      workspaceFolder: SPACE,
    });
    expect(imageTurn.status).toBe('completed');

    const attachmentTurn = await daemon.submitTurnAndWait({
      id: 'req-6',
      op: 'submitTurn',
      turnId: turnId(6),
      sessionId: SID,
      prompt: 'Here are two files.',
      workspaceFolder: SPACE,
      attachments: [
        {
          id: 'att_00000000000000000000000000000001',
          relativePath: 'upload.jpg',
          snapshotPath: '.attachments/incoming/upload.jpg',
          etag: 'etag-synthetic-1',
          size: upload.byteLength,
          mediaType: 'image/jpeg',
          displayName: 'upload.jpg',
          downloadReference: 'ref-synthetic-1',
        },
        {
          id: 'att_00000000000000000000000000000002',
          relativePath: 'notes.txt',
          snapshotPath: 'notes.txt',
          etag: 'etag-synthetic-2',
          size: 26,
          mediaType: 'text/plain',
          displayName: 'notes.txt',
          downloadReference: 'ref-synthetic-2',
        },
      ],
    });
    expect(attachmentTurn.status).toBe('completed');
    // Let the JSONL write-behind window drain so the persisted log equals the live log.
    await new Promise((r) => setTimeout(r, 400));
  }, 120_000);

  afterAll(async () => {
    try {
      await daemon?.shutdown();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns the newest page with original DSH seqs, unmodified', async () => {
    const reference = await readPersisted(daemon, SID);
    expect(reference.length).toBeGreaterThan(20);

    const res = await readEvents(daemon, { sessionId: SID, limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.dshSessionId).toBe(SID);
    expect(res.events).toHaveLength(5);
    expect(res.events).toEqual(reference.slice(-5));
    expect(res.events.map((e: SessionEvent) => e.seq)).toEqual(reference.slice(-5).map((e) => e.seq));
    expect(res.lastSeq).toBe(reference[reference.length - 1]!.seq);
    expect(res.persistedLastSeq).toBe(res.lastSeq);
    expect(res.hasMore).toBe(true);
    expect(res.omitted).toBeUndefined();

    const whole = await readEvents(daemon, { sessionId: SID, limit: READ_SESSION_EVENTS_MAX_LIMIT * 5 });
    expect(whole.ok).toBe(true);
    expect(whole.events).toEqual(reference);
    expect(whole.events[0].seq).toBe(0);
    expect(whole.hasMore).toBe(false);
  });

  it('pages backwards with beforeSeq and forwards with afterSeq over the whole log', async () => {
    const reference = await readPersisted(daemon, SID);

    const backward: SessionEvent[] = [];
    let page = await readEvents(daemon, { sessionId: SID, limit: 7 });
    backward.unshift(...page.events);
    while (page.hasMore) {
      page = await readEvents(daemon, { sessionId: SID, beforeSeq: page.events[0].seq, limit: 7 });
      expect(page.ok).toBe(true);
      expect(page.events.length).toBeGreaterThan(0);
      backward.unshift(...page.events);
    }
    expect(backward).toEqual(reference);

    const forward: SessionEvent[] = [];
    let cursor = -1;
    for (;;) {
      const next = await readEvents(daemon, { sessionId: SID, afterSeq: cursor, limit: 6 });
      expect(next.ok).toBe(true);
      forward.push(...next.events);
      if (!next.hasMore) break;
      cursor = next.events[next.events.length - 1].seq;
    }
    expect(forward).toEqual(reference);

    const atEnd = await readEvents(daemon, { sessionId: SID, afterSeq: reference.length - 1 });
    expect(atEnd.events).toEqual([]);
    expect(atEnd.hasMore).toBe(false);
    expect(atEnd.lastSeq).toBe(reference.length - 1);

    const range = await readEvents(daemon, { sessionId: SID, afterSeq: 2, beforeSeq: 6 });
    expect(range.events.map((e: SessionEvent) => e.seq)).toEqual([3, 4, 5]);
    expect(range.hasMore).toBe(false);
    const rangeLimited = await readEvents(daemon, { sessionId: SID, afterSeq: 2, beforeSeq: 6, limit: 2 });
    expect(rangeLimited.events.map((e: SessionEvent) => e.seq)).toEqual([3, 4]);
    expect(rangeLimited.hasMore).toBe(true);

    const oldest = await readEvents(daemon, { sessionId: SID, beforeSeq: 3 });
    expect(oldest.events.map((e: SessionEvent) => e.seq)).toEqual([0, 1, 2]);
    expect(oldest.hasMore).toBe(false);
  });

  it('respects maxBytes by returning fewer events with hasMore', async () => {
    const reference = await readPersisted(daemon, SID);
    const budget = eventBytes(reference[0]!) + eventBytes(reference[1]!) + eventBytes(reference[2]!);

    const fwd = await readEvents(daemon, { sessionId: SID, afterSeq: -1, maxBytes: budget });
    expect(fwd.events.map((e: SessionEvent) => e.seq)).toEqual([0, 1, 2]);
    expect(fwd.hasMore).toBe(true);

    const fwdShort = await readEvents(daemon, { sessionId: SID, afterSeq: -1, maxBytes: budget - 1 });
    expect(fwdShort.events.map((e: SessionEvent) => e.seq)).toEqual([0, 1]);

    // A budget below one event still returns one event, so paging always progresses.
    const tiny = await readEvents(daemon, { sessionId: SID, maxBytes: 1 });
    expect(tiny.events).toEqual(reference.slice(-1));
    expect(tiny.hasMore).toBe(true);

    const n = reference.length;
    const tailBudget = eventBytes(reference[n - 1]!) + eventBytes(reference[n - 2]!);
    const newest = await readEvents(daemon, { sessionId: SID, maxBytes: tailBudget });
    expect(newest.events).toEqual(reference.slice(-2));
    expect(newest.hasMore).toBe(true);
  });

  it('reports session/not-found and rejects invalid parameters', async () => {
    const missing = await readEvents(daemon, { sessionId: 'ses_00000000000000000000000000000fff' });
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe('session/not-found');

    for (const bad of [
      { sessionId: '../escape' },
      { sessionId: SID, afterSeq: -2 },
      { sessionId: SID, beforeSeq: 1.5 },
      { sessionId: SID, limit: 0 },
      { sessionId: SID, maxBytes: 0 },
    ]) {
      const res = await readEvents(daemon, bad);
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe('INVALID_PARAMETERS');
    }

    await expect(
      readSessionEventsVia(directRequest(daemon), { sessionId: 'ses_00000000000000000000000000000ffe' })
    ).rejects.toMatchObject({ code: 'session/not-found' });
  });

  it('reads a DSH image attachment by id, whole and in chunks', async () => {
    const reference = await readPersisted(daemon, SID);
    const attachmentId = findImageAttachmentId(reference);
    expect(attachmentId).toBe(`sha256:${createHash('sha256').update(photo).digest('hex')}`);

    const whole = await readAttachmentVia(directRequest(daemon), { sessionId: SID, attachmentId });
    expect(whole.mime).toBe('image/jpeg');
    expect(whole.bytes).toBe(photo.byteLength);
    expect(Buffer.from(whole.data, 'base64').equals(photo)).toBe(true);
    expect(whole.width).toBe(1);
    expect(whole.height).toBe(1);
    expect(`sha256:${whole.sha256}`).toBe(attachmentId);

    // Force 16-byte chunks: the host helper reassembles and verifies them.
    let calls = 0;
    const chunked = await readAttachmentVia(
      async (req) => {
        calls++;
        return directRequest(daemon, { maxChunkBytes: 16 })(req);
      },
      { sessionId: SID, attachmentId }
    );
    expect(calls).toBe(Math.ceil(photo.byteLength / 16));
    expect(chunked.data).toBe(whole.data);

    const raw = await daemon.handleRequest({ id: 'a1', op: 'readAttachment', sessionId: SID, attachmentId, offset: 16, maxChunkBytes: 16 } as any);
    expect(raw.ok).toBe(true);
    expect((raw as any).offset).toBe(16);
    expect(Buffer.from((raw as any).data, 'base64').equals(photo.subarray(16, 32))).toBe(true);

    await expect(
      readAttachmentVia(directRequest(daemon), { sessionId: SID, attachmentId: `sha256:${'0'.repeat(64)}` })
    ).rejects.toMatchObject({ code: 'attachment/not-found' });
    await expect(
      readAttachmentVia(directRequest(daemon), { sessionId: 'ses_00000000000000000000000000000ffd', attachmentId })
    ).rejects.toMatchObject({ code: 'session/not-found' });
  });

  it('reads a workspace attachment by the path the session cites, inside its space only', async () => {
    const res = await readAttachmentVia(directRequest(daemon), { sessionId: SID, path: '.attachments/incoming/upload.jpg' });
    expect(res.mime).toBe('image/jpeg');
    expect(Buffer.from(res.data, 'base64').equals(upload)).toBe(true);
    expect(res.width).toBe(1);
    expect(res.height).toBe(1);

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ path: 'notes.txt' }, 'attachment/not-image'],
      [{ path: 'uncited.jpg' }, 'attachment/not-found'],
      [{ path: '../space-other/outside.jpg' }, 'attachment/not-found'],
      [{ path: path.join(spacesDir, 'space-other', 'outside.jpg') }, 'attachment/not-found'],
      [{ path: 'missing.jpg' }, 'attachment/not-found'],
      [{ path: 'photo.jpg', attachmentId: `sha256:${'1'.repeat(64)}` }, 'INVALID_PARAMETERS'],
      [{}, 'INVALID_PARAMETERS'],
      [{ attachmentId: 'not-an-id' }, 'INVALID_PARAMETERS'],
    ];
    for (const [params, code] of cases) {
      const r = await daemon.handleRequest({ id: 'p', op: 'readAttachment', sessionId: SID, ...params } as any);
      expect(r.ok, JSON.stringify(params)).toBe(false);
      expect((r as any).error.code, JSON.stringify(params)).toBe(code);
      // No filesystem path leaks into error messages.
      expect((r as any).error.message).not.toContain(tmpDir);
    }
  });

  it('pushed turn/event for every persisted event of the session (submitted turns)', async () => {
    const reference = await readPersisted(daemon, SID);
    const pushed = streamed.filter((e): e is Extract<DaemonStreamEvent, { event: 'turn/event' }> => e.event === 'turn/event' && e.sessionId === SID);
    const pushedSeqs = [...new Set(pushed.map((e) => e.seq))].sort((a, b) => a - b);
    expect(pushedSeqs).toEqual(reference.map((e) => e.seq));
    for (const ev of pushed) {
      expect(ev.sessionEvent).toEqual(reference[ev.seq]);
    }
  });

  it('streams autonomous turns (no submitTurn) as turn/event and turn/chunk with no turnId', async () => {
    const before = await readEvents(daemon, { sessionId: SID, limit: 1 });
    const sessionEvents: HostSessionEvent[] = [];
    const chunks: HostTurnChunk[] = [];
    const offEvents = subscribeSessionEvents(daemon, 'alice', (e) => sessionEvents.push(e));
    const offChunks = subscribeTurnChunks(daemon, 'alice', (c) => chunks.push(c));
    try {
      const entry = (daemon as any).agents.get(SID);
      expect(entry).toBeDefined();
      entry.agent.followup(
        createUserMessage({ content: [{ type: 'text', text: 'Synthetic autonomous notice' }], source: { kind: 'user' } })
      );
      await waitFor(() => sessionEvents.some((e) => e.sessionId === SID && e.sessionEvent.type === 'turn/end'));
    } finally {
      offEvents();
      offChunks();
    }
    const mine = sessionEvents.filter((e) => e.sessionId === SID);
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      expect(e.userId).toBe('alice');
      expect(e.turnId).toBeUndefined();
      expect(e.seq).toBe(e.sessionEvent.seq);
      expect(e.seq).toBeGreaterThan(before.lastSeq);
    }
    const myChunks = chunks.filter((c) => c.sessionId === SID);
    expect(myChunks.length).toBeGreaterThan(0);
    expect(myChunks.every((c) => c.turnId === undefined && c.userId === 'alice')).toBe(true);

    // Gap fill after the live stream: the read (incl. not-yet-flushed tail) covers every pushed seq.
    const after = await readEvents(daemon, { sessionId: SID, afterSeq: before.lastSeq });
    expect(after.ok).toBe(true);
    const readSeqs = new Set(after.events.map((e: SessionEvent) => e.seq));
    for (const e of mine) expect(readSeqs.has(e.seq)).toBe(true);
  });
});

describe('readSessionEvents while a turn is running', () => {
  it('reads persisted (and unflushed) events without waiting for or blocking the turn', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-history-live-'));
    const dshHome = path.join(tmpDir, 'alice', '.dsh');
    const spacesDir = path.join(tmpDir, 'alice', 'spaces');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacesDir, 'space-live'), { recursive: true, mode: 0o700 });
    const SID = 'ses_00000000000000000000000000000b01';
    const daemon = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir, chunkDelayMs: 60 });
    await daemon.start();
    try {
      const first = await daemon.submitTurnAndWait({
        id: 'l1', op: 'submitTurn', turnId: turnId(0xb1), sessionId: SID, prompt: 'Synthetic first turn', workspaceFolder: 'space-live',
      });
      expect(first.status).toBe('completed');
      await new Promise((r) => setTimeout(r, 400));
      const settledLog = await readEvents(daemon, { sessionId: SID });

      let chunkSeen = false;
      daemon.on('stream', (ev: DaemonStreamEvent) => {
        if (ev.event === 'turn/chunk' && ev.sessionId === SID) chunkSeen = true;
      });
      let turnDone = false;
      const running = daemon
        .submitTurnAndWait({
          id: 'l2', op: 'submitTurn', turnId: turnId(0xb2), sessionId: SID, prompt: 'Synthetic slow second turn', workspaceFolder: 'space-live',
        })
        .finally(() => {
          turnDone = true;
        });
      await waitFor(() => chunkSeen);

      const live = await readEvents(daemon, { sessionId: SID });
      const persistedOnly = await readEvents(daemon, { sessionId: SID, includeUnflushed: false });
      expect(turnDone).toBe(false);
      expect((daemon as any).currentTurns.has(SID)).toBe(true);
      expect(live.ok).toBe(true);
      expect(persistedOnly.ok).toBe(true);
      expect(live.lastSeq).toBeGreaterThan(settledLog.lastSeq);
      expect(persistedOnly.lastSeq).toBe(persistedOnly.persistedLastSeq);
      expect(persistedOnly.lastSeq).toBeLessThanOrEqual(live.lastSeq);
      expect(live.persistedLastSeq).toBeLessThanOrEqual(live.lastSeq);
      // The page of the running turn has started but not ended.
      const types = live.events.map((e: SessionEvent) => e.type);
      expect(types.lastIndexOf('turn/start')).toBeGreaterThan(types.lastIndexOf('turn/end'));

      const done = await running;
      expect(done.status).toBe('completed');
      await new Promise((r) => setTimeout(r, 400));
      const final = await readEvents(daemon, { sessionId: SID, afterSeq: live.lastSeq });
      expect(final.events.map((e: SessionEvent) => e.type)).toContain('turn/end');
      expect(final.events[0].seq).toBe(live.lastSeq + 1);
    } finally {
      await daemon.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('cold reads: no agent activation, no writes; host UDS transport wiring', () => {
  it('reads an evicted session without writing anything, then serves the host transport', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-history-cold-'));
    const dshHome = path.join(tmpDir, 'alice', '.dsh');
    const spacesDir = path.join(tmpDir, 'alice', 'spaces');
    const spacePath = path.join(spacesDir, 'space-cold');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });
    const photo = syntheticJpeg('cold');
    fs.writeFileSync(path.join(spacePath, 'cold.jpg'), photo);
    const SID = 'ses_00000000000000000000000000000c01';

    const writer = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir });
    await writer.start();
    try {
      for (const [n, prompt] of [
        [0xc1, 'Synthetic cold turn'],
        [0xc2, '[enkeep-test-tool-call=read_image:{"file_path":"cold.jpg"}] Look.'],
      ] as const) {
        const res = await writer.submitTurnAndWait({ id: `c${n}`, op: 'submitTurn', turnId: turnId(n), sessionId: SID, prompt, workspaceFolder: 'space-cold' });
        expect(res.status).toBe('completed');
      }
    } finally {
      await writer.shutdown();
    }

    const reader = new RuntimeDaemon({ userId: 'alice', dshHome, spacesDir });
    await reader.start();
    const socketPath = path.join(tmpDir, 'd.sock');
    let server: net.Server | undefined;
    let transport: HostDaemonTransport | undefined;
    try {
      const before = snapshotTree(tmpDir);

      const newest = await readEvents(reader, { sessionId: SID, limit: 4 });
      expect(newest.ok).toBe(true);
      const all = await readEvents(reader, { sessionId: SID, afterSeq: -1, limit: 1000 });
      expect(all.ok).toBe(true);
      expect(all.hasMore).toBe(false);
      expect(all.lastSeq).toBe(all.events.length - 1);
      expect(all.persistedLastSeq).toBe(all.lastSeq);
      expect(newest.events).toEqual(all.events.slice(-4));
      const older = await readEvents(reader, { sessionId: SID, beforeSeq: newest.events[0].seq, limit: 3 });
      expect(older.events).toEqual(all.events.slice(-7, -4));
      const attachmentId = findImageAttachmentId(all.events);
      expect(attachmentId).toBeDefined();
      const image = await readAttachmentVia(directRequest(reader), { sessionId: SID, attachmentId });
      expect(Buffer.from(image.data, 'base64').equals(photo)).toBe(true);
      const byPath = await readAttachmentVia(directRequest(reader), { sessionId: SID, path: 'cold.jpg' });
      expect(Buffer.from(byPath.data, 'base64').equals(photo)).toBe(true);
      const missing = await readEvents(reader, { sessionId: 'ses_00000000000000000000000000000cff' });
      expect(missing.error.code).toBe('session/not-found');

      // Nothing was activated or written.
      expect((reader as any).agents.size).toBe(0);
      expect(((reader as any).bootedRuntime.agentHandles as Map<string, unknown>).size).toBe(0);
      expect((reader as any).bootedRuntime.context.sessions.get(SessionId(SID))).toBeUndefined();
      expect(snapshotTree(tmpDir)).toEqual(before);

      // Host-mode UDS transport against the same daemon (NDJSON framing as in daemon-cli).
      const activeSockets = new Set<net.Socket>();
      server = net.createServer((socket) => {
        activeSockets.add(socket);
        const decoder = new DaemonRpcDecoder();
        const encoder = new DaemonRpcEncoder();
        const onStream = (event: DaemonStreamEvent) => encoder.write(event);
        reader.on('stream', onStream);
        decoder.on('data', async (request: DaemonRequest) => encoder.write(await reader.handleRequest(request)));
        encoder.pipe(socket);
        socket.pipe(decoder);
        socket.on('close', () => {
          reader.removeListener('stream', onStream);
          activeSockets.delete(socket);
        });
      });
      await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
      transport = new HostDaemonTransport({ socketPath, userId: 'alice' });
      await transport.start();

      const viaTransport: ReadSessionEventsResult = await transport.readSessionEvents({ sessionId: SID, limit: 4 });
      expect(viaTransport.events).toEqual(newest.events);
      expect(viaTransport.lastSeq).toBe(all.lastSeq);
      const imageViaTransport = await transport.readAttachment({ sessionId: SID, attachmentId: attachmentId! });
      expect(imageViaTransport.data).toBe(image.data);
      await expect(transport.readSessionEvents({ sessionId: 'ses_00000000000000000000000000000cfe' })).rejects.toMatchObject({
        code: 'session/not-found',
      });

      const pushed: HostSessionEvent[] = [];
      const chunks: HostTurnChunk[] = [];
      const off = transport.onSessionEvent((e) => pushed.push(e));
      const offChunks = transport.onTurnChunk((c) => chunks.push(c));
      const res = await reader.submitTurnAndWait({ id: 'c3', op: 'submitTurn', turnId: turnId(0xc3), sessionId: SID, prompt: 'Synthetic resumed turn', workspaceFolder: 'space-cold' });
      expect(res.status).toBe('completed');
      await waitFor(() => pushed.some((e) => e.sessionEvent.type === 'turn/end'));
      off();
      offChunks();
      expect(pushed.every((e) => e.userId === 'alice' && e.sessionId === SID && e.turnId === turnId(0xc3))).toBe(true);
      // Resuming the evicted session commits a `session/end-seed` marker before DSH publishes
      // anything; the daemon re-pushes it, so the live seq stream stays contiguous.
      expect(pushed[0]!.seq).toBe(all.lastSeq + 1);
      expect(pushed[0]!.sessionEvent.type).toBe('session/end-seed');
      expect(pushed.map((e) => e.seq)).toEqual(pushed.map((_, i) => all.lastSeq + 1 + i));
      const afterResume = await readEvents(reader, { sessionId: SID, afterSeq: all.lastSeq });
      expect(afterResume.events.slice(0, pushed.length)).toEqual(pushed.map((e) => e.sessionEvent));
      expect(chunks.length).toBeGreaterThan(0);
      for (const s of activeSockets) s.destroy();
    } finally {
      await transport?.close();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      await reader.shutdown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('selectSessionEventsPage (synthetic events)', () => {
  const ev = (seq: number, size = 10): SessionEvent =>
    ({ type: 'plugin:test/blob', seq, time: 0, data: { pad: 'x'.repeat(size) } }) as unknown as SessionEvent;

  it('reports events that can never fit a frame instead of returning them', () => {
    const events = [ev(0), ev(1, 9 * 1024 * 1024), ev(2)];
    const fwd = selectSessionEventsPage(events, { afterSeq: -1, limit: 10, maxBytes: 4 * 1024 * 1024 });
    expect(fwd.events.map((e) => e.seq)).toEqual([0, 2]);
    expect(fwd.omitted).toEqual([expect.objectContaining({ seq: 1, reason: 'too-large', type: 'plugin:test/blob' })]);
    expect(fwd.hasMore).toBe(false);

    const back = selectSessionEventsPage(events, { limit: 10, maxBytes: 4 * 1024 * 1024 });
    expect(back.events.map((e) => e.seq)).toEqual([0, 2]);
    expect(back.omitted.map((o) => o.seq)).toEqual([1]);
  });

  it('works on an empty log', () => {
    expect(selectSessionEventsPage([], { limit: 10, maxBytes: 100 })).toEqual({ events: [], hasMore: false, omitted: [] });
    expect(selectSessionEventsPage([], { afterSeq: -1, limit: 10, maxBytes: 100 })).toEqual({ events: [], hasMore: false, omitted: [] });
  });

  it('subscriptions ignore unrelated stream events and survive throwing listeners', () => {
    const emitter = new EventEmitter();
    const got: HostSessionEvent[] = [];
    const off = subscribeSessionEvents(emitter, undefined, (e) => {
      got.push(e);
      throw new Error('listener failure');
    });
    emitter.emit('stream', { type: 'event', event: 'turn/chunk', sessionId: 's', turnId: '', timestamp: 1, chunk: { type: 'text-delta' } });
    emitter.emit('stream', { type: 'event', event: 'turn/event', sessionId: 'ses_x', turnId: '', seq: 3, timestamp: 2, sessionEvent: ev(3) });
    off();
    emitter.emit('stream', { type: 'event', event: 'turn/event', sessionId: 'ses_x', turnId: '', seq: 4, timestamp: 3, sessionEvent: ev(4) });
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ sessionId: 'ses_x', seq: 3, timestamp: 2, sessionEvent: ev(3) });
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileSeed, type SeedEvent } from '../src/seed.js';
import { materializeSessions } from '../src/multi-user/materialize.js';
import { assertLegalSeed, getSessionModule } from '../src/validate.js';

describe('WP-platform: HappyClaw Importer Seed & Materialize Compatibility', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-wp-platform-seed-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('compileSeed produces seeds that pass Session.create directly with valid V4 envelope', async () => {
    const chatJid = 'web:synth-chat-01';
    const messages = [
      {
        id: 'msg_001',
        chat_jid: chatJid,
        content: 'Hello synthetic user',
        timestamp: '1700000000000',
        is_from_me: 0,
        attachments: null,
      },
      {
        id: 'msg_002',
        chat_jid: chatJid,
        content: 'Hello from assistant',
        timestamp: '1700000001000',
        is_from_me: 1,
        attachments: null,
      },
    ];

    const { seed } = compileSeed(chatJid, messages);
    expect(seed.length).toBeGreaterThan(0);

    const asstMsg = seed.find((e) => e.type === 'assistant/message') as any;
    expect(asstMsg).toBeDefined();
    expect(Array.isArray(asstMsg.data.stream)).toBe(true);

    const endSeed = seed.find((e) => e.type === 'session/end-seed') as any;
    expect(endSeed).toBeDefined();
    expect(endSeed.data.inherited).toBe(true);

    // Assert validation with Session.create
    const { Session, SessionId } = await getSessionModule();
    const sid = SessionId('import-synth-001');
    const session = Session.create(sid, seed as any);
    expect(session.snapshotEvents().length).toBe(seed.length);
  });

  it('seeds produced are accepted by runtime importSeed trialHeader check (isAlreadyV4)', async () => {
    const chatJid = 'web:synth-chat-02';
    const messages = [
      {
        id: 'msg_003',
        chat_jid: chatJid,
        content: 'What is 1+1?',
        timestamp: '1700000000000',
        is_from_me: 0,
        attachments: null,
      },
      {
        id: 'msg_004',
        chat_jid: chatJid,
        content: '1+1 is 2',
        timestamp: '1700000001000',
        is_from_me: 1,
        attachments: null,
      },
    ];

    const { seed } = compileSeed(chatJid, messages);
    const { Session, SessionId, SessionLogOffset } = await getSessionModule();

    const sid = SessionId('import-synth-002');
    const trialHeader = {
      version: 4,
      id: sid,
      createdAt: seed[0]?.time ?? Date.now(),
      isSeeded: true,
    };

    // Exactly reproduces runtime-runner importSeed isAlreadyV4 check
    const inheritedCount = SessionLogOffset ? SessionLogOffset(seed.length) : (seed.length as any);
    const session = Session.create(sid, seed as any, trialHeader as any, inheritedCount);
    expect(session.snapshotEvents().length).toBeGreaterThan(0);
  });

  it('materializeSessions generates V4 session headers and creates both session.v4.jsonl and session.jsonl', async () => {
    const chatJid = 'web:synth-chat-03';
    const messages = [
      {
        id: 'msg_005',
        chat_jid: chatJid,
        content: 'Test message for disk materialize',
        timestamp: '1700000000000',
        is_from_me: 0,
        attachments: null,
      },
    ];

    const { seed } = compileSeed(chatJid, messages);
    const sessionId = 'import-00000000000000000000000000000003';
    const folder = 'default';

    const results = await materializeSessions(
      [
        {
          sessionId,
          folder,
          seed,
          chatJid,
        },
      ],
      {
        runtimeSessionsDir: tempDir,
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('MATERIALIZED');

    const v4Path = path.join(tempDir, folder, sessionId, 'session.v4.jsonl');
    const legacyPath = path.join(tempDir, folder, sessionId, 'session.jsonl');

    expect(fs.existsSync(v4Path)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(true);

    const v4Content = fs.readFileSync(v4Path, 'utf8');
    const headerLine = JSON.parse(v4Content.split('\n')[0]);
    expect(headerLine.type).toBe('session');
    expect(headerLine.version).toBe(4);
    expect(headerLine.isSeeded).toBe(true);
    expect(headerLine.delegationDepth).toBe(0);

    // Second run should recognize existing session as OK
    const rerunResults = await materializeSessions(
      [
        {
          sessionId,
          folder,
          seed,
          chatJid,
        },
      ],
      {
        runtimeSessionsDir: tempDir,
      }
    );

    expect(rerunResults[0].status).toBe('OK');
  });

  it('assertLegalSeed validates seeds through Session.create and fallback catalog restoration', async () => {
    const chatJid = 'web:synth-chat-04';
    const messages = [
      {
        id: 'msg_006',
        chat_jid: chatJid,
        content: 'Testing assertLegalSeed',
        timestamp: '1700000000000',
        is_from_me: 0,
        attachments: null,
      },
    ];

    const { seed } = compileSeed(chatJid, messages);
    await expect(assertLegalSeed('import-legal-01', seed)).resolves.not.toThrow();
  });
});

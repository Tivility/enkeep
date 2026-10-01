import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { EventRelayService } from '../src/service.js';
import { SqliteStreamEventSource } from '../../platform-server/src/channels/sqlite-stream-event-source.js';

describe('Item B: Structured Subagent Cause Child ID Contract', () => {
  let ctx: Context;
  let dispatchedFrames: any[];
  let mockPlatformClient: { request: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    ctx = new Context();
    dispatchedFrames = [];
    mockPlatformClient = {
      request: vi.fn().mockImplementation(async (_endpoint: string, opts: any) => {
        if (opts?.body?.events) {
          dispatchedFrames.push(...opts.body.events);
        }
        return { status: 200, data: { success: true } };
      }),
    };
    ctx.platformClient = mockPlatformClient as any;
  });

  it('identifies childId from agent/inbox/spliced subagent-settled and sets causeChildId on next autonomous turn', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_parent_0000000000000001' } as Session;
    const parentPlatformTurnId = 'turn_init_0000000000000001';
    const childId = 'ses_child_0000000000000002';

    // 1. Initial turn launches subagent
    service.bindTurnContext(session.id, {
      turnId: parentPlatformTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 100,
      data: { turn: 1 },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 2,
      time: 101,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              content: [{ type: 'text', text: `started subagent ${childId}` }],
            },
          ],
        },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 3,
      time: 102,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // 2. DSH emits agent/inbox/spliced with structured source subagent-settled
    service.ingest(session, {
      type: 'agent/inbox/spliced' as any,
      seq: 4,
      time: 103,
      data: {
        target: 'next-turn',
        inserted: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Subagent finished work.' }],
            source: {
              kind: 'subagent-settled',
              form: 'notice',
              senderSessionId: childId,
            },
          },
        ],
      },
    });

    // 3. Autonomous turn starts in DSH (turn 2)
    service.ingest(session, {
      type: 'turn/start',
      seq: 5,
      time: 104,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 6,
      time: 105,
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', text: 'Autonomous continuation answer.' },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 7,
      time: 106,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    // Verify outbound streaming frames carry causeChildId both top-level and in payload
    const autoFrames = dispatchedFrames.filter((f) => f.originTurnId === parentPlatformTurnId);
    expect(autoFrames.length).toBeGreaterThan(0);

    for (const frame of autoFrames) {
      expect(frame.causeChildId).toBe(childId);
      expect(frame.payload.causeChildId).toBe(childId);
      expect(frame.originTurnId).toBe(parentPlatformTurnId);
    }
  });

  it('identifies childId from agent/inbox/spliced agent-message and ignores message body text', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_parent_0000000000000003' } as Session;
    const parentPlatformTurnId = 'turn_init_0000000000000003';
    const realChildId = 'ses_child_real_000000000004';
    const fakeChildIdInBody = 'ses_child_fake_999999999999';

    // 1. Initial turn launches subagent
    service.bindTurnContext(session.id, {
      turnId: parentPlatformTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 200,
      data: { turn: 1 },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 2,
      time: 201,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              content: [{ type: 'text', text: `started subagent ${realChildId}` }],
            },
          ],
        },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 3,
      time: 202,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // 2. agent/inbox/spliced arrives with agent-message structured source;
    // body text contains fake child ID to verify body text is NEVER parsed
    service.ingest(session, {
      type: 'agent/inbox/spliced' as any,
      seq: 4,
      time: 203,
      data: {
        target: 'next-turn',
        inserted: [
          {
            role: 'user',
            content: [{ type: 'text', text: `Subagent message from started subagent ${fakeChildIdInBody}` }],
            source: {
              kind: 'agent-message',
              form: 'relay',
              senderSessionId: realChildId,
            },
          },
        ],
      },
    });

    // 3. Autonomous turn starts in DSH
    service.ingest(session, {
      type: 'turn/start',
      seq: 5,
      time: 204,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 6,
      time: 205,
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', text: 'Responding to agent message.' },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 7,
      time: 206,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    const autoFrames = dispatchedFrames.filter((f) => f.originTurnId === parentPlatformTurnId);
    expect(autoFrames.length).toBeGreaterThan(0);
    for (const frame of autoFrames) {
      expect(frame.causeChildId).toBe(realChildId);
      expect(frame.causeChildId).not.toBe(fakeChildIdInBody);
    }
  });

  it('identifies childId from user/message with structured source', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_parent_0000000000000005' } as Session;
    const parentPlatformTurnId = 'turn_init_0000000000000005';
    const childId = 'ses_child_0000000000000006';

    service.bindTurnContext(session.id, {
      turnId: parentPlatformTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 300,
      data: { turn: 1 },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 2,
      time: 301,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              content: [{ type: 'text', text: `started subagent ${childId}` }],
            },
          ],
        },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 3,
      time: 302,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // user/message arrives with structured source
    service.ingest(session, {
      type: 'user/message',
      seq: 4,
      time: 303,
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'Done.' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          senderSessionId: childId,
        },
      },
    });

    service.ingest(session, {
      type: 'turn/start',
      seq: 5,
      time: 304,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 6,
      time: 305,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    const autoFrames = dispatchedFrames.filter((f) => f.originTurnId === parentPlatformTurnId);
    expect(autoFrames.length).toBeGreaterThan(0);
    expect(autoFrames[0].causeChildId).toBe(childId);
  });

  it('identifies childId from tool-jobs structured plugin source and sets causeChildId on next autonomous turn', async () => {
    const service = new EventRelayService(ctx);
    const session = { id: 'ses_parent_0000000000000007' } as Session;
    const parentPlatformTurnId = 'turn_init_0000000000000007';
    const jobId = 'job-synthetic-01';

    // 1. Initial turn launches background job
    service.bindTurnContext(session.id, {
      turnId: parentPlatformTurnId,
      dshIntTurn: 1,
    });
    service.ingest(session, {
      type: 'turn/start',
      seq: 1,
      time: 400,
      data: { turn: 1 },
    });
    service.ingest(session, {
      type: 'tool/result',
      seq: 2,
      time: 401,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              content: [{ type: 'text', text: `started background job ${jobId}` }],
            },
          ],
        },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 3,
      time: 402,
      data: { turn: 1, reason: { kind: 'completed' } },
    });

    // 2. Structured source arrives from tool-jobs plugin; body text contains no job ID
    service.ingest(session, {
      type: 'agent/inbox/spliced' as any,
      seq: 4,
      time: 403,
      data: {
        target: 'next-turn',
        inserted: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Background job completed successfully.' }],
            source: {
              kind: 'plugin',
              plugin: 'tool-jobs',
              summary: `job ${jobId} finished`,
            },
          },
        ],
      },
    });

    // 3. Autonomous turn starts in DSH
    service.ingest(session, {
      type: 'turn/start',
      seq: 5,
      time: 404,
      data: { turn: 2 },
    });
    service.ingest(session, {
      type: 'assistant/chunk',
      seq: 6,
      time: 405,
      data: {
        turn: 2,
        step: 1,
        chunk: { type: 'text-delta', text: 'Autonomous turn response for background job.' },
      },
    });
    service.ingest(session, {
      type: 'turn/end',
      seq: 7,
      time: 406,
      data: { turn: 2, reason: { kind: 'completed' } },
    });

    await service.flush();

    const autoFrames = dispatchedFrames.filter((f) => f.originTurnId === parentPlatformTurnId);
    expect(autoFrames.length).toBeGreaterThan(0);
    for (const frame of autoFrames) {
      expect(frame.causeChildId).toBe(jobId);
      expect(frame.payload.causeChildId).toBe(jobId);
      expect(frame.originTurnId).toBe(parentPlatformTurnId);
    }
  });

  it('SqliteStreamEventSource parses causeChildId from payload and metadata', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE web_events (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Event 1: direct causeChildId in payload
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'evt_001',
      'ses_route_001',
      'user-synthetic-01',
      'turn_status',
      JSON.stringify({
        status: 'running',
        turnId: 'turn_auto_001',
        originTurnId: 'turn_parent_001',
        causeChildId: 'ses_child_direct_001',
      }),
      new Date().toISOString()
    );

    // Event 2: causeChildId inside metadata
    db.prepare(`
      INSERT INTO web_events (id, session_id, user_id, type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'evt_002',
      'ses_route_001',
      'user-synthetic-01',
      'turn_status',
      JSON.stringify({
        status: 'running',
        turnId: 'turn_auto_002',
        originTurnId: 'turn_parent_002',
        metadata: {
          causeChildId: 'ses_child_meta_002',
        },
      }),
      new Date().toISOString()
    );

    const source = new SqliteStreamEventSource(db);
    const events = await source.listAssistantEvents('ses_route_001', 0);

    expect(events.length).toBe(2);
    expect(events[0].causeChildId).toBe('ses_child_direct_001');
    expect(events[0].originTurnId).toBe('turn_parent_001');
    expect(events[1].causeChildId).toBe('ses_child_meta_002');
    expect(events[1].originTurnId).toBe('turn_parent_002');
  });
});

import { describe, expect, it } from 'vitest';
import {
  COMPACTED_NOTICE,
  INTERRUPTED_NOTICE,
  MAX_TOKENS_NOTICE,
  TOOL_OUTPUT_LIMIT_BYTES,
  TEXT_LIMIT_BYTES,
  fullItem,
  imageSource,
  isTurnStart,
  mapEvent,
  mapEvents,
  mapToolName,
  parseAttachmentLine,
  splitAttachmentListing,
  toWireItem,
} from '../src/mapper.js';
import { T0, assistantMessage, ev, toolResult, turnEnd, userMessage } from './helpers.js';

const IMAGE_ATTACHMENT = {
  attachmentId: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
  mediaType: 'image/png',
  bytes: 2048,
  width: 64,
  height: 32,
  name: 'diagram.png',
};

describe('mapEvent', () => {
  it('maps a person text message with seq = dsh seq + 1, ids <seq>#<n> and ts', () => {
    const items = mapEvent(userMessage(4, 'Hello there'));
    expect(items.map(toWireItem)).toEqual([
      { id: '5#0', seq: 5, ts: new Date(T0 + 4000).toISOString(), role: 'user', kind: 'text', text: 'Hello there' },
    ]);
    expect(items[0]!.person).toBe(true);
  });

  it('maps reasoning, text and tool calls of an assistant message', () => {
    const items = mapEvent(
      assistantMessage(9, [
        { type: 'reasoning', text: 'Thinking about files' },
        { type: 'text', text: 'Let me look.' },
        { type: 'tool-call', id: 'call_synth_01', name: 'bash', arguments: '{"command":"ls"}' },
        { type: 'tool-call', id: 'call_synth_02', name: 'custom_tool', arguments: 'not json' },
      ]),
    );
    expect(items.map((i) => [i.id, i.role, i.kind])).toEqual([
      ['10#0', 'assistant', 'thinking'],
      ['10#1', 'assistant', 'text'],
      ['10#2', 'assistant', 'tool_use'],
      ['10#3', 'assistant', 'tool_use'],
    ]);
    expect(items[0]!.text).toBe('Thinking about files');
    expect(items[2]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'call_synth_01' });
    expect(items[3]).toMatchObject({ tool_name: 'custom_tool', tool_input: { raw: 'not json' } });
  });

  it('maps tool results, including errors and result images', () => {
    const ok = mapEvent(toolResult(11, 'call_synth_01', [{ type: 'text', text: 'file-a\nfile-b' }]));
    expect(ok).toEqual([
      expect.objectContaining({ id: '12#0', role: 'user', kind: 'tool_result', tool_use_id: 'call_synth_01', is_error: false, text: 'file-a\nfile-b' }),
    ]);
    expect(ok[0]!.person).toBeUndefined();

    const failed = mapEvent(toolResult(12, 'call_synth_02', [], true, { name: 'ToolError', code: 'EXIT', reason: 'exit status 2' }));
    expect(failed[0]).toMatchObject({ kind: 'tool_result', is_error: true, text: 'exit status 2' });

    const withImage = mapEvent(
      toolResult(13, 'call_synth_03', [
        { type: 'text', text: 'Read image' },
        { type: 'image', attachment: IMAGE_ATTACHMENT },
      ]),
    );
    expect(withImage).toHaveLength(2);
    expect(toWireItem(withImage[1]!)).toEqual({
      id: '14#1',
      seq: 14,
      ts: new Date(T0 + 13_000).toISOString(),
      role: 'user',
      kind: 'image',
      tool_use_id: 'call_synth_03',
      image: { mime: 'image/png', data: '', lazy: true, size: 2048, width: 64, height: 32, name: 'diagram.png' },
    });
    expect(withImage[1]!.ref).toBe(`att:${IMAGE_ATTACHMENT.attachmentId}`);
  });

  it('maps person images as lazy placeholders resolvable by ref', () => {
    const event = userMessage(2, [
      { type: 'text', text: 'What is this?' },
      { type: 'image', attachment: IMAGE_ATTACHMENT },
    ]);
    const items = mapEvent(event);
    expect(items[1]).toMatchObject({ id: '3#1', role: 'user', kind: 'image', image: { mime: 'image/png', data: '', lazy: true, name: 'diagram.png' } });
    expect(items[1]).not.toHaveProperty('data');
    expect(items[1]).not.toHaveProperty('mime');
    expect(imageSource(event, '3#1')).toEqual({ ref: `att:${IMAGE_ATTACHMENT.attachmentId}` });
    expect(imageSource(event, '3#0')).toBeNull();

    const legacy = userMessage(3, [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
    expect(imageSource(legacy, '4#0')).toEqual({ mime: 'image/jpeg', data: 'AAAA' });
  });

  it('shows only the person: injected context is hidden', () => {
    const hidden = [
      userMessage(1, 'Runtime context', { kind: 'runtime-context', form: 'snapshot', sections: [] }),
      userMessage(2, 'Instructions', { kind: 'agent-instructions' }),
      userMessage(3, 'Done', { kind: 'subagent-settled' }),
      userMessage(4, 'Summary', { kind: 'compact-checkpoint', compactionId: 'cmp_1' }),
      userMessage(5, '[Quoting previous message from assistant: "earlier"]'),
      userMessage(6, 'Replaced', { kind: 'user' }),
    ];
    hidden[5] = { ...hidden[5]!, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } };
    expect(mapEvents(hidden)).toEqual([]);
    // Legacy events without a source are the person's.
    expect(mapEvent(ev(7, 'user/message', { role: 'user', content: 'legacy text' }))[0]).toMatchObject({ role: 'user', text: 'legacy text' });
  });

  it('turns enkeep attachment guidance into attachment items and splits appended listings', () => {
    const listing = [
      'Workspace attachments:',
      '- .attachments/in/0001/photo.png (photo (1).png) (media: image/png, size: 1234 bytes, etag: e-1)',
      '- .attachments/in/0001/notes.pdf (media: application/pdf, size: 99 bytes, etag: e-2)',
      '',
      'Paths prefixed with @ are files explicitly referenced by the user.',
    ].join('\n');
    const guidance = mapEvent(userMessage(1, listing));
    expect(guidance).toEqual([
      expect.objectContaining({
        id: '2#0',
        role: 'user',
        kind: 'image',
        image: { mime: 'image/png', data: '', lazy: true, size: 1234, name: 'photo (1).png' },
        ref: 'path:.attachments/in/0001/photo.png',
      }),
      expect.objectContaining({ id: '2#1', role: 'user', kind: 'text', text: '附件：notes.pdf' }),
    ]);
    expect(imageSource(userMessage(1, listing), '2#0')).toEqual({ ref: 'path:.attachments/in/0001/photo.png' });

    const appended = mapEvent(userMessage(2, `Please check\n\n${listing}`));
    expect(appended.map((i) => [i.kind, i.text ?? i.image?.name])).toEqual([
      ['text', 'Please check'],
      ['image', 'photo (1).png'],
      ['text', '附件：notes.pdf'],
    ]);

    // An unparsable listing: the guidance stays hidden, a person's text is shown as is.
    expect(mapEvent(userMessage(3, 'Workspace attachments:\nsomething else'))).toEqual([]);
    const odd = 'Look\nWorkspace attachments:\n- not a listing line';
    expect(mapEvent(userMessage(4, odd))[0]!.text).toBe(odd);
  });

  it('parses listing lines', () => {
    expect(parseAttachmentLine('- a/b.png (media: image/png, size: 1 bytes, etag: x)')).toEqual({ path: 'a/b.png', mime: 'image/png', size: 1 });
    expect(parseAttachmentLine('- a/b c.png (b c.png) (media: image/png, size: 10 bytes, etag: )')).toEqual({
      path: 'a/b c.png',
      name: 'b c.png',
      mime: 'image/png',
      size: 10,
    });
    expect(parseAttachmentLine('a/b.png (media: image/png)')).toBeNull();
    expect(splitAttachmentListing('plain text')).toEqual({ text: 'plain text', attachments: [] });
  });

  it('adds notices for interrupted, failed and output-limited turns and for compaction', () => {
    expect(mapEvent(turnEnd(20, { kind: 'aborted', reason: { kind: 'user' } }))).toEqual([
      expect.objectContaining({ id: '21#0', role: 'system', kind: 'notice', text: INTERRUPTED_NOTICE }),
    ]);
    expect(mapEvent(turnEnd(21, { kind: 'interrupted' }))[0]!.text).toBe('已中断');
    expect(mapEvent(turnEnd(22, { kind: 'max-tokens' }))[0]!.text).toBe(MAX_TOKENS_NOTICE);
    expect(mapEvent(turnEnd(23, { kind: 'error', error: { message: 'upstream unavailable', code: 'PROVIDER_ERROR' } }))[0]!.text).toBe(
      '出错（PROVIDER_ERROR）：upstream unavailable',
    );
    expect(mapEvent(turnEnd(24, { kind: 'completed' }))).toEqual([]);
    expect(mapEvent(ev(25, 'compaction/end', { compactionId: 'cmp_1', turn: null }))[0]!.text).toBe(COMPACTED_NOTICE);
    expect(mapEvent(ev(26, 'compaction/end', { compactionId: 'cmp_2', turn: null, error: 'failed' }))).toEqual([]);
  });

  it('maps an interrupted turn: the partial text, then the notice', () => {
    const items = mapEvents([
      userMessage(0, 'Start'),
      assistantMessage(1, [{ type: 'text', text: 'Partial ans' }], { interrupted: true }),
      turnEnd(2, { kind: 'aborted', reason: { kind: 'user' } }),
    ]);
    expect(items.map((i) => [i.id, i.kind, i.text])).toEqual([
      ['1#0', 'text', 'Start'],
      ['2#0', 'text', 'Partial ans'],
      ['3#0', 'notice', '已中断'],
    ]);
  });

  it('yields nothing for bookkeeping events (the seq still advances)', () => {
    for (const type of ['turn/start', 'step/start', 'step/end', 'request/header', 'tool/call', 'assistant/attempt', 'system/message']) {
      expect(mapEvent(ev(1, type, { turn: 1, step: 1 }))).toEqual([]);
    }
  });

  it('truncates long text and tool output with full_size and the notes; fullItem has it all', () => {
    const longText = 'あ'.repeat(10_000); // 30 000 bytes
    const textEvent = assistantMessage(30, [{ type: 'text', text: longText }]);
    const [light] = mapEvent(textEvent);
    expect(light!.full_size).toBe(30_000);
    expect(light!.text!.endsWith('\n…（已截断，共 30000 字节）')).toBe(true);
    expect(Buffer.byteLength(light!.text!.split('\n')[0]!)).toBeLessThanOrEqual(TEXT_LIMIT_BYTES);
    expect(fullItem(textEvent, '31#0')!.text).toBe(longText);
    expect(fullItem(textEvent, '31#0')!.full_size).toBeUndefined();

    const output = 'x'.repeat(5000);
    const resultEvent = toolResult(31, 'call_synth_09', [{ type: 'text', text: output }]);
    const [result] = mapEvent(resultEvent);
    expect(result!.full_size).toBe(5000);
    expect(result!.text).toBe(`${'x'.repeat(TOOL_OUTPUT_LIMIT_BYTES)}\n…（已截断，点开看全文，共 5000 字节）`);
    expect(fullItem(resultEvent, '32#0')!.text).toBe(output);

    const bigArgs = JSON.stringify({ file_path: '/tmp/enkeep-test/a.txt', content: 'y'.repeat(30_000) });
    const callEvent = assistantMessage(32, [{ type: 'tool-call', id: 'call_synth_10', name: 'write', arguments: bigArgs }]);
    const [call] = mapEvent(callEvent);
    expect(call!.tool_name).toBe('Write');
    expect(call!.full_size).toBe(Buffer.byteLength(bigArgs));
    expect((call!.tool_input!.content as string).length).toBeLessThan(30_000);
    expect(call!.tool_input!.file_path).toBe('/tmp/enkeep-test/a.txt');
    expect((fullItem(callEvent, '33#0')!.tool_input!.content as string).length).toBe(30_000);

    expect(fullItem(callEvent, '34#0')).toBeNull();
    expect(fullItem(callEvent, '33#5')).toBeNull();
  });

  it('maps tool names to Claude names', () => {
    expect(mapToolName('bash')).toBe('Bash');
    expect(mapToolName('read_image')).toBe('Read');
    expect(mapToolName('web_fetch')).toBe('WebFetch');
    expect(mapToolName('todo_write')).toBe('TodoWrite');
    expect(mapToolName('ask_user_question')).toBe('AskUserQuestion');
    expect(mapToolName('toString')).toBe('toString');
    expect(mapToolName('mcp__synthetic__tool')).toBe('mcp__synthetic__tool');
  });

  it('starts a turn at the first of a run of person items, not at tool results', () => {
    const items = mapEvents([
      userMessage(0, 'Workspace attachments:\n- .attachments/x.png (media: image/png, size: 1 bytes, etag: e)'),
      userMessage(1, 'Look at this'),
      assistantMessage(2, [{ type: 'tool-call', id: 'call_synth_20', name: 'read_image', arguments: '{}' }]),
      toolResult(3, 'call_synth_20', [{ type: 'text', text: 'ok' }, { type: 'image', attachment: IMAGE_ATTACHMENT }]),
      assistantMessage(4, [{ type: 'text', text: 'Sure' }]),
      userMessage(5, 'Thanks'),
    ]);
    const starts = items.filter((item, i) => isTurnStart(item, items[i - 1])).map((i) => i.id);
    expect(starts).toEqual(['1#0', '6#0']);
    expect(new Set(items.map((i) => i.role))).toEqual(new Set(['user', 'assistant']));
  });
});

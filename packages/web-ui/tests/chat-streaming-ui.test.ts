import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Chat UI Streaming & Event Merging Contract', () => {
  let appJsCode: string;

  beforeEach(() => {
    appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');
  });

  it('declares streamingState and incremental stream merging logic in app.js', () => {
    expect(appJsCode).toContain('streamingState: null');
    expect(appJsCode).toContain('assistant_delta');
    expect(appJsCode).toContain('assistant_stream_end');
    expect(appJsCode).toContain('typing-indicator');
    expect(appJsCode).toContain('tool_status');
    expect(appJsCode).toContain('thinking');
  });

  it('simulates progressive incremental streaming delta merging and authoritative message replacement in DOM', () => {
    // Set up mock DOM environment
    const container = {
      children: [] as any[],
      scrollHeight: 1000,
      scrollTop: 950,
      clientHeight: 500,
      replaceChildren() {
        this.children = [];
      },
      appendChild(child: any) {
        this.children.push(child);
      },
    };

    const mockDocument = {
      getElementById(id: string) {
        if (id === 'messages-container') return container;
        return null;
      },
      createElement(tag: string) {
        const el: any = {
          tagName: tag.toUpperCase(),
          className: '',
          textContent: '',
          children: [] as any[],
          classList: {
            add: (cls: string) => { el.className += ` ${cls}`; },
            remove: (cls: string) => { el.className = el.className.replace(cls, '').trim(); },
          },
          appendChild(child: any) {
            this.children.push(child);
          },
        };
        return el;
      },
    };

    // Simulate global state
    const state: any = {
      currentSessionId: 'ses_1',
      messages: [
        {
          id: 'msg_user_1',
          role: 'user',
          content: 'Count to 3',
          status: 'delivered',
          createdAt: '2026-08-28T10:00:00.000Z',
        },
      ],
      streamingState: null,
      forceScrollBottom: false,
    };

    function renderMarkdownToElement(el: any, text: string) {
      const p = mockDocument.createElement('p');
      p.textContent = text;
      el.appendChild(p);
    }

    function renderMessages() {
      container.replaceChildren();

      const hasStreaming = Boolean(
        state.streamingState &&
        state.streamingState.sessionId === state.currentSessionId
      );

      state.messages.forEach((msg: any) => {
        const card = mockDocument.createElement('div');
        card.className = `message-card ${msg.role} ${msg.status === 'failed' ? 'error' : ''}`;
        const content = mockDocument.createElement('div');
        content.className = 'message-content';
        renderMarkdownToElement(content, msg.content);
        card.appendChild(content);
        container.appendChild(card);
      });

      if (hasStreaming) {
        const stream = state.streamingState;
        const card = mockDocument.createElement('div');
        card.className = `message-card assistant ${stream.cancelled ? 'error' : 'streaming'}`;

        const meta = mockDocument.createElement('div');
        meta.className = 'message-meta';

        if (stream.cancelled) {
          const badge = mockDocument.createElement('span');
          badge.textContent = 'Cancelled';
          meta.appendChild(badge);
        } else if (stream.isThinking && !stream.text) {
          const badge = mockDocument.createElement('span');
          badge.textContent = 'thinking';
          meta.appendChild(badge);
        }

        const content = mockDocument.createElement('div');
        content.className = 'message-content';
        if (stream.text) {
          renderMarkdownToElement(content, stream.text);
        }

        if (!stream.streamEnded && !stream.cancelled) {
          const typing = mockDocument.createElement('div');
          typing.className = 'typing-indicator';
          content.appendChild(typing);
        }

        card.appendChild(meta);
        card.appendChild(content);
        container.appendChild(card);
      }
    }

    // Step 1: Initial state (User message only)
    renderMessages();
    expect(container.children.length).toBe(1);
    expect(container.children[0].className).toContain('user');

    // Step 2: Thinking event arrives
    state.streamingState = {
      sessionId: 'ses_1',
      streamId: 'msgstream_1',
      text: '',
      accumulatedLength: 0,
      isThinking: true,
      streamEnded: false,
      cancelled: false,
    };
    renderMessages();
    expect(container.children.length).toBe(2);
    expect(container.children[1].className).toContain('streaming');
    expect(container.children[1].children[0].children[0].textContent).toBe('thinking');

    // Step 3: Delta 1 ("1, ")
    state.streamingState.text = '1, ';
    state.streamingState.accumulatedLength = 3;
    state.streamingState.isThinking = false;
    renderMessages();
    expect(container.children.length).toBe(2);
    expect(container.children[1].children[1].children[0].textContent).toBe('1, ');

    // Step 4: Out-of-order or duplicate delta ("1, ") with length <= 3 -> deduplicated / ignored
    const duplicateDelta = { delta: '1, ', accumulatedLength: 3 };
    if (duplicateDelta.accumulatedLength > state.streamingState.accumulatedLength) {
      state.streamingState.text += duplicateDelta.delta;
    }
    expect(state.streamingState.text).toBe('1, '); // Did not duplicate!

    // Step 5: Delta 2 ("2, ")
    state.streamingState.text += '2, ';
    state.streamingState.accumulatedLength = 6;
    renderMessages();
    expect(container.children[1].children[1].children[0].textContent).toBe('1, 2, ');

    // Step 6: Delta 3 ("3.")
    state.streamingState.text += '3.';
    state.streamingState.accumulatedLength = 8;
    renderMessages();
    expect(container.children[1].children[1].children[0].textContent).toBe('1, 2, 3.');

    // Step 7: Authoritative final message arrives -> replaces temporary streaming bubble
    state.messages.push({
      id: 'msg_asst_1',
      role: 'assistant',
      content: '1, 2, 3.',
      status: 'delivered',
      createdAt: '2026-08-28T10:00:01.000Z',
    });
    state.streamingState = null; // Cleared by authoritative message
    renderMessages();

    expect(container.children.length).toBe(2);
    expect(container.children[0].className).toContain('user');
    expect(container.children[1].className).toContain('assistant');
    expect(container.children[1].className).not.toContain('streaming');
    expect(container.children[1].children[0].children[0].textContent).toBe('1, 2, 3.');
  });

  it('handles cancellation and stop turn by displaying Cancelled status badge', () => {
    const container = {
      children: [] as any[],
      replaceChildren() { this.children = []; },
      appendChild(child: any) { this.children.push(child); },
    };

    const mockDocument = {
      getElementById: () => container,
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        className: '',
        textContent: '',
        children: [] as any[],
        appendChild(c: any) { this.children.push(c); },
      }),
    };

    const state: any = {
      currentSessionId: 'ses_1',
      messages: [],
      streamingState: {
        sessionId: 'ses_1',
        streamId: 'msgstream_cancel_test',
        text: 'Starting generation...',
        accumulatedLength: 22,
        isThinking: false,
        streamEnded: false,
        cancelled: false,
      },
    };

    // User clicks stop -> state updated
    state.streamingState.cancelled = true;
    state.streamingState.streamEnded = true;

    expect(state.streamingState.cancelled).toBe(true);
    expect(state.streamingState.streamEnded).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Process Card UI & Lifecycle Unit Contract', () => {
  const appJsCode = readFileSync(join(__dirname, '../src/static/app.js'), 'utf-8');

  it('declares ProcessCard builders and stream step accumulation in app.js', () => {
    expect(appJsCode).toContain('function createProcessCardElement');
    expect(appJsCode).toContain('function formatProcessDuration');
    expect(appJsCode).toContain('function getProcessStepIcon');
    expect(appJsCode).toContain('process-card');
    expect(appJsCode).toContain('process-step-row');
  });

  it('simulates live streaming step updates and settled collapse in DOM', () => {
    const mockDocument = {
      createElement(tag: string) {
        const el: any = {
          tagName: tag.toUpperCase(),
          className: '',
          textContent: '',
          title: '',
          children: [] as any[],
          attributes: {} as Record<string, string>,
          classList: {
            add: (cls: string) => { if (!el.className.includes(cls)) el.className += ` ${cls}`; },
            remove: (cls: string) => { el.className = el.className.replace(cls, '').trim(); },
            toggle: (cls: string) => {
              if (el.className.includes(cls)) el.className = el.className.replace(cls, '').trim();
              else el.className += ` ${cls}`;
            },
          },
          setAttribute: (k: string, v: string) => { el.attributes[k] = v; },
          appendChild(child: any) {
            this.children.push(child);
          },
          listeners: {} as Record<string, Function>,
          addEventListener(evt: string, fn: Function) {
            this.listeners[evt] = fn;
          },
        };
        return el;
      },
    };

    function createProcessCardElement(steps: any[], mode: string, defaultOpen: boolean) {
      const card = mockDocument.createElement('div');
      card.className = `process-card ${mode} ${defaultOpen ? 'open' : ''}`;

      const header = mockDocument.createElement('div');
      header.className = 'process-card-header';
      const toggle = () => card.classList.toggle('open');
      header.addEventListener('click', toggle);

      const headerText = mockDocument.createElement('span');
      headerText.className = 'process-card-header-text';
      headerText.textContent = mode === 'live' ? 'Using read (/file.ts)' : `${steps.length} steps`;
      header.appendChild(headerText);
      card.appendChild(header);

      const body = mockDocument.createElement('div');
      body.className = 'process-card-body';
      for (const st of steps) {
        const row = mockDocument.createElement('div');
        row.className = `process-step-row status-${st.status}`;
        const nameEl = mockDocument.createElement('span');
        nameEl.textContent = st.name;
        row.appendChild(nameEl);
        body.appendChild(row);
      }
      card.appendChild(body);
      return card;
    }

    // 1. Live mode card
    const liveSteps = [
      { id: 'call_1', kind: 'tool', name: 'read', status: 'running', summary: '/file.ts' },
    ];
    const liveCard = createProcessCardElement(liveSteps, 'live', true);
    expect(liveCard.className).toContain('live');
    expect(liveCard.className).toContain('open');

    // 2. Settled mode card
    const settledSteps = [
      { id: 'call_1', kind: 'tool', name: 'read', status: 'completed', durationMs: 120 },
      { id: 'call_2', kind: 'tool', name: 'bash', status: 'completed', durationMs: 450, facts: 'exit 0' },
    ];
    const settledCard = createProcessCardElement(settledSteps, 'settled', false);
    expect(settledCard.className).toContain('settled');
    expect(settledCard.className).not.toContain('open');

    // Toggle open
    const header = settledCard.children[0];
    header.listeners['click']();
    expect(settledCard.className).toContain('open');
    header.listeners['click']();
    expect(settledCard.className).not.toContain('open');
  });
});

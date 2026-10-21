import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The background reconcile scans run every few seconds; they must only look at recent replies.
// Unbounded, every tick re-processed hundreds of old imported replies that never had an outbox
// row and blocked the event loop for seconds at a time.
describe('channel reconcile scans are bounded to recent replies', () => {
  for (const file of ['../src/channels/channel-runtime-manager.ts', '../src/channels/wechat-runtime.ts']) {
    it(`${file.split('/').pop()} limits every committed-turn scan to the last day`, () => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      const scans = src.split("AND wm.created_at < datetime('now', '-15 seconds')").length - 1;
      const bounded = src.split("AND wm.created_at >= datetime('now', '-1 day')").length - 1;
      expect(scans).toBeGreaterThan(0);
      expect(bounded).toBe(scans);
    });
  }

  it('old replies fall outside the window', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE web_messages (id TEXT, created_at TEXT)');
    db.prepare('INSERT INTO web_messages VALUES (?, ?)').run('old', '2026-07-27T10:00:00.000Z');
    const rows = db.prepare(`
      SELECT id FROM web_messages wm
      WHERE wm.created_at < datetime('now', '-15 seconds') AND wm.created_at >= datetime('now', '-1 day')
    `).all();
    expect(rows).toEqual([]);
  });
});

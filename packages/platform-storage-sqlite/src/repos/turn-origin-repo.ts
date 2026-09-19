import type { DatabaseSync } from 'node:sqlite';
import type {
  ChannelTurnOrigin,
  CreateChannelTurnOriginInput,
  TenantScopedTurnOriginRepository,
} from '@enkeep/platform-core';
import {
  ValidationError,
  NotFoundError,
} from '@enkeep/platform-core';
import {
  parseChannelTurnOriginRow,
  queryOne,
  queryAll,
} from '../utils/db.js';

export class SqliteTenantScopedTurnOriginRepository implements TenantScopedTurnOriginRepository {
  constructor(
    private readonly db: DatabaseSync,
    readonly userId: string
  ) {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      throw new ValidationError('userId must be a non-empty string');
    }
  }

  async create(input: CreateChannelTurnOriginInput): Promise<ChannelTurnOrigin> {
    const {
      turnId,
      sessionId,
      accountId,
      channel,
      chatId,
      nativeContextId,
      nativeEventId,
      replyToMessageId,
      rootId,
      threadId,
      originTurnId,
    } = input;

    if (!turnId || typeof turnId !== 'string' || turnId.trim().length === 0) {
      throw new ValidationError('Mandatory turnId missing or empty in createTurnOrigin');
    }
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new ValidationError('Mandatory sessionId missing or empty in createTurnOrigin');
    }
    if (!accountId || typeof accountId !== 'string' || accountId.trim().length === 0) {
      throw new ValidationError('Mandatory accountId missing or empty in createTurnOrigin');
    }
    if (!channel || typeof channel !== 'string' || channel.trim().length === 0) {
      throw new ValidationError('Mandatory channel missing or empty in createTurnOrigin');
    }
    if (channel.toLowerCase() === 'web') {
      throw new ValidationError('Turn origin is channel-only; web channel is not permitted');
    }
    if (channel.toLowerCase() === 'lark') {
      if (!nativeEventId || typeof nativeEventId !== 'string' || nativeEventId.trim().length === 0) {
        throw new ValidationError('Lark channel turn origin requires nativeEventId');
      }
    }
    if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
      throw new ValidationError('Mandatory chatId missing or empty in createTurnOrigin');
    }
    if (!nativeContextId || typeof nativeContextId !== 'string' || nativeContextId.trim().length === 0) {
      throw new ValidationError('Mandatory nativeContextId missing or empty in createTurnOrigin');
    }

    // Enforce account belongs to same tenant user
    const accountCheck = this.db.prepare(
      'SELECT id FROM channel_accounts WHERE id = ? AND user_id = ? LIMIT 1'
    ).get(accountId, this.userId);
    if (!accountCheck) {
      throw new NotFoundError(`Channel account "${accountId}" not found for user "${this.userId}"`);
    }

    // Enforce session belongs to same tenant user
    const sessionCheck = this.db.prepare(
      'SELECT id FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1'
    ).get(sessionId, this.userId);
    if (!sessionCheck) {
      throw new NotFoundError(`Session route "${sessionId}" not found for user "${this.userId}"`);
    }

    // Immutability: reject duplicate turn origin
    const existing = this.db.prepare(
      'SELECT turn_id FROM channel_turn_origins WHERE turn_id = ? LIMIT 1'
    ).get(turnId);
    if (existing) {
      throw new ValidationError(`Channel turn origin already exists for turn: "${turnId}"`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO channel_turn_origins (
        turn_id, user_id, session_id, account_id, channel, chat_id,
        native_context_id, native_event_id, reply_to_message_id, root_id, thread_id, origin_turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      turnId,
      this.userId,
      sessionId,
      accountId,
      channel,
      chatId,
      nativeContextId,
      nativeEventId ?? null,
      replyToMessageId ?? null,
      rootId ?? null,
      threadId ?? null,
      originTurnId ?? null
    );

    const created = await this.findByTurnId(turnId);
    if (!created) {
      throw new Error('Failed to retrieve newly created channel turn origin');
    }
    return created;
  }

  async findByTurnId(turnId: string): Promise<ChannelTurnOrigin | null> {
    if (!turnId || typeof turnId !== 'string') return null;
    const stmt = this.db.prepare(
      'SELECT * FROM channel_turn_origins WHERE user_id = ? AND turn_id = ? LIMIT 1'
    );
    return queryOne(stmt, parseChannelTurnOriginRow, this.userId, turnId);
  }

  async findByOriginTurnId(originTurnId: string): Promise<ChannelTurnOrigin[]> {
    if (!originTurnId || typeof originTurnId !== 'string') return [];
    const stmt = this.db.prepare(
      'SELECT * FROM channel_turn_origins WHERE user_id = ? AND origin_turn_id = ? ORDER BY created_at ASC'
    );
    return queryAll(stmt, parseChannelTurnOriginRow, this.userId, originTurnId);
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { OutboundFileChannelAdapter, FileMetadata } from '@enkeep/platform-operations';
import type { ChannelRuntimeManager } from './channel-runtime-manager.js';
import type { WeChatRuntimeManager } from './wechat-runtime.js';

export interface DefaultOutboundFileChannelAdapterOptions {
  readonly db: DatabaseSync;
  readonly spacesDir?: string;
  readonly channelRuntimeManager?: ChannelRuntimeManager;
  readonly wechatRuntimeManager?: WeChatRuntimeManager;
}

/**
 * Platform server OutboundFileChannelAdapter implementation.
 * Freezes target channel metadata from channel_turn_origins / session_child_origins.
 * - If channel === 'web' or no channel origin found: returns { deliveryStatus: 'recorded' }
 * - If channel === 'wechat': loads file from disk, dispatches to WeChat gateway via deliverFile
 * - If channel === 'lark': if channel supports file dispatch, sends to Lark; otherwise returns failed ("渠道暂不支持文件发送")
 */
export class DefaultOutboundFileChannelAdapter implements OutboundFileChannelAdapter {
  private readonly db: DatabaseSync;
  private readonly spacesDir?: string;
  private readonly channelRuntimeManager?: ChannelRuntimeManager;
  private readonly wechatRuntimeManager?: WeChatRuntimeManager;

  constructor(options: DefaultOutboundFileChannelAdapterOptions) {
    this.db = options.db;
    this.spacesDir = options.spacesDir;
    this.channelRuntimeManager = options.channelRuntimeManager;
    this.wechatRuntimeManager = options.wechatRuntimeManager;
  }

  async deliverFile(params: {
    userId: string;
    recipient: string;
    fileMetadata: FileMetadata;
    customPayload?: Record<string, unknown>;
    turnId?: string;
    sessionId?: string;
  }): Promise<{
    channelFileId?: string;
    metadata?: Record<string, unknown>;
    deliveryStatus?: 'recorded' | 'sent' | 'failed' | 'unknown';
    deliveryError?: string;
  }> {
    const { userId, recipient, fileMetadata, turnId, sessionId } = params;

    let targetTurnId = turnId;

    // 1. If turnId not directly supplied, try to look up via session_child_origins using sessionId as child_id
    if (!targetTurnId && sessionId) {
      try {
        const childRow = this.db.prepare(
          'SELECT origin_turn_id FROM session_child_origins WHERE child_id = ? LIMIT 1'
        ).get(sessionId) as { origin_turn_id?: string } | undefined;
        if (childRow?.origin_turn_id) {
          targetTurnId = childRow.origin_turn_id;
        }
      } catch {}
    }

    // 2. Query channel_turn_origins using turnId
    let originRow: {
      turn_id: string;
      user_id: string;
      session_id: string;
      account_id: string;
      channel: string;
      chat_id: string;
      native_context_id: string;
      native_event_id?: string;
      reply_to_message_id?: string;
      root_id?: string;
      thread_id?: string;
      origin_turn_id?: string;
    } | undefined;

    if (targetTurnId) {
      try {
        originRow = this.db.prepare(
          'SELECT * FROM channel_turn_origins WHERE turn_id = ? AND user_id = ? LIMIT 1'
        ).get(targetTurnId, userId) as any;
      } catch {}
    }

    // Fallback: If still not found, check session_routes for channel
    if (!originRow && sessionId) {
      try {
        const routeRow = this.db.prepare(
          'SELECT * FROM session_routes WHERE id = ? AND user_id = ? LIMIT 1'
        ).get(sessionId, userId) as any;
        if (routeRow && routeRow.channel && routeRow.channel !== 'web') {
          originRow = {
            turn_id: targetTurnId || '',
            user_id: userId,
            session_id: sessionId,
            account_id: routeRow.account_id || '',
            channel: routeRow.channel,
            chat_id: routeRow.native_context_id || routeRow.peer_id || '',
            native_context_id: routeRow.native_context_id || routeRow.peer_id || '',
          };
        }
      } catch {}
    }

    // If no channel origin found, or channel is web -> recorded only
    if (!originRow || originRow.channel === 'web' || !originRow.channel) {
      return {
        deliveryStatus: 'recorded',
        metadata: { channel: 'web', note: 'Web session: recorded without external dispatch' },
      };
    }

    // 3. IM Channel target resolution
    const channel = originRow.channel;

    // Load file buffer from space directory if available
    let fileBuffer: Buffer | undefined;
    if (this.spacesDir) {
      // Find space folder from session_routes or spaces
      try {
        const spaceRow = this.db.prepare(
          `SELECT s.folder, s.id as space_id FROM spaces s
           JOIN session_routes sr ON sr.space_id = s.id
           WHERE (sr.id = ? OR sr.dsh_session_id = ?) AND sr.user_id = ? LIMIT 1`
        ).get(sessionId || recipient, sessionId || recipient, userId) as { folder?: string; space_id?: string } | undefined;

        const folder = spaceRow?.folder || spaceRow?.space_id;
        if (folder) {
          const absPath = path.resolve(this.spacesDir, folder, fileMetadata.relativePath);
          if (fs.existsSync(absPath)) {
            fileBuffer = fs.readFileSync(absPath);
          }
        }
      } catch {}
    }

    if (!fileBuffer) {
      // Fallback: if customPayload / metadata contains buffer or base64
      const customBuf = (params.customPayload?.buffer as Buffer) || (fileMetadata.metadata?.buffer as Buffer);
      if (Buffer.isBuffer(customBuf)) {
        fileBuffer = customBuf;
      }
    }

    if (channel === 'wechat') {
      const wechatRuntime = this.wechatRuntimeManager;
      if (!wechatRuntime) {
        return {
          deliveryStatus: 'failed',
          deliveryError: 'WeChat runtime manager is not available on platform server',
        };
      }

      const gateway = wechatRuntime.getActiveGateway(userId, originRow.account_id);
      if (!gateway) {
        return {
          deliveryStatus: 'failed',
          deliveryError: `No active WeChat gateway for account ${originRow.account_id}`,
        };
      }

      if (!fileBuffer) {
        fileBuffer = Buffer.from(''); // minimal fallback buffer
      }

      const res = await gateway.deliverFile({
        sessionId: originRow.session_id,
        nativeContextId: originRow.native_context_id,
        replyToMessageId: originRow.reply_to_message_id,
        turnId: targetTurnId,
        fileBuffer,
        fileName: fileMetadata.filename,
        mimeType: fileMetadata.mimeType,
      });

      return {
        deliveryStatus: res.deliveryStatus,
        deliveryError: res.error,
        channelFileId: res.outboxItem?.id,
      };
    }

    if (channel === 'lark') {
      // Check if lark gateway implements deliverFile (E-01)
      const larkGateway = this.channelRuntimeManager?.getActiveGateway(userId, originRow.account_id);
      if (larkGateway && typeof (larkGateway as any).deliverFile === 'function') {
        const res = await (larkGateway as any).deliverFile({
          sessionId: originRow.session_id,
          chatId: originRow.chat_id,
          replyToMessageId: originRow.reply_to_message_id,
          threadId: originRow.thread_id,
          turnId: targetTurnId,
          fileBuffer: fileBuffer || Buffer.from(''),
          fileName: fileMetadata.filename,
          mimeType: fileMetadata.mimeType,
        });
        return {
          deliveryStatus: res.deliveryStatus || (res.success ? 'sent' : 'failed'),
          deliveryError: res.error,
        };
      }

      // Step B: Lark file sending not yet implemented in Step B (will be in Step E)
      // Record outbox row as failed
      try {
        const outboxId = `out_lark_file_${targetTurnId || Date.now()}`;
        this.db.prepare(`
          INSERT OR IGNORE INTO channel_outbox (
            id, user_id, account_id, session_id, native_context_id, reply_to_native_id, payload_json, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          outboxId,
          userId,
          originRow.account_id,
          originRow.session_id,
          originRow.native_context_id,
          originRow.reply_to_message_id || null,
          JSON.stringify({
            channel: 'lark',
            fileName: fileMetadata.filename,
            fileSize: fileMetadata.size,
            turnId: targetTurnId,
            error: '渠道暂不支持文件发送',
          })
        );
      } catch {}

      return {
        deliveryStatus: 'failed',
        deliveryError: '渠道暂不支持文件发送',
      };
    }

    return {
      deliveryStatus: 'failed',
      deliveryError: `Unsupported channel: ${channel}`,
    };
  }
}

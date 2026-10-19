import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_001_SQL,
  MIGRATION_031_GENERIC_CHANNELS_SQL,
  SqlitePlatformStorage,
  SqliteTenantScopedChannelRepository,
} from '../src/index.js';
import { ALL_PLATFORM_MIGRATIONS, PlatformServerMigrationRunner } from '../../platform-server/src/storage/migrations.js';

describe('SqliteTenantScopedChannelRepository', () => {
  let db: DatabaseSync;
  let repo: SqliteTenantScopedChannelRepository;
  const userId = 'usr_test_1';
  const spaceId = 'spc_test_1';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Seed test user and space
    db.prepare(`INSERT INTO users (id, username, password_hash) VALUES (?, 'tester', 'hash')`).run(userId);
    db.prepare(`INSERT INTO spaces (id, user_id, name, folder) VALUES (?, ?, 'Main Space', 'main')`).run(spaceId, userId);

    repo = new SqliteTenantScopedChannelRepository(db, userId);
  });

  describe('Channel Accounts', () => {
    it('creates, retrieves, updates, and lists channel accounts', async () => {
      const account = await repo.createAccount({
        type: 'lark',
        status: 'active',
        credentialRef: 'cred_lark_1',
      });

      expect(account.id).toBeDefined();
      expect(account.type).toBe('lark');
      expect(account.status).toBe('active');
      expect(account.credentialRef).toBe('cred_lark_1');

      const found = await repo.findAccountById(account.id);
      expect(found).toEqual(account);

      const updated = await repo.updateAccount(account.id, {
        status: 'disabled',
        credentialRef: 'cred_lark_2',
      });
      expect(updated.status).toBe('disabled');
      expect(updated.credentialRef).toBe('cred_lark_2');

      const accounts = await repo.listAccounts('lark');
      expect(accounts.length).toBe(1);
      expect(accounts[0].id).toBe(account.id);

      const deleted = await repo.deleteAccount(account.id);
      expect(deleted).toBe(true);
      expect(await repo.findAccountById(account.id)).toBeNull();
    });
  });

  describe('Channel Bindings', () => {
    it('creates, retrieves, updates, and enforces uniqueness on channel bindings', async () => {
      const account = await repo.createAccount({ type: 'lark' });

      const binding = await repo.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: 'oc_chat_123',
        activationMode: 'mention',
      });

      expect(binding.id).toBeDefined();
      expect(binding.accountId).toBe(account.id);
      expect(binding.spaceId).toBe(spaceId);
      expect(binding.nativeContextId).toBe('oc_chat_123');
      expect(binding.activationMode).toBe('mention');
      expect(binding.busyMode).toBe('queue');

      const found = await repo.findBindingByContext(account.id, 'oc_chat_123');
      expect(found).toEqual(binding);

      // Duplicate binding on same account + nativeContextId should throw ConflictError
      await expect(
        repo.createBinding({
          accountId: account.id,
          spaceId,
          nativeContextId: 'oc_chat_123',
        })
      ).rejects.toThrow();

      const updated = await repo.updateBinding(binding.id, {
        activationMode: 'always',
        busyMode: 'steer',
      });
      expect(updated.activationMode).toBe('always');
      expect(updated.busyMode).toBe('steer');

      const bindings = await repo.listBindings(account.id);
      expect(bindings.length).toBe(1);

      await repo.deleteBinding(binding.id);
      expect(await repo.findBindingById(binding.id)).toBeNull();
    });
  });

  describe('Streaming Cards', () => {
    it('upserts streaming cards, tracks snapshot, claims for recovery and finalizes', async () => {
      const account = await repo.createAccount({ type: 'lark' });

      // Create initial route
      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, native_context_id, dsh_session_id)
        VALUES ('ses_route_test_1', ?, ?, 'lark', 'oc_chat_test', 'dsh_ses_1')
      `).run(userId, spaceId);

      const turnId = 'turn_test_streaming_1';
      const created = await repo.upsertStreamingCard({
        turnId,
        accountId: account.id,
        sessionId: 'ses_route_test_1',
        nativeContextId: 'oc_chat_test',
        chatId: 'oc_chat_test',
        replyToMessageId: 'om_reply_1',
        cardId: 'crd_test_1',
        messageId: 'om_card_msg_1',
        version: 1,
        status: 'streaming',
        snapshotText: 'Hello world',
      });

      expect(created.id).toBeDefined();
      expect(created.turnId).toBe(turnId);
      expect(created.cardId).toBe('crd_test_1');
      expect(created.messageId).toBe('om_card_msg_1');
      expect(created.status).toBe('streaming');
      expect(created.snapshotText).toBe('Hello world');

      // Update snapshot
      const updated = await repo.upsertStreamingCard({
        turnId,
        accountId: account.id,
        sessionId: 'ses_route_test_1',
        nativeContextId: 'oc_chat_test',
        chatId: 'oc_chat_test',
        snapshotText: 'Hello world expanded text',
        version: 2,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.snapshotText).toBe('Hello world expanded text');
      expect(updated.version).toBe(2);

      // List nonterminal
      const nonterminal = await repo.listNonterminalStreamingCards();
      expect(nonterminal.some((c) => c.id === created.id)).toBe(true);

      // Claim for recovery
      const claimed = await repo.claimStreamingCardForRecovery(created.id);
      expect(claimed?.status).toBe('recovering');

      // Finalize
      const finalized = await repo.finalizeStreamingCard(created.id, 'completed');
      expect(finalized.status).toBe('completed');
      expect(finalized.completedAt).toBeDefined();

      const afterFinalize = await repo.listNonterminalStreamingCards();
      expect(afterFinalize.some((c) => c.id === created.id)).toBe(false);
    });

    it('setGroupActivationModeForAccountBindings updates group bindings and leaves p2p/other bindings untouched', async () => {
      const account = await repo.createAccount({ type: 'lark', groupActivationMode: 'mention' });
      expect(account.groupActivationMode).toBe('mention');

      // Group binding 1 (initially mention)
      const groupBinding1 = await repo.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: 'oc_group_1',
        activationMode: 'mention',
        chatType: 'group',
      });
      expect(groupBinding1.chatType).toBe('group');
      expect(groupBinding1.activationMode).toBe('mention');

      // P2P binding (always)
      const p2pBinding = await repo.createBinding({
        accountId: account.id,
        spaceId,
        nativeContextId: 'oc_p2p_1',
        activationMode: 'always',
        chatType: 'p2p',
      });
      expect(p2pBinding.chatType).toBe('p2p');
      expect(p2pBinding.activationMode).toBe('always');

      // Flip account group activation mode to 'always'
      const changes = await repo.setGroupActivationModeForAccountBindings(account.id, 'always');
      expect(changes).toBe(1);

      const refetchedGroup = await repo.findBindingById(groupBinding1.id);
      expect(refetchedGroup?.activationMode).toBe('always');

      const refetchedP2P = await repo.findBindingById(p2pBinding.id);
      expect(refetchedP2P?.activationMode).toBe('always'); // unchanged, still always

      // Calling again when already 'always' should yield 0 changes
      const changesAgain = await repo.setGroupActivationModeForAccountBindings(account.id, 'always');
      expect(changesAgain).toBe(0);
    });
  });

  describe('Channel Inbox Idempotency', () => {
    it('creates inbox items and detects duplicates', async () => {
      const account = await repo.createAccount({ type: 'lark' });

      const first = await repo.createInboxItem({
        accountId: account.id,
        nativeEventId: 'evt_12345',
        nativeContextId: 'oc_chat_123',
        payloadJson: JSON.stringify({ text: 'hello' }),
      });

      expect(first.isDuplicate).toBe(false);
      expect(first.item.status).toBe('held');

      const second = await repo.createInboxItem({
        accountId: account.id,
        nativeEventId: 'evt_12345',
        nativeContextId: 'oc_chat_123',
        payloadJson: JSON.stringify({ text: 'hello again' }),
      });

      expect(second.isDuplicate).toBe(true);
      expect(second.item.id).toBe(first.item.id);

      const updated = await repo.updateInboxStatus(first.item.id, 'processing');
      expect(updated.status).toBe('processing');

      const heldList = await repo.listHeldInbox();
      expect(heldList.length).toBe(0);
    });
  });

  describe('Channel Outbox Pipeline', () => {
    it('manages durable outbox lifecycle and retries', async () => {
      const account = await repo.createAccount({ type: 'lark' });

      // Create session route
      db.prepare(`
        INSERT INTO session_routes (id, user_id, space_id, channel, account_id, native_context_id, peer_id, dsh_session_id)
        VALUES ('ses_lark_1', ?, ?, 'lark', ?, 'oc_chat_123', 'oc_chat_123', 'dsh_ses_1')
      `).run(userId, spaceId, account.id);

      const outbox = await repo.createOutboxItem({
        accountId: account.id,
        sessionId: 'ses_lark_1',
        nativeContextId: 'oc_chat_123',
        replyToNativeId: 'om_root_1',
        payloadJson: JSON.stringify({ text: 'Hello from agent!' }),
        status: 'pending',
      });

      expect(outbox.id).toBeDefined();
      expect(outbox.status).toBe('pending');
      expect(outbox.attempts).toBe(0);

      const pending = await repo.listPendingOutbox();
      expect(pending.length).toBe(1);
      expect(pending[0].id).toBe(outbox.id);

      const sending = await repo.updateOutboxStatus(outbox.id, 'sending', true);
      expect(sending.status).toBe('sending');
      expect(sending.attempts).toBe(1);

      const delivered = await repo.updateOutboxStatus(outbox.id, 'delivered', false);
      expect(delivered.status).toBe('delivered');

      const remainingPending = await repo.listPendingOutbox();
      expect(remainingPending.length).toBe(0);
    });
  });
});

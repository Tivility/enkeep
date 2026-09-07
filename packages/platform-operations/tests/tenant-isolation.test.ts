import { describe, it, expect, beforeEach } from 'vitest';
import { FakePlatformOperationsStorage } from './support/index.js';
import { PlatformOperationsService } from '../src/services/platform-operations-service.js';
import { TaskNotFoundError } from '../src/errors/index.js';

describe('Tenant Isolation in Platform Operations', () => {
  let storage: FakePlatformOperationsStorage;
  let service: PlatformOperationsService;

  beforeEach(() => {
    storage = new FakePlatformOperationsStorage();
    service = new PlatformOperationsService({ storage });
  });

  it('strictly isolates tasks between Tenant A and Tenant B', async () => {
    const tenantA = service.forTenant('user_alice');
    const tenantB = service.forTenant('user_bob');

    // Alice creates a task
    const { task: aliceTask } = await tenantA.tasks.createTask({
      title: 'Alice Task 1',
      priority: 'high',
      payload: {
        type: 'agent_prompt',
        prompt: 'Alice task prompt',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      },
    });

    // Bob creates a task
    const { task: bobTask } = await tenantB.tasks.createTask({
      title: 'Bob Task 1',
      priority: 'low',
      payload: {
        type: 'agent_prompt',
        prompt: 'Bob task prompt',
        sessionId: 'ses_0123456789abcdef0123456789abcdef',
        sessionPolicy: 'existing_session',
      },
    });

    // Alice cannot see Bob's tasks in list
    const aliceTasks = await tenantA.tasks.listTasks();
    expect(aliceTasks).toHaveLength(1);
    expect(aliceTasks[0].id).toBe(aliceTask.id);

    const bobTasks = await tenantB.tasks.listTasks();
    expect(bobTasks).toHaveLength(1);
    expect(bobTasks[0].id).toBe(bobTask.id);

    // Alice cannot get Bob's task directly
    const aliceLookup = await tenantA.tasks.getTask(bobTask.id);
    expect(aliceLookup).toBeNull();

    // Alice cannot claim Bob's task
    await expect(
      tenantA.tasks.claimTask({
        claimantId: 'worker_alice',
        preferredTaskId: bobTask.id,
      })
    ).rejects.toThrow(TaskNotFoundError);
  });

  it('strictly isolates quota limits, usages, and reservations between tenants', async () => {
    const tenantA = service.forTenant('user_alice');
    const tenantB = service.forTenant('user_bob');

    // Configure different limits for Alice and Bob
    await tenantA.quota.setLimit({ resource: 'tokens', limit: 1000 });
    await tenantB.quota.setLimit({ resource: 'tokens', limit: 5000 });

    // Alice consumes 800 tokens
    await tenantA.quota.consumeQuota({ resource: 'tokens', amount: 800 });

    const aliceUsage = await tenantA.quota.checkQuota({ resource: 'tokens' });
    expect(aliceUsage.usage['tokens']).toBe(800);
    expect(aliceUsage.remaining['tokens']).toBe(200);

    // Bob's quota must remain completely untouched
    const bobUsage = await tenantB.quota.checkQuota({ resource: 'tokens' });
    expect(bobUsage.usage['tokens']).toBe(0);
    expect(bobUsage.remaining['tokens']).toBe(5000);

    // Alice reserves remaining 200 tokens
    const reservation = await tenantA.quota.reserveQuota({ resource: 'tokens', amount: 200 });

    // Bob cannot commit or release Alice's reservation
    await expect(
      tenantB.quota.commitQuota({ reservationId: reservation.id })
    ).rejects.toThrow();

    await expect(
      tenantB.quota.releaseQuota({ reservationId: reservation.id })
    ).rejects.toThrow();
  });

  it('strictly isolates delivery receipts and messages between tenants', async () => {
    const tenantA = service.forTenant('user_alice');
    const tenantB = service.forTenant('user_bob');

    const aliceMsg = await tenantA.messages.sendMessage({
      recipient: 'channel_1',
      content: 'Hello from Alice',
      deliveryId: 'shared_delivery_id',
    });

    // Bob sends with the SAME deliveryId in his own tenant namespace
    const bobMsg = await tenantB.messages.sendMessage({
      recipient: 'channel_2',
      content: 'Hello from Bob',
      deliveryId: 'shared_delivery_id',
    });

    expect(aliceMsg.receipt.userId).toBe('user_alice');
    expect(bobMsg.receipt.userId).toBe('user_bob');
    expect(aliceMsg.messageId).not.toBe(bobMsg.messageId);

    // Bob cannot retrieve Alice's receipt
    const bobLookup = await tenantB.messages.getReceipt(aliceMsg.receipt.id);
    expect(bobLookup).toBeNull();
  });

  it('strictly isolates file metadata records between tenants', async () => {
    const tenantA = service.forTenant('user_alice');
    const tenantB = service.forTenant('user_bob');

    const aliceFile = await tenantA.files.sendFile({
      recipient: 'peer_1',
      path: 'reports/alice.pdf',
    });

    const bobFiles = await tenantB.files.listFiles();
    expect(bobFiles).toHaveLength(0);

    const bobLookup = await tenantB.files.getFile(aliceFile.fileId);
    expect(bobLookup).toBeNull();
  });
});

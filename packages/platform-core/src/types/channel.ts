export type ChannelType = 'lark' | string;

export type ChannelAccountStatus = 'active' | 'disabled' | 'unverified';

export type ChannelActivationMode = 'mention' | 'always';

export type ChannelInboxStatus = 'held' | 'processing' | 'delivered' | 'failed';

export type ChannelOutboxStatus = 'pending' | 'sending' | 'delivered' | 'failed';

export interface ChannelAccount {
  id: string;
  userId: string;
  type: ChannelType;
  status: ChannelAccountStatus;
  credentialRef: string | null;
  defaultSpaceId?: string | null;
  groupActivationMode?: ChannelActivationMode;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelAccountInput {
  id?: string;
  userId: string;
  type: ChannelType;
  status?: ChannelAccountStatus;
  credentialRef?: string | null;
  defaultSpaceId?: string | null;
  groupActivationMode?: ChannelActivationMode;
}

export interface UpdateChannelAccountInput {
  status?: ChannelAccountStatus;
  credentialRef?: string | null;
  defaultSpaceId?: string | null;
  groupActivationMode?: ChannelActivationMode;
}

export interface ChannelBinding {
  id: string;
  userId: string;
  accountId: string;
  spaceId: string;
  nativeContextId: string;
  activationMode: ChannelActivationMode;
  chatType?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelBindingInput {
  id?: string;
  userId: string;
  accountId: string;
  spaceId: string;
  nativeContextId: string;
  activationMode?: ChannelActivationMode;
  chatType?: string | null;
}

export interface UpdateChannelBindingInput {
  spaceId?: string;
  activationMode?: ChannelActivationMode;
  chatType?: string | null;
}

export interface ChannelInboxItem {
  id: string;
  userId: string;
  accountId: string;
  nativeEventId: string;
  nativeContextId: string;
  payloadJson: string;
  status: ChannelInboxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelInboxInput {
  id?: string;
  userId: string;
  accountId: string;
  nativeEventId: string;
  nativeContextId: string;
  payloadJson: string;
  status?: ChannelInboxStatus;
}

export interface ChannelOutboxItem {
  id: string;
  userId: string;
  accountId: string;
  sessionId: string;
  nativeContextId: string;
  replyToNativeId?: string | null;
  payloadJson: string;
  status: ChannelOutboxStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChannelOutboxInput {
  id?: string;
  userId: string;
  accountId: string;
  sessionId: string;
  nativeContextId: string;
  replyToNativeId?: string | null;
  payloadJson: string;
  status?: ChannelOutboxStatus;
}

export interface TenantScopedChannelRepository {
  readonly userId: string;

  // Account operations
  listAccounts(type?: string): Promise<ChannelAccount[]>;
  findAccountById(id: string): Promise<ChannelAccount | null>;
  createAccount(input: Omit<CreateChannelAccountInput, 'userId'>): Promise<ChannelAccount>;
  updateAccount(id: string, input: UpdateChannelAccountInput): Promise<ChannelAccount>;
  deleteAccount(id: string): Promise<boolean>;

  // Binding operations
  listBindings(accountId?: string): Promise<ChannelBinding[]>;
  findBindingById(id: string): Promise<ChannelBinding | null>;
  findBindingByContext(accountId: string, nativeContextId: string): Promise<ChannelBinding | null>;
  createBinding(input: Omit<CreateChannelBindingInput, 'userId'>): Promise<ChannelBinding>;
  updateBinding(id: string, input: UpdateChannelBindingInput): Promise<ChannelBinding>;
  setGroupActivationModeForAccountBindings(accountId: string, mode: ChannelActivationMode): Promise<number>;
  deleteBinding(id: string): Promise<boolean>;

  // Inbox operations (idempotent inbound event ingestion)
  findInboxByEvent(accountId: string, nativeEventId: string): Promise<ChannelInboxItem | null>;
  createInboxItem(input: Omit<CreateChannelInboxInput, 'userId'>): Promise<{ item: ChannelInboxItem; isDuplicate: boolean }>;
  updateInboxStatus(id: string, status: ChannelInboxStatus): Promise<ChannelInboxItem>;
  claimInboxForProcessing(id: string): Promise<ChannelInboxItem | null>;
  listHeldInbox(limit?: number, accountId?: string): Promise<ChannelInboxItem[]>;

  // Outbox operations (durable outbound reply pipeline)
  createOutboxItem(input: Omit<CreateChannelOutboxInput, 'userId'>): Promise<ChannelOutboxItem>;
  findOutboxById(id: string): Promise<ChannelOutboxItem | null>;
  listPendingOutbox(limit?: number, accountId?: string): Promise<ChannelOutboxItem[]>;
  claimPendingOutboxItem(id: string, accountId?: string): Promise<ChannelOutboxItem | null>;
  updateOutboxStatus(id: string, status: ChannelOutboxStatus, incrementAttempt?: boolean): Promise<ChannelOutboxItem>;
  recoverStaleSendingOutbox(staleAfterSeconds?: number, accountId?: string): Promise<number>;
}

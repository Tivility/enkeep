export type SpaceMountMode = 'ro' | 'rw';

/**
 * Persisted Space Mount entity in database (space_mounts table).
 * Stores encrypted source path and keyed HMAC fingerprint.
 */
export interface SpaceMount {
  readonly id: string;
  readonly userId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly sourcePathEncrypted: string;
  readonly sourceFingerprint: string;
  readonly mode: SpaceMountMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Input for creating a new space mount in database.
 */
export interface CreateSpaceMountInput {
  readonly id?: string;
  readonly userId?: string;
  readonly spaceId: string;
  readonly name: string;
  readonly sourcePathEncrypted: string;
  readonly sourceFingerprint: string;
  readonly mode: SpaceMountMode;
}

/**
 * Public/Admin DTO for Space Mount (decrypted sourcePath).
 * Never contains ciphertext or internal database details.
 */
export interface PublicSpaceMount {
  readonly id: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly mode: SpaceMountMode;
  readonly createdAt: string;
}

export type SpaceMountDto = PublicSpaceMount;

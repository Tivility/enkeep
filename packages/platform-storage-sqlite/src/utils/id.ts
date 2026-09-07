import { randomBytes, createHash } from 'node:crypto';
import { ValidationError } from '@enkeep/platform-core';

export const SPACE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const GENERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const PROFILE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const SNAPSHOT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export const PROMPT_HASH_PATTERN = /^[0-9a-f]{64}$/;
export const SPACE_FOLDER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function generateSpaceId(): string {
  return `spc_${randomBytes(16).toString('hex')}`;
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export function generateSessionId(): string {
  return `ses_${randomBytes(16).toString('hex')}`;
}

export function generateGenerationId(): string {
  return `gen_${randomBytes(16).toString('hex')}`;
}

export function generateProfileId(): string {
  return `prof_${randomBytes(16).toString('hex')}`;
}

export function generateSnapshotId(): string {
  return `snap_${randomBytes(16).toString('hex')}`;
}

export function validateSpaceId(id: string): string {
  if (typeof id !== 'string' || !SPACE_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid space ID');
  }
  return id;
}

export function isValidSpaceId(id: string): boolean {
  return typeof id === 'string' && SPACE_ID_PATTERN.test(id);
}

export function validateSessionId(id: string): string {
  if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid session ID');
  }
  return id;
}

export function isValidSessionId(id: string): boolean {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

export function validateGenerationId(id: string): string {
  if (typeof id !== 'string' || !GENERATION_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid generation ID');
  }
  return id;
}

export function isValidGenerationId(id: string): boolean {
  return typeof id === 'string' && GENERATION_ID_PATTERN.test(id);
}

export function validateProfileId(id: string): string {
  if (typeof id !== 'string' || !PROFILE_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid profile ID');
  }
  return id;
}

export function isValidProfileId(id: string): boolean {
  return typeof id === 'string' && PROFILE_ID_PATTERN.test(id);
}

export function validateSnapshotId(id: string): string {
  if (typeof id !== 'string' || !SNAPSHOT_ID_PATTERN.test(id)) {
    throw new ValidationError('Invalid snapshot ID');
  }
  return id;
}

export function isValidSnapshotId(id: string): boolean {
  return typeof id === 'string' && SNAPSHOT_ID_PATTERN.test(id);
}

export function validatePromptHash(hash: string): string {
  if (typeof hash !== 'string' || !PROMPT_HASH_PATTERN.test(hash)) {
    throw new ValidationError('Invalid prompt hash');
  }
  return hash;
}

export function validateSpaceFolder(folder: string): string {
  if (typeof folder !== 'string' || !SPACE_FOLDER_PATTERN.test(folder)) {
    throw new ValidationError('Invalid space folder format');
  }
  return folder;
}

export function isValidSpaceFolder(folder: string): boolean {
  return typeof folder === 'string' && SPACE_FOLDER_PATTERN.test(folder);
}

export function computeSnapshotPromptHash(sections: {
  agents: string;
  identity: string;
  soul: string;
  tools: string;
}): string {
  const canonicalObj = {
    agents: sections.agents,
    identity: sections.identity,
    soul: sections.soul,
    tools: sections.tools,
  };
  const keys = Object.keys(canonicalObj).sort() as Array<keyof typeof canonicalObj>;
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(canonicalObj[k])}`);
  const canonicalJson = `{${pairs.join(',')}}`;
  const hash = createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  return validatePromptHash(hash);
}

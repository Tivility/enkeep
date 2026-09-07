/**
 * Portions of this file are derived from botmux (https://github.com/botmux/botmux)
 * Copyright (c) 2026 botmux contributors
 * Licensed under the MIT License.
 *
 * Fail-closed online visibility parser for Feishu Open Platform applications.
 *
 * @module @enkeep/channel-lark/onboarding/visibility
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

const MEMBER_ID_KEYS = ['id', 'openId', 'open_id', 'userId', 'user_id', 'memberId', 'member_id'];
const DEPARTMENT_ID_KEYS = ['id', 'departmentId', 'department_id', 'openDepartmentId', 'open_department_id'];
const GROUP_ID_KEYS = ['id', 'groupId', 'group_id', 'chatId', 'chat_id', 'openChatId', 'open_chat_id'];

export class VisibilityParseError extends Error {
  constructor(readonly collection: string) {
    super(`visible/online ${collection} format unrecognized; aborted to prevent resetting application visibility`);
  }
}

function pickIdByKeys(item: unknown, keys: string[]): string {
  if (typeof item === 'string') return item;
  if (typeof item === 'number' && Number.isFinite(item)) return String(item);
  const rec = asRecord(item);
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function idList(value: unknown, keys: string[], collection: string): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => pickIdByKeys(item, keys)).filter(Boolean);
  if (ids.length < value.length) throw new VisibilityParseError(collection);
  return ids;
}

function idListStrict(rec: Record<string, unknown>, key: string, keys: string[], label: string): string[] {
  if (!(key in rec)) return [];
  const value = rec[key];
  if (!Array.isArray(value)) throw new VisibilityParseError(`${label}.${key}`);
  return idList(value, keys, `${label}.${key}`);
}

export type VisibilitySuggest = {
  departments: string[];
  members: string[];
  groups: string[];
  isAll: number;
};

export const EMPTY_VISIBILITY: VisibilitySuggest = {
  departments: [],
  members: [],
  groups: [],
  isAll: 0,
};

function visibilityBlock(
  raw: unknown,
  label: string,
  requiredKeys: readonly string[]
): VisibilitySuggest {
  if (!isPlainRecord(raw)) throw new VisibilityParseError(label);
  for (const key of requiredKeys) {
    if (!(key in raw)) throw new VisibilityParseError(`${label}.${key}(missing)`);
  }
  const isAllRaw = raw.isAll;
  if (isAllRaw !== 0 && isAllRaw !== 1 && isAllRaw !== false && isAllRaw !== true) {
    throw new VisibilityParseError(`${label}.isAll`);
  }
  return {
    departments: idListStrict(raw, 'departments', DEPARTMENT_ID_KEYS, label),
    members: idListStrict(raw, 'members', MEMBER_ID_KEYS, label),
    groups: idListStrict(raw, 'groups', GROUP_ID_KEYS, label),
    isAll: isAllRaw === 1 || isAllRaw === true ? 1 : 0,
  };
}

const BLOCK_REQUIRED_KEYS = ['departments', 'groups', 'members', 'isAll'] as const;
const LEGACY_TOP_REQUIRED_KEYS = ['departments', 'members', 'isAll'] as const;

export function parseOnlineVisibility(payload: unknown): {
  visibleSuggest: VisibilitySuggest;
  blackVisibleSuggest: VisibilitySuggest;
} {
  const data = asRecord(payload).data;
  if (!isPlainRecord(data)) throw new VisibilityParseError('data');
  if ('whiteList' in data) {
    return {
      visibleSuggest: visibilityBlock(data.whiteList, 'whiteList', BLOCK_REQUIRED_KEYS),
      blackVisibleSuggest: visibilityBlock(data.blackList, 'blackList', BLOCK_REQUIRED_KEYS),
    };
  }
  return {
    visibleSuggest: visibilityBlock(data, 'whiteList', LEGACY_TOP_REQUIRED_KEYS),
    blackVisibleSuggest:
      data.blackList == null
        ? { ...EMPTY_VISIBILITY }
        : visibilityBlock(data.blackList, 'blackList', BLOCK_REQUIRED_KEYS),
  };
}

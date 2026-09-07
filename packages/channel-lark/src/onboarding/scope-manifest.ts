/**
 * Portions of this file are derived from botmux (https://github.com/botmux/botmux)
 * Copyright (c) 2026 botmux contributors
 * Licensed under the MIT License.
 *
 * Lark / Feishu Open Platform scope manifest and mapping utilities.
 * User-authorized comprehensive scopes list for tenant and user buckets.
 *
 * @module @enkeep/channel-lark/onboarding/scope-manifest
 */

import type {
  ScopeManifest,
  OpenPlatformScopeEntry,
  MappedScopeIds,
} from './types.js';

export const BUNDLED_LARK_SCOPES: ScopeManifest = {
  scopes: {
    tenant: [
      'ai:llpp:task_execute',
      'application:application:self_manage',
      'application:bot.menu:write',
      'audio_video_ai:meeting_assistance',
      'auth:user_access_token:read',
      'board:whiteboard:node:create',
      'board:whiteboard:node:delete',
      'board:whiteboard:node:read',
      'board:whiteboard:node:update',
      'calendar:calendar.acl:create',
      'calendar:calendar.acl:delete',
      'calendar:calendar.acl:read',
      'calendar:calendar.event:create',
      'calendar:calendar.event:delete',
      'calendar:calendar.event:read',
      'calendar:calendar.event:reply',
      'calendar:calendar.event:update',
      'calendar:calendar.free_busy:read',
      'calendar:calendar:create',
      'calendar:calendar:delete',
      'calendar:calendar:read',
      'calendar:calendar:subscribe',
      'calendar:calendar:update',
      'cardkit:card:read',
      'cardkit:card:write',
      'comment_sdk:comment_sdk',
      'component:url_preview',
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
      'contact:user.email:readonly',
      'contact:user.employee_id:readonly',
      'contact:user.id:readonly',
      'directory:employee.base.external_id:read',
      'directory:employee.work.job_number:read',
      'directory:job_title.status:read',
      'docs:document.comment:create',
      'docs:document.comment:delete',
      'docs:document.comment:read',
      'docs:document.comment:update',
      'docs:document.comment:write_only',
      'docs:document.content:read',
      'docs:document.media:download',
      'docs:document.media:upload',
      'docs:document.subscription',
      'docs:document.subscription:read',
      'docs:document:copy',
      'docs:document:export',
      'docs:document:import',
      'docs:event.document_deleted:read',
      'docs:event.document_edited:read',
      'docs:event.document_opened:read',
      'docs:event:subscribe',
      'docs:permission.member:auth',
      'docs:permission.member:create',
      'docs:permission.member:delete',
      'docs:permission.member:retrieve',
      'docs:permission.member:transfer',
      'docs:permission.member:update',
      'docs:permission.setting:read',
      'docs:permission.setting:readonly',
      'docs:permission.setting:write_only',
      'docs_tool:docs_tool',
      'document_ai:document:chunking',
      'document_ai:kie:llm',
      'docx:document.block:convert',
      'docx:document:create',
      'docx:document:readonly',
      'docx:document:write_only',
      'drive:drive.metadata:readonly',
      'drive:drive.search:readonly',
      'drive:drive:version',
      'drive:drive:version:readonly',
      'drive:file.like:readonly',
      'drive:file.meta.sec_label.read_only',
      'drive:file:download',
      'drive:file:favorite',
      'drive:file:favorite:readonly',
      'drive:file:upload',
      'drive:file:view_record:readonly',
      'event:failed_event:readonly',
      'event:ip_list',
      'im:app_feed_card:write',
      'im:biz_entity_tag_relation:write',
      'im:chat.access_event.bot_p2p_chat:read',
      'im:chat.announcement:read',
      'im:chat.announcement:write_only',
      'im:chat.chat_pins:read',
      'im:chat.chat_pins:write_only',
      'im:chat.collab_plugins:read',
      'im:chat.collab_plugins:write_only',
      'im:chat.managers:write_only',
      'im:chat.members:bot_access',
      'im:chat.members:read',
      'im:chat.members:write_only',
      'im:chat.menu_tree:read',
      'im:chat.menu_tree:write_only',
      'im:chat.moderation:read',
      'im:chat.tabs:read',
      'im:chat.tabs:write_only',
      'im:chat.top_notice:write_only',
      'im:chat.widgets:read',
      'im:chat.widgets:write_only',
      'im:chat:create',
      'im:chat:delete',
      'im:chat:moderation:write_only',
      'im:chat:operate_as_owner',
      'im:chat:read',
      'im:chat:update',
      'im:message',
      'im:message.group_at_msg.include_bot:readonly',
      'im:message.group_at_msg:readonly',
      'im:message.group_msg',
      'im:message.group_msg.include_bot:read',
      'im:message.p2p_msg:readonly',
      'im:message.pins:read',
      'im:message.pins:write_only',
      'im:message.reactions:read',
      'im:message.reactions:write_only',
      'im:message:readonly',
      'im:message:recall',
      'im:message:send_as_bot',
      'im:message:send_multi_depts',
      'im:message:send_multi_users',
      'im:message:send_sys_msg',
      'im:message:update',
      'im:resource',
      'im:tag:write',
      'im:url_preview.update',
      'im:user_agent:read',
      'optical_char_recognition:image',
      'sheets:spreadsheet.meta:read',
      'sheets:spreadsheet.meta:write_only',
      'sheets:spreadsheet:create',
      'sheets:spreadsheet:read',
      'sheets:spreadsheet:write_only',
      'slides:presentation:create',
      'slides:presentation:read',
      'slides:presentation:update',
      'slides:presentation:write_only',
      'space:document.event:read',
      'space:document:create',
      'space:document:delete',
      'space:document:move',
      'space:document:retrieve',
      'space:document:shortcut',
      'space:folder:create',
      'speech_to_text:speech',
      'task:task:read',
      'task:task:write',
      'task:tasklist:read',
      'task:tasklist:write',
      'translation:text',
      'vc:meeting.bot.join:write',
      'vc:meeting.bot.realtime:write',
      'vc:meeting.meetingevent:read',
      'vc:meeting.message:write',
      'wiki:member:create',
      'wiki:member:retrieve',
      'wiki:member:update',
      'wiki:node:copy',
      'wiki:node:create',
      'wiki:node:move',
      'wiki:node:read',
      'wiki:node:retrieve',
      'wiki:node:update',
      'wiki:setting:read',
      'wiki:setting:write_only',
      'wiki:space:read',
      'wiki:space:retrieve',
      'wiki:space:write_only',
      'wiki:wiki:readonly',
    ],
    user: [
      'board:whiteboard:node:create',
      'board:whiteboard:node:delete',
      'board:whiteboard:node:read',
      'board:whiteboard:node:update',
      'calendar:calendar.acl:create',
      'calendar:calendar.acl:delete',
      'calendar:calendar.acl:read',
      'calendar:calendar.event:create',
      'calendar:calendar.event:delete',
      'calendar:calendar.event:read',
      'calendar:calendar.event:reply',
      'calendar:calendar.event:update',
      'calendar:calendar.free_busy:read',
      'calendar:calendar:create',
      'calendar:calendar:delete',
      'calendar:calendar:read',
      'calendar:calendar:subscribe',
      'calendar:calendar:update',
      'comment_sdk:comment_sdk',
      'contact:contact.base:readonly',
      'contact:user.employee_id:readonly',
      'docs:component',
      'docs:document.comment:create',
      'docs:document.comment:read',
      'docs:document.comment:update',
      'docs:document.comment:write_only',
      'docs:document.content:read',
      'docs:document.media:download',
      'docs:document.media:upload',
      'docs:document.subscription',
      'docs:document.subscription:read',
      'docs:document:copy',
      'docs:document:export',
      'docs:document:import',
      'docs:event.document_deleted:read',
      'docs:event.document_edited:read',
      'docs:event.document_opened:read',
      'docs:event:subscribe',
      'docs:permission.member:apply',
      'docs:permission.member:auth',
      'docs:permission.member:create',
      'docs:permission.member:delete',
      'docs:permission.member:retrieve',
      'docs:permission.member:transfer',
      'docs:permission.member:update',
      'docs:permission.setting:read',
      'docs:permission.setting:readonly',
      'docs:permission.setting:write_only',
      'docs_tool:docs_tool',
      'docx:document.block:convert',
      'docx:document:create',
      'docx:document:readonly',
      'docx:document:write_only',
      'drive:drive.metadata:readonly',
      'drive:drive.search:readonly',
      'drive:drive:version',
      'drive:drive:version:readonly',
      'drive:file.like:readonly',
      'drive:file.meta.sec_label.read_only',
      'drive:file:download',
      'drive:file:favorite',
      'drive:file:favorite:readonly',
      'drive:file:upload',
      'drive:file:view_record:readonly',
      'event:ip_list',
      'im:chat.access_event.bot_p2p_chat:read',
      'im:chat.announcement:read',
      'im:chat.announcement:write_only',
      'im:chat.chat_pins:read',
      'im:chat.chat_pins:write_only',
      'im:chat.collab_plugins:read',
      'im:chat.collab_plugins:write_only',
      'im:chat.managers:write_only',
      'im:chat.members:read',
      'im:chat.members:write_only',
      'im:chat.moderation:read',
      'im:chat.tabs:read',
      'im:chat.tabs:write_only',
      'im:chat.top_notice:write_only',
      'im:chat:delete',
      'im:chat:moderation:write_only',
      'im:chat:read',
      'im:chat:update',
      'im:feed_group_v1:read',
      'im:feed_group_v1:write',
      'im:message',
      'im:message.pins:read',
      'im:message.pins:write_only',
      'im:message.reactions:read',
      'im:message.reactions:write_only',
      'im:message.urgent.status:write',
      'im:message:readonly',
      'im:message:recall',
      'im:message:update',
      'im:special_focus',
      'offline_access',
      'search:docs:read',
      'search:message',
      'sheets:spreadsheet.meta:read',
      'sheets:spreadsheet.meta:write_only',
      'sheets:spreadsheet:create',
      'sheets:spreadsheet:read',
      'sheets:spreadsheet:write_only',
      'slides:presentation:create',
      'slides:presentation:read',
      'slides:presentation:update',
      'slides:presentation:write_only',
      'space:document.event:read',
      'space:document:create',
      'space:document:delete',
      'space:document:move',
      'space:document:retrieve',
      'space:document:shortcut',
      'space:folder:create',
      'vc:meeting.meetingevent:read',
      'wiki:member:create',
      'wiki:member:retrieve',
      'wiki:member:update',
      'wiki:node:copy',
      'wiki:node:create',
      'wiki:node:move',
      'wiki:node:read',
      'wiki:node:retrieve',
      'wiki:node:update',
      'wiki:setting:read',
      'wiki:setting:write_only',
      'wiki:space:read',
      'wiki:space:retrieve',
      'wiki:space:write_only',
      'wiki:wiki:readonly',
    ],
  },
};

export function getDefaultScopeManifest(): ScopeManifest {
  return structuredClone(BUNDLED_LARK_SCOPES);
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function collectScopeEntries(
  value: unknown,
  bucket: 'tenant' | 'user' | undefined,
  out: OpenPlatformScopeEntry[]
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const name =
    (record.scope_name as string) ||
    (record.scopeName as string) ||
    (record.name as string) ||
    (record.key as string) ||
    (record.scopeKey as string);
  const id =
    (record.id as string) ||
    (record.scope_id as string) ||
    (record.scopeId as string) ||
    (record.scopeID as string);
  if (name && id) {
    out.push({ name: String(name), id: String(id), bucket });
  }
  for (const [key, child] of Object.entries(record)) {
    const nextBucket = /user/i.test(key)
      ? 'user'
      : /app|client|tenant/i.test(key)
        ? 'tenant'
        : bucket;
    if (child && typeof child === 'object') collectScopeEntries(child, nextBucket, out);
  }
}

export function extractOpenPlatformScopeEntries(payload: unknown): OpenPlatformScopeEntry[] {
  const out: OpenPlatformScopeEntry[] = [];
  collectScopeEntries(payload, undefined, out);
  return out;
}

function mapScopeIds(
  scopeNames: string[],
  catalog: OpenPlatformScopeEntry[],
  bucket: 'tenant' | 'user'
): { ids: string[]; missing: string[] } {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const scopeName of scopeNames) {
    const matched =
      catalog.find((entry) => entry.name === scopeName && entry.bucket === bucket) ??
      catalog.find((entry) => entry.name === scopeName && entry.bucket === undefined) ??
      catalog.find((entry) => entry.name === scopeName);
    if (matched) {
      ids.push(matched.id);
    } else {
      missing.push(scopeName);
    }
  }
  return { ids: uniqueStrings(ids), missing: uniqueStrings(missing) };
}

export function mapManifestScopesToOpenPlatformIds(
  manifest: ScopeManifest,
  catalog: OpenPlatformScopeEntry[]
): MappedScopeIds {
  const tenant = mapScopeIds(manifest.scopes?.tenant ?? [], catalog, 'tenant');
  const user = mapScopeIds(manifest.scopes?.user ?? [], catalog, 'user');
  return {
    tenantScopeIds: tenant.ids,
    userScopeIds: user.ids,
    missingTenantScopes: tenant.missing,
    missingUserScopes: user.missing,
  };
}

export function buildScopeUpdatePayload(
  appId: string,
  mapped: Pick<MappedScopeIds, 'tenantScopeIds' | 'userScopeIds'>
) {
  return {
    clientId: appId,
    appScopeIDs: mapped.tenantScopeIds,
    userScopeIDs: mapped.userScopeIds,
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  };
}

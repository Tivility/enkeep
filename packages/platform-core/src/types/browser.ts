/**
 * Browser Service Port Types and Interfaces
 *
 * Defines the core contract for the isolated, hardened browser execution service:
 * - Session context mapping: { userId, spaceId, sessionId }
 * - Deterministic accessibility-like DOM snapshot (e1... refs, max 1000 nodes / 256KB)
 * - Safe interactions (click | fill | press | select) by ref ONLY (no arbitrary JS/CSS)
 * - Screenshot capture (caller persisted)
 * - Strict lifecycle and cleanup
 *
 * @module @enkeep/platform-core/types/browser
 */

export interface BrowserSessionKey {
  readonly userId: string;
  readonly spaceId: string;
  readonly sessionId: string;
}

export interface BrowserOpenOptions {
  readonly sessionKey: BrowserSessionKey;
  readonly url: string;
  readonly timeoutMs?: number;
}

export interface BrowserOpenResult {
  readonly pageId: string;
  readonly title: string;
  readonly url: string;
}

export interface BrowserSnapshotNode {
  readonly ref: string;
  readonly tag: string;
  readonly role?: string;
  readonly name?: string;
  readonly value?: string;
  readonly type?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly href?: string;
  readonly children?: readonly BrowserSnapshotNode[];
}

export interface BrowserSnapshotOptions {
  readonly sessionKey: BrowserSessionKey;
  readonly pageId: string;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

export interface BrowserSnapshotResult {
  readonly pageId: string;
  readonly url: string;
  readonly title: string;
  readonly root: BrowserSnapshotNode;
  readonly nodeCount: number;
  readonly truncated: boolean;
  readonly textSummary?: string;
}

export type BrowserInteractAction = 'click' | 'fill' | 'press' | 'select';

export interface BrowserInteractOptions {
  readonly sessionKey: BrowserSessionKey;
  readonly pageId: string;
  readonly action: BrowserInteractAction;
  readonly ref: string;
  readonly value?: string;
  readonly key?: string;
  readonly timeoutMs?: number;
}

export interface BrowserInteractResult {
  readonly pageId: string;
  readonly ref: string;
  readonly action: BrowserInteractAction;
  readonly success: boolean;
  readonly message?: string;
  readonly navigationOccurred?: boolean;
  readonly currentUrl: string;
}

export interface BrowserScreenshotDimensions {
  readonly width: number;
  readonly height: number;
}

export interface BrowserScreenshotOptions {
  readonly sessionKey: BrowserSessionKey;
  readonly pageId: string;
  readonly fullPage?: boolean;
  readonly timeoutMs?: number;
}

export interface BrowserScreenshotResult {
  readonly pageId: string;
  readonly mimeType: 'image/png';
  readonly dimensions: BrowserScreenshotDimensions;
  readonly buffer: Buffer;
}

export interface BrowserCloseOptions {
  readonly sessionKey?: BrowserSessionKey;
  readonly pageId?: string;
  readonly all?: boolean;
}

export interface BrowserCloseResult {
  readonly closedPages: number;
  readonly closedContexts: number;
}

export interface BrowserServiceHealth {
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly activeContexts: number;
  readonly activePages: number;
  readonly workerPid?: number;
  readonly uptimeSeconds: number;
}

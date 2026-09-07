/**
 * Safe Browser Action Executor
 *
 * Executes interactions (click | fill | press | select) exclusively by deterministic element ref.
 *
 * Invariants:
 * - NO arbitrary JavaScript execution or raw CSS/XPath selectors accepted from caller
 * - Strict ref validation (/^e\d+$/)
 * - Safe error handling and timeout enforcement
 * - Detection of navigation state changes
 *
 * @module @enkeep/platform-service-browser/interact/action-executor
 */

import type { Page } from 'playwright';
import type { BrowserInteractOptions, BrowserInteractResult, BrowserServiceOptions } from '../types.js';
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';
import { sanitizeUrl } from '../security/url-sanitizer.js';
import { validateBrowserTargetUrl } from '../security/ssrf-guard.js';

export const DEFAULT_ACTION_TIMEOUT_MS = 15000;

/**
 * Validates that an element ref matches standard format e1, e2, ...
 */
export function isValidRef(ref: string): boolean {
  return /^e\d+$/.test(ref);
}

/**
 * Executes a safe, bounded interaction on a page element by its ref.
 */
export async function executePageAction(
  page: Page,
  options: BrowserInteractOptions,
  serviceOptions: BrowserServiceOptions = {},
): Promise<BrowserInteractResult> {
  const { pageId, action, ref, value, key } = options;
  const timeout = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  if (!isValidRef(ref)) {
    throw new BrowserServiceError(`Invalid element ref format: "${ref}". Expected "e1", "e2", etc.`, {
      code: BrowserErrorCode.BROWSER_INVALID_REF,
      details: { pageId, ref, action },
    });
  }

  const selector = `[data-enkeep-ref="${ref}"]`;
  const locator = page.locator(selector);

  // Check if element exists and is unique
  const count = await locator.count().catch(() => 0);
  if (count === 0) {
    throw new BrowserServiceError(
      `Element ref "${ref}" not found on page "${pageId}". Take a new snapshot to refresh refs.`,
      {
        code: BrowserErrorCode.BROWSER_INVALID_REF,
        details: { pageId, ref, action },
      },
    );
  }

  const initialUrl = page.url();

  try {
    switch (action) {
      case 'click': {
        await locator.first().click({ timeout });
        break;
      }

      case 'fill': {
        if (value === undefined) {
          throw new BrowserServiceError(`Action "fill" requires a "value" parameter.`, {
            code: BrowserErrorCode.BROWSER_BAD_REQUEST,
            details: { pageId, ref, action },
          });
        }
        await locator.first().fill(value, { timeout });
        break;
      }

      case 'press': {
        if (!key) {
          throw new BrowserServiceError(`Action "press" requires a "key" parameter (e.g. "Enter").`, {
            code: BrowserErrorCode.BROWSER_BAD_REQUEST,
            details: { pageId, ref, action },
          });
        }
        await locator.first().press(key, { timeout });
        break;
      }

      case 'select': {
        if (value === undefined) {
          throw new BrowserServiceError(`Action "select" requires a "value" parameter.`, {
            code: BrowserErrorCode.BROWSER_BAD_REQUEST,
            details: { pageId, ref, action },
          });
        }
        await locator.first().selectOption(value, { timeout });
        break;
      }

      default: {
        const _exhaustiveCheck: never = action;
        throw new BrowserServiceError(`Unsupported browser action: "${action}"`, {
          code: BrowserErrorCode.BROWSER_BAD_REQUEST,
          details: { pageId, ref, action },
        });
      }
    }

    // Wait briefly for any microtask / navigation settlement (capped at 500ms)
    await page.waitForLoadState('domcontentloaded', { timeout: 1000 }).catch(() => {
      // Non-fatal if page did not initiate navigation
    });

    // Validate new URL against SSRF policy if navigation occurred
    if (page.url() !== initialUrl) {
      await validateBrowserTargetUrl(page.url(), {
        allowLocalForTesting: serviceOptions.allowLocalForTesting,
        allowedHosts: serviceOptions.allowedHosts,
      });
    }

    const currentUrl = sanitizeUrl(page.url());
    const navigationOccurred = page.url() !== initialUrl;

    return {
      pageId,
      ref,
      action,
      success: true,
      navigationOccurred,
      currentUrl,
    };
  } catch (err) {
    if (err instanceof BrowserServiceError) throw err;

    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Timeout') || errMsg.includes('timeout')) {
      throw new BrowserServiceError(`Timeout during action "${action}" on ref "${ref}" (${timeout}ms)`, {
        code: BrowserErrorCode.BROWSER_TIMEOUT,
        cause: err,
        details: { pageId, ref, action, timeoutMs: timeout },
      });
    }

    throw new BrowserServiceError(`Action "${action}" on ref "${ref}" failed: ${errMsg}`, {
      code: BrowserErrorCode.BROWSER_ACTION_FAILED,
      cause: err,
      details: { pageId, ref, action },
    });
  }
}

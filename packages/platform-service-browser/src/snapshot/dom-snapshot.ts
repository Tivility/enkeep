/// <reference lib="dom" />
/**
 * Deterministic DOM Accessibility Snapshot Generator
 *
 * Traverses DOM tree inside Playwright page context and builds a deterministic
 * accessibility-like tree with element refs (e1, e2, ...).
 *
 * Invariants:
 * - NO raw full HTML dumping
 * - Deterministic sequential refs (e1, e2, ...) in document order
 * - Attaches safe data-enkeep-ref attribute to DOM nodes for fast, reliable interaction lookup
 * - Capped at max 1000 nodes and 256 KB JSON size
 * - Flags truncated: true if caps are exceeded
 * - Strictly typed element guards (no loose as any casts)
 *
 * @module @enkeep/platform-service-browser/snapshot/dom-snapshot
 */

import type { Page } from 'playwright';
import type { BrowserSnapshotNode, BrowserSnapshotOptions, BrowserSnapshotResult } from '../types.js';
import { BrowserErrorCode, BrowserServiceError } from '../errors.js';
import { sanitizeUrl } from '../security/url-sanitizer.js';

export const DEFAULT_MAX_SNAPSHOT_NODES = 1000;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 262144; // 256 KB

/**
 * Builds a text summary of the accessible tree for fast agent context ingestion.
 */
export function buildSnapshotTextSummary(node: BrowserSnapshotNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const parts: string[] = [];

  parts.push(`[${node.ref}]`);
  if (node.role) {
    parts.push(node.role);
  } else {
    parts.push(node.tag);
  }

  if (node.name) {
    parts.push(`"${node.name}"`);
  }

  if (node.value !== undefined && node.value !== '') {
    parts.push(`value="${node.value}"`);
  }

  if (node.placeholder) {
    parts.push(`placeholder="${node.placeholder}"`);
  }

  if (node.disabled) {
    parts.push('(disabled)');
  }

  if (node.checked) {
    parts.push('(checked)');
  }

  if (node.href) {
    parts.push(`href="${node.href}"`);
  }

  let line = `${indent}${parts.join(' ')}`;

  if (node.children && node.children.length > 0) {
    const childLines = node.children.map((c) => buildSnapshotTextSummary(c, depth + 1));
    return [line, ...childLines].join('\n');
  }

  return line;
}

/**
 * Takes a deterministic DOM snapshot of the current page.
 */
export async function takePageSnapshot(
  page: Page,
  options: BrowserSnapshotOptions,
): Promise<BrowserSnapshotResult> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_SNAPSHOT_NODES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;

  try {
    const evalResult = await page.evaluate(
      (opts: { maxNodes: number }) => {
        const maxLimit = opts.maxNodes || 1000;
        let refIndex = 1;
        let totalNodes = 0;
        let truncated = false;

        const IGNORED_TAGS = new Set([
          'SCRIPT',
          'STYLE',
          'NOSCRIPT',
          'IFRAME',
          'FRAME',
          'OBJECT',
          'EMBED',
          'TEMPLATE',
          'META',
          'HEAD',
          'TITLE',
          'LINK',
        ]);

        const INTERACTIVE_TAGS = new Set([
          'A',
          'BUTTON',
          'INPUT',
          'SELECT',
          'TEXTAREA',
          'DETAILS',
          'SUMMARY',
          'OPTION',
        ]);

        const SEMANTIC_TAGS = new Set([
          'H1',
          'H2',
          'H3',
          'H4',
          'H5',
          'H6',
          'P',
          'LI',
          'LABEL',
          'MAIN',
          'NAV',
          'HEADER',
          'FOOTER',
          'SECTION',
          'ARTICLE',
          'FORM',
          'TABLE',
          'TH',
          'TD',
          'IMG',
        ]);

        function isVisible(el: Element): boolean {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          if (el.getAttribute('aria-hidden') === 'true') {
            return false;
          }
          return true;
        }

        function getAccessibleRole(el: Element): string | undefined {
          const explicitRole = el.getAttribute('role');
          if (explicitRole) return explicitRole.toLowerCase().trim();

          const tag = el.tagName.toUpperCase();
          if (tag === 'A' && el.hasAttribute('href')) return 'link';
          if (tag === 'BUTTON') return 'button';
          if (tag === 'INPUT') {
            const inputEl = el instanceof HTMLInputElement ? el : null;
            const type = (inputEl?.type || el.getAttribute('type') || 'text').toLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            return 'textbox';
          }
          if (tag === 'SELECT') return 'combobox';
          if (tag === 'TEXTAREA') return 'textbox';
          if (tag.match(/^H[1-6]$/)) return 'heading';
          if (tag === 'IMG') return 'img';
          if (tag === 'NAV') return 'navigation';
          if (tag === 'MAIN') return 'main';
          if (tag === 'FORM') return 'form';
          return undefined;
        }

        function getAccessibleName(el: Element): string | undefined {
          const ariaLabel = el.getAttribute('aria-label');
          if (ariaLabel) return ariaLabel.trim();

          const ariaLabelledBy = el.getAttribute('aria-labelledby');
          if (ariaLabelledBy) {
            const labelEl = document.getElementById(ariaLabelledBy);
            if (labelEl && labelEl.textContent) return labelEl.textContent.trim();
          }

          const title = el.getAttribute('title');
          if (title) return title.trim();

          const alt = el.getAttribute('alt');
          if (alt) return alt.trim();

          const placeholder = el.getAttribute('placeholder');
          if (placeholder) return placeholder.trim();

          const tag = el.tagName.toUpperCase();
          if (INTERACTIVE_TAGS.has(tag) || tag.match(/^H[1-6]$/) || tag === 'LABEL' || tag === 'P') {
            let directText = '';
            for (let i = 0; i < el.childNodes.length; i++) {
              const child = el.childNodes[i];
              if (child && child.nodeType === Node.TEXT_NODE) {
                directText += child.textContent;
              }
            }
            const clean = directText.replace(/\s+/g, ' ').trim();
            if (clean) return clean;
          }

          return undefined;
        }

        function walkElement(el: Element): BrowserSnapshotNode | null {
          if (totalNodes >= maxLimit) {
            truncated = true;
            return null;
          }

          if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
          if (IGNORED_TAGS.has(el.tagName.toUpperCase())) return null;
          if (!isVisible(el)) return null;

          const tag = el.tagName.toLowerCase();
          const role = getAccessibleRole(el);
          const name = getAccessibleName(el);
          const isInteractive =
            INTERACTIVE_TAGS.has(el.tagName.toUpperCase()) ||
            role === 'button' ||
            role === 'link' ||
            role === 'checkbox' ||
            el.hasAttribute('onclick') ||
            el.hasAttribute('tabindex');
          const isSemantic = SEMANTIC_TAGS.has(el.tagName.toUpperCase()) || !!role;

          // Direct text
          let directText = '';
          for (let j = 0; j < el.childNodes.length; j++) {
            const childNode = el.childNodes[j];
            if (childNode && childNode.nodeType === Node.TEXT_NODE) {
              directText += childNode.textContent;
            }
          }
          directText = directText.replace(/\s+/g, ' ').trim();

          const shouldInclude = isInteractive || isSemantic || Boolean(directText);

          // Reserve slot for this element if it will be included
          let ref: string | undefined;
          if (shouldInclude) {
            if (totalNodes >= maxLimit) {
              truncated = true;
              return null;
            }
            ref = 'e' + refIndex++;
            el.setAttribute('data-enkeep-ref', ref);
            totalNodes++;
          }

          // Collect children
          const childNodes: BrowserSnapshotNode[] = [];
          for (let i = 0; i < el.children.length; i++) {
            if (totalNodes >= maxLimit) {
              truncated = true;
              break;
            }
            const childRes = walkElement(el.children[i] as Element);
            if (childRes) {
              childNodes.push(childRes);
            }
          }

          if (!shouldInclude && childNodes.length === 0) {
            return null;
          }

          // If container wasn't tagged but has children, tag it as structural container
          if (!ref) {
            if (totalNodes >= maxLimit) {
              truncated = true;
              return null;
            }
            ref = 'e' + refIndex++;
            el.setAttribute('data-enkeep-ref', ref);
            totalNodes++;
          }

          // Extract attributes safely using DOM element type checks
          let value: string | undefined;
          let inputType: string | undefined;
          let placeholder: string | undefined;
          let disabled = false;
          let checked = false;
          let href: string | undefined;

          if (el instanceof HTMLInputElement) {
            value = el.value ? el.value.slice(0, 200) : undefined;
            inputType = el.type || 'text';
            placeholder = el.placeholder || undefined;
            disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
            checked = el.checked || el.getAttribute('aria-checked') === 'true';
          } else if (el instanceof HTMLTextAreaElement) {
            value = el.value ? el.value.slice(0, 200) : undefined;
            placeholder = el.placeholder || undefined;
            disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
          } else if (el instanceof HTMLSelectElement) {
            value = el.value ? el.value.slice(0, 200) : undefined;
            disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
          } else if (el instanceof HTMLButtonElement) {
            disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
          } else if (el instanceof HTMLAnchorElement) {
            const rawHref = el.getAttribute('href');
            if (rawHref && !rawHref.startsWith('javascript:')) {
              href = rawHref;
            }
            disabled = el.getAttribute('aria-disabled') === 'true';
          } else {
            if (el.getAttribute('aria-disabled') === 'true') disabled = true;
            if (el.getAttribute('aria-checked') === 'true') checked = true;
            if (el.hasAttribute('placeholder')) placeholder = el.getAttribute('placeholder') || undefined;
          }

          const node: BrowserSnapshotNode = {
            ref,
            tag,
            role,
            name: name ? name.slice(0, 200) : directText ? directText.slice(0, 200) : undefined,
            value,
            type: inputType,
            placeholder,
            disabled: disabled || undefined,
            checked: checked || undefined,
            href,
            children: childNodes.length > 0 ? childNodes : undefined,
          };

          return node;
        }

        let rootNode = walkElement(document.body || document.documentElement);
        if (!rootNode) {
          rootNode = {
            ref: 'e0',
            tag: 'body',
            children: [],
          };
        }

        return {
          root: rootNode,
          totalNodes,
          truncated,
        };
      },
      { maxNodes },
    );

    const title = await page.title();
    const currentUrl = sanitizeUrl(page.url());

    let root: BrowserSnapshotNode = evalResult.root;
    let nodeCount: number = evalResult.totalNodes;
    let truncated: boolean = evalResult.truncated;

    // Check byte size cap
    let serialized = JSON.stringify(root);
    let byteLength = Buffer.byteLength(serialized, 'utf8');

    if (byteLength > maxBytes) {
      truncated = true;
      root = pruneNodeToByteCap(root, maxBytes);
    }

    const textSummary = buildSnapshotTextSummary(root);

    return {
      pageId: options.pageId,
      url: currentUrl,
      title: title || '',
      root,
      nodeCount,
      truncated,
      textSummary,
    };
  } catch (err) {
    if (err instanceof BrowserServiceError) throw err;
    throw new BrowserServiceError(`Failed to generate DOM snapshot for page "${options.pageId}"`, {
      code: BrowserErrorCode.BROWSER_INTERNAL_ERROR,
      cause: err,
      details: { pageId: options.pageId },
    });
  }
}

/**
 * Prunes a snapshot tree iteratively to stay within byte cap.
 */
function pruneNodeToByteCap(node: BrowserSnapshotNode, maxBytes: number): BrowserSnapshotNode {
  const shallowCopy: BrowserSnapshotNode = {
    ref: node.ref,
    tag: node.tag,
    role: node.role,
    name: node.name,
    value: node.value,
    placeholder: node.placeholder,
    disabled: node.disabled,
    checked: node.checked,
    href: node.href,
  };

  if (!node.children || node.children.length === 0) {
    return shallowCopy;
  }

  const prunedChildren: BrowserSnapshotNode[] = [];
  for (const child of node.children) {
    prunedChildren.push(pruneNodeToByteCap(child, maxBytes));
    const testResult = { ...shallowCopy, children: prunedChildren };
    if (Buffer.byteLength(JSON.stringify(testResult), 'utf8') > maxBytes) {
      prunedChildren.pop();
      break;
    }
  }

  return { ...shallowCopy, children: prunedChildren };
}

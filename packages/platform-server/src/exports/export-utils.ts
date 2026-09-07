/**
 * Audit & Usage Export Utilities
 *
 * Provides CSV injection neutralization, true streaming with backpressure,
 * and RFC 4180 CSV serialization.
 *
 * @module @enkeep/platform-server/exports
 */

import { Readable } from 'node:stream';
import type { ServerResponse, IncomingMessage } from 'node:http';

const CSV_INJECTION_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralizes potential CSV formula injection in cell values.
 * If a value starts with =, +, -, @, \t, or \r, it is prefixed with a single quote '.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let str = String(value);

  // Check for leading formula characters
  if (str.length > 0 && CSV_INJECTION_PREFIXES.includes(str[0])) {
    str = `'${str}`;
  }

  // RFC 4180 escaping: if contains comma, quote, or newline, escape quotes and wrap in quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function formatCsvRow(fields: unknown[]): string {
  return fields.map(sanitizeCsvCell).join(',') + '\r\n';
}

/**
 * Streams chunks of strings to ServerResponse handling backpressure and client abort.
 */
export async function streamDataToResponse(
  req: IncomingMessage,
  res: ServerResponse,
  headers: Record<string, string>,
  generator: AsyncGenerator<string, void, unknown>
): Promise<void> {
  // Set headers
  for (const [key, val] of Object.entries(headers)) {
    res.setHeader(key, val);
  }
  res.writeHead(200);

  let aborted = false;

  const onAbort = () => {
    aborted = true;
  };

  req.on('close', onAbort);
  req.on('aborted', onAbort);

  try {
    for await (const chunk of generator) {
      if (aborted || res.destroyed || res.writableEnded) {
        break;
      }

      const ok = res.write(chunk, 'utf8');
      if (!ok) {
        // Wait for drain event for true backpressure
        await new Promise<void>((resolve) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            resolve();
          };
          const cleanup = () => {
            res.removeListener('drain', onDrain);
            res.removeListener('close', onClose);
          };
          res.on('drain', onDrain);
          res.on('close', onClose);
        });
      }
    }

    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } finally {
    req.removeListener('close', onAbort);
    req.removeListener('aborted', onAbort);
  }
}

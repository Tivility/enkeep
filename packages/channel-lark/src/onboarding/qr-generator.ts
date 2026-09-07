/**
 * QR Code (Model 2) SVG and Data URL Generator based on the standard `qrcode` library.
 * Implements ISO/IEC 18004 QR specification supporting all versions (1 to 40),
 * byte mode, UTF-8 strings, and standard error correction levels (L, M, Q, H).
 * Generates clean local SVG markup and data URLs synchronously without external dependencies or CDN calls.
 *
 * @module @enkeep/channel-lark/onboarding/qr-generator
 */

import QRCode from 'qrcode';

export type QrEccLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrCodeOptions {
  /** Error correction level: 'L' (~7%), 'M' (~15%), 'Q' (~25%), 'H' (~30%). Defaults to 'M'. */
  eccLevel?: QrEccLevel;
  /** Margin in QR modules (quiet zone). Defaults to 4 (ISO standard >= 4). */
  margin?: number;
  /** Optional explicit rendered width and height in px for SVG attribute. */
  size?: number;
}

/**
 * 2D boolean matrix representing QR code modules.
 */
export class QrMatrix {
  public readonly size: number;
  public readonly modules: boolean[][];

  constructor(size: number, modules?: boolean[][]) {
    this.size = size;
    this.modules = modules ?? Array.from({ length: size }, () => Array(size).fill(false));
  }

  set(row: number, col: number, val: boolean): void {
    if (row >= 0 && row < this.size && col >= 0 && col < this.size) {
      this.modules[row][col] = val;
    }
  }

  get(row: number, col: number): boolean {
    return this.modules[row]?.[col] ?? false;
  }
}

/**
 * Generates a 2D QrMatrix representing QR code modules for the given text synchronously.
 * Throws an Error if text is empty, invalid, or overflows maximum QR Code capacity (Version 40).
 */
export function generateQrMatrix(text: string, options: QrCodeOptions = {}): QrMatrix {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }

  const ecc = options.eccLevel ?? 'M';
  const qr = QRCode.create(text, {
    errorCorrectionLevel: ecc,
  });

  const size = qr.modules.size;
  const data = qr.modules.data;
  const matrix = new QrMatrix(size);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (data[r * size + c] === 1) {
        matrix.set(r, c, true);
      }
    }
  }

  return matrix;
}

/**
 * Generates an SVG string representation of a QR code for the given text synchronously.
 * Default margin is 4 modules (ISO standard quiet zone >= 4).
 * Throws an Error if payload length overflows QR Code capacity.
 */
export function generateQrSvg(text: string, options: QrCodeOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }

  const ecc = options.eccLevel ?? 'M';
  const margin = options.margin !== undefined ? Math.max(0, options.margin) : 4;

  const qr = QRCode.create(text, {
    errorCorrectionLevel: ecc,
  });

  const modSize = qr.modules.size;
  const fullSize = modSize + margin * 2;
  const data = qr.modules.data;

  // Build compact path data using horizontal runs of dark modules
  let pathD = '';
  for (let r = 0; r < modSize; r++) {
    let startCol = -1;
    for (let c = 0; c < modSize; c++) {
      const isDark = data[r * modSize + c] === 1;
      if (isDark) {
        if (startCol === -1) {
          startCol = c;
        }
      } else {
        if (startCol !== -1) {
          const len = c - startCol;
          pathD += `M${startCol + margin} ${r + margin}h${len}v1h-${len}z `;
          startCol = -1;
        }
      }
    }
    if (startCol !== -1) {
      const len = modSize - startCol;
      pathD += `M${startCol + margin} ${r + margin}h${len}v1h-${len}z `;
    }
  }

  const dim = options.size ? ` width="${options.size}" height="${options.size}"` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fullSize} ${fullSize}"${dim} shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<path d="${pathD.trim()}" fill="#000000"/>` +
    `</svg>`;
}

/**
 * Generates a data URL (`data:image/svg+xml;utf8,...`) for embedding directly into `<img src="...">`.
 */
export function generateQrDataUrl(text: string, options: QrCodeOptions = {}): string {
  const svg = generateQrSvg(text, options);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

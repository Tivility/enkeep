import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import {
  generateQrSvg,
  generateQrDataUrl,
  generateQrMatrix,
  QrMatrix,
  type QrCodeOptions,
} from '../src/onboarding/qr-generator.js';

/**
 * Converts a QrMatrix into an RGBA pixel buffer for the jsQR decoder.
 */
function matrixToRgba(matrix: QrMatrix, margin: number = 4, scale: number = 4) {
  const fullSize = matrix.size + margin * 2;
  const pixelSize = fullSize * scale;
  const rgba = new Uint8ClampedArray(pixelSize * pixelSize * 4);
  rgba.fill(255); // White background

  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.get(r, c)) {
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const y = (r + margin) * scale + py;
            const x = (c + margin) * scale + px;
            const idx = (y * pixelSize + x) * 4;
            rgba[idx] = 0;
            rgba[idx + 1] = 0;
            rgba[idx + 2] = 0;
            rgba[idx + 3] = 255;
          }
        }
      }
    }
  }

  return { rgba, pixelSize };
}

/**
 * Rasterizes the generated SVG markup into an RGBA pixel buffer for the jsQR decoder.
 */
function rasterizeSvgToRgba(svgString: string, scale: number = 4) {
  const viewBoxMatch = svgString.match(/viewBox="0 0 (\d+) (\d+)"/);
  if (!viewBoxMatch) {
    throw new Error(`Invalid SVG viewBox in: ${svgString.slice(0, 100)}`);
  }

  const viewBoxWidth = parseInt(viewBoxMatch[1], 10);
  const viewBoxHeight = parseInt(viewBoxMatch[2], 10);
  const pixelWidth = viewBoxWidth * scale;
  const pixelHeight = viewBoxHeight * scale;

  const rgba = new Uint8ClampedArray(pixelWidth * pixelHeight * 4);
  rgba.fill(255); // White background

  // Parse path horizontal runs (M{x} {y}h{len}v1h-{len}z)
  const pathMatch = svgString.match(/<path[^>]*d="([^"]+)"/);
  if (pathMatch) {
    const d = pathMatch[1];
    const commands = d.matchAll(/M\s*(\d+)\s+(\d+)h(\d+)v1h-\d+z/g);
    for (const m of commands) {
      const col = parseInt(m[1], 10);
      const row = parseInt(m[2], 10);
      const len = parseInt(m[3], 10);
      for (let c = 0; c < len; c++) {
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            const y = row * scale + py;
            const x = (col + c) * scale + px;
            const idx = (y * pixelWidth + x) * 4;
            rgba[idx] = 0;
            rgba[idx + 1] = 0;
            rgba[idx + 2] = 0;
            rgba[idx + 3] = 255;
          }
        }
      }
    }
  }

  return { rgba, width: pixelWidth, height: pixelHeight };
}

/**
 * Helper to decode SVG directly with jsQR and verify result.
 */
function scanSvg(svg: string): string | null {
  const { rgba, width, height } = rasterizeSvgToRgba(svg);
  const code = jsQR(rgba, width, height);
  return code ? code.data : null;
}

/**
 * Helper to decode QrMatrix directly with jsQR and verify result.
 */
function scanMatrix(matrix: QrMatrix, margin: number = 4): string | null {
  const { rgba, pixelSize } = matrixToRgba(matrix, margin);
  const code = jsQR(rgba, pixelSize, pixelSize);
  return code ? code.data : null;
}

describe('QR Code Generator (@enkeep/channel-lark)', () => {
  describe('Synchronous API & Structure', () => {
    it('generates clean SVG markup with standard default margin >= 4', () => {
      const payload = 'https://enkeep.example.com/onboard';
      const svg = generateQrSvg(payload);

      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toMatch(/viewBox="0 0 \d+ \d+"/);
      expect(svg).toContain('<rect width="100%" height="100%" fill="#ffffff"/>');
      expect(svg).toContain('<path d="');
      expect(svg).toContain('fill="#000000"');
      // No external CDN scripts, images or remote fonts
      expect(svg).not.toContain('<script');
      expect(svg).not.toContain('<image');
      expect(svg).not.toContain('https://');
      expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toContain('http://');

      // Verify that margin is at least 4 modules:
      // SVG viewBox size = matrix size + 2 * margin
      const matrix = generateQrMatrix(payload);
      expect(svg).toContain(`viewBox="0 0 ${matrix.size + 8} ${matrix.size + 8}"`);
    });

    it('generates valid SVG Data URL without external dependencies', () => {
      const payload = 'https://open.feishu.cn/login';
      const dataUrl = generateQrDataUrl(payload);

      expect(dataUrl.startsWith('data:image/svg+xml;utf8,')).toBe(true);
      const decodedSvg = decodeURIComponent(dataUrl.slice('data:image/svg+xml;utf8,'.length));
      expect(decodedSvg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');

      // Decode decoded SVG
      const scanned = scanSvg(decodedSvg);
      expect(scanned).toBe(payload);
    });

    it('respects custom margin and size options', () => {
      const payload = 'test-custom-options';
      const matrix = generateQrMatrix(payload);
      const customMargin = 6;
      const svg = generateQrSvg(payload, { margin: customMargin, size: 256 });

      expect(svg).toContain('width="256"');
      expect(svg).toContain('height="256"');
      expect(svg).toContain(`viewBox="0 0 ${matrix.size + customMargin * 2} ${matrix.size + customMargin * 2}"`);

      const scanned = scanSvg(svg);
      expect(scanned).toBe(payload);
    });
  });

  describe('Decoding Verification with jsQR Independent Decoder', () => {
    it('accurately encodes and decodes real-world Feishu qrPayload JSON shape', () => {
      const realQrPayload = JSON.stringify({
        flowKey: 'flow_key_8f3a9e72b1c4',
        token: 'tok_onboarding_session_99281746201',
        step_info: {
          flow: 'qr_login_v2',
          target_app: 'cli_a1b2c3d4e5f6',
          redirect_uri: 'https://open.feishu.cn/accounts/page/login?app_id=cli_a1b2c3d4e5f6',
        },
      });

      // 1. Verify SVG rasterization roundtrip
      const svg = generateQrSvg(realQrPayload);
      const scannedFromSvg = scanSvg(svg);
      expect(scannedFromSvg).toBe(realQrPayload);

      // 2. Verify QrMatrix RGBA roundtrip
      const matrix = generateQrMatrix(realQrPayload);
      const scannedFromMatrix = scanMatrix(matrix);
      expect(scannedFromMatrix).toBe(realQrPayload);
    });

    it('accurately encodes and decodes mixed Chinese and English payload with special characters', () => {
      const mixedText = '飞书开放平台企业扫码授权！Lark Onboarding Test (Space ID: 空间-8888) 标点: 【】、。@#$%^&*()';

      const svg = generateQrSvg(mixedText, { eccLevel: 'M' });
      const scanned = scanSvg(svg);
      expect(scanned).toBe(mixedText);

      const matrix = generateQrMatrix(mixedText, { eccLevel: 'M' });
      expect(scanMatrix(matrix)).toBe(mixedText);
    });

    it('accurately encodes and decodes Version 7+ long payload (>= 45x45 modules) with version bits & RS parity', () => {
      // Version 7 at ECC Level M requires at least ~124 data bytes; 250 characters guarantees Version 7 or higher
      const longPayload = JSON.stringify({
        description: 'Lark / Feishu App Onboarding Protocol Payload with extended scope permissions and verification tokens',
        scopes: [
          'im:message',
          'im:message:send_as_bot',
          'im:chat',
          'im:resource',
          'contact:user.employee_id:readonly',
          'docx:document',
          'bitable:app',
        ],
        timestamp: 1718000000000,
        signature: 'sig_f4c78d91a0b3e562719c8d0a2f4e6b8c1d3e5a7f9b0c2d4e6f8a0b2c4d6e8f0a',
        nonce: 'non_98765432109876543210',
      });

      const matrix = generateQrMatrix(longPayload, { eccLevel: 'M' });
      // Version 7 has 45 modules, version 8 has 49, etc.
      expect(matrix.size).toBeGreaterThanOrEqual(45);

      const svg = generateQrSvg(longPayload, { eccLevel: 'M' });
      const scannedSvg = scanSvg(svg);
      expect(scannedSvg).toBe(longPayload);

      const scannedMatrix = scanMatrix(matrix);
      expect(scannedMatrix).toBe(longPayload);
    });

    it('accurately encodes and decodes across all ECC levels (L, M, Q, H)', () => {
      const payload = 'ECC-Level-Verification-Token-987654321';
      const eccLevels: Array<'L' | 'M' | 'Q' | 'H'> = ['L', 'M', 'Q', 'H'];

      for (const ecc of eccLevels) {
        const svg = generateQrSvg(payload, { eccLevel: ecc });
        const scanned = scanSvg(svg);
        expect(scanned).toBe(payload);

        const matrix = generateQrMatrix(payload, { eccLevel: ecc });
        expect(scanMatrix(matrix)).toBe(payload);
      }
    });
  });

  describe('Error Handling & Overflow Boundary Protection', () => {
    it('throws error when text payload is empty string', () => {
      expect(() => generateQrSvg('')).toThrow(/non-empty string/);
      expect(() => generateQrMatrix('')).toThrow(/non-empty string/);
    });

    it('throws error when text payload is not a string', () => {
      expect(() => generateQrSvg(null as any)).toThrow(/non-empty string/);
      expect(() => generateQrSvg(undefined as any)).toThrow(/non-empty string/);
    });

    it('throws explicit error when payload length overflows QR Code maximum capacity (Version 40)', () => {
      // Max capacity for Version 40 with ECC Level H is ~1273 bytes, and Level L is ~2953 bytes.
      // A payload of 5000 characters exceeds Version 40 capacity.
      const massivePayload = 'X'.repeat(5000);

      expect(() => {
        generateQrSvg(massivePayload, { eccLevel: 'H' });
      }).toThrow(/amount of data is too big|overflow/i);

      expect(() => {
        generateQrMatrix(massivePayload, { eccLevel: 'H' });
      }).toThrow(/amount of data is too big|overflow/i);
    });
  });
});

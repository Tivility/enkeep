/**
 * WeChat iLink QR onboarding and polling protocol module.
 *
 * Implements QR code retrieval, SVG generation, status polling,
 * Tencent IDC redirect domain verification, and second-factor verification code submission.
 *
 * @module @enkeep/channel-wechat/onboarding/qr
 */

import QRCode from 'qrcode';
import {
  DEFAULT_BASE_URL,
  CHANNEL_VERSION,
  ILINK_APP_ID,
  parseWeChatApiResponse,
} from '../http.js';

export type WeChatQrStatusValue =
  | 'wait'
  | 'scaned'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'
  | 'confirmed'
  | 'expired';

export interface WeChatQrStart {
  readonly qrcode: string;
  readonly qrcodeImgContent?: string;
  readonly qrDataUrl: string;
  readonly qrSvg: string;
}

export interface WeChatQrStatus {
  readonly status: WeChatQrStatusValue;
  readonly botToken?: string;
  readonly ilinkBotId?: string;
  readonly baseUrl?: string;
  readonly redirectHost?: string;
  readonly alreadyConnected?: boolean;
}

export interface WeChatQrStartOptions {
  /** Optional base URL override. Defaults to https://ilinkai.weixin.qq.com */
  readonly baseUrl?: string;
  /** Existing token list for this account. Never include another user's token. */
  readonly localTokenList?: readonly string[];
  /** Injectable fetch implementation for offline mocking and custom dispatchers. */
  readonly fetchImpl?: typeof fetch;
  /** Signal for cancellation. */
  readonly signal?: AbortSignal;
}

export interface WeChatQrPollOptions {
  /** Redirected iLink API base returned by scaned_but_redirect. */
  readonly baseUrl?: string;
  /** Number shown by the WeChat client for second-factor verification. */
  readonly verifyCode?: string;
  /** Injectable fetch implementation for offline mocking and custom dispatchers. */
  readonly fetchImpl?: typeof fetch;
  /** Signal for cancellation. */
  readonly signal?: AbortSignal;
}

export interface QrCodeOptions {
  /** Margin in QR modules. Defaults to 2. */
  readonly margin?: number;
  /** Rendered width/height in px. */
  readonly size?: number;
}

/**
 * Encode semver as the uint32 expected by iLink (0x00MMNNPP).
 */
export function encodeWeChatClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * Build standard headers for iLink QR onboarding requests.
 */
export function weChatIlinkHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(encodeWeChatClientVersion(CHANNEL_VERSION)),
  };
}

/**
 * Accept only Tencent-owned HTTPS redirect hosts before following an IDC hop.
 * Prevents SSRF attacks.
 */
export function resolveWeChatRedirectBaseUrl(
  redirectHost: string | undefined
): string | undefined {
  if (!redirectHost) return undefined;
  const raw = redirectHost.trim().toLowerCase();
  if (!raw || raw.includes('/') || raw.includes('@') || raw.includes(':') || raw.includes('\\')) {
    return undefined;
  }
  if (raw !== 'qq.com' && !raw.endsWith('.qq.com')) {
    return undefined;
  }
  return `https://${raw}`;
}

/**
 * Generates an SVG string representation of a QR code for the given text synchronously.
 */
export function generateQrSvg(text: string, options: QrCodeOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR payload must be a non-empty string');
  }

  const margin = options.margin !== undefined ? Math.max(0, options.margin) : 2;
  const qr = QRCode.create(text, {
    errorCorrectionLevel: 'M',
  });

  const modSize = qr.modules.size;
  const fullSize = modSize + margin * 2;
  const data = qr.modules.data;

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

/**
 * Initiates WeChat iLink QR onboarding session.
 * Calls /ilink/bot/get_bot_qrcode?bot_type=3
 */
export async function startWeChatQrOnboarding(
  options: WeChatQrStartOptions = {}
): Promise<WeChatQrStart> {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const fetcher = options.fetchImpl ?? fetch;

  const localTokenList = Array.from(
    new Set(
      (options.localTokenList ?? [])
        .map((token) => token.trim())
        .filter(Boolean)
    )
  ).slice(0, 10);

  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...weChatIlinkHeaders(),
    },
    body: JSON.stringify({ local_token_list: localTokenList }),
    signal: options.signal,
  });

  const body = await parseWeChatApiResponse<{
    qrcode?: string;
    qrcode_img_content?: string;
  }>(response, 'get_bot_qrcode');

  if (!body.qrcode) {
    throw new Error('WeChat QR response did not include qrcode');
  }

  const payloadForQr = body.qrcode_img_content || body.qrcode;
  const qrSvg = generateQrSvg(payloadForQr);
  const qrDataUrl = generateQrDataUrl(payloadForQr);

  return {
    qrcode: body.qrcode,
    qrcodeImgContent: body.qrcode_img_content,
    qrDataUrl,
    qrSvg,
  };
}

/**
 * Polls WeChat iLink QR onboarding status.
 * Calls /ilink/bot/get_qrcode_status?qrcode=...[&verify_code=...]
 */
export async function pollWeChatQrOnboarding(
  qrcode: string,
  options: WeChatQrPollOptions = {}
): Promise<WeChatQrStatus> {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const query = new URLSearchParams({ qrcode });
  if (options.verifyCode?.trim()) {
    query.set('verify_code', options.verifyCode.trim());
  }

  const url = `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`;
  const fetcher = options.fetchImpl ?? fetch;

  const response = await fetcher(url, {
    method: 'GET',
    headers: weChatIlinkHeaders(),
    signal: options.signal,
  });

  const body = await parseWeChatApiResponse<{
    status?: string;
    bot_token?: string;
    ilink_bot_id?: string;
    baseurl?: string;
    redirect_host?: string;
  }>(response, 'get_qrcode_status');

  const knownStatuses = new Set<WeChatQrStatusValue>([
    'wait',
    'scaned',
    'scaned_but_redirect',
    'need_verifycode',
    'verify_code_blocked',
    'binded_redirect',
    'confirmed',
    'expired',
  ]);

  const rawStatus = (body.status || 'wait') as WeChatQrStatusValue;
  const status = knownStatuses.has(rawStatus) ? rawStatus : 'wait';

  return {
    status,
    botToken: body.bot_token,
    ilinkBotId: body.ilink_bot_id ? body.ilink_bot_id.replace(/[^a-zA-Z0-9@._-]/g, '') : undefined,
    baseUrl: body.baseurl,
    redirectHost: body.redirect_host,
    alreadyConnected: status === 'binded_redirect',
  };
}

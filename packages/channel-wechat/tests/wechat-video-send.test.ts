import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CredentialedWeChatTransport, FakeWeChatTransport } from '../src/transport.js';
import * as cryptoModule from '../src/crypto.js';
import {
  WECHAT_MEDIA_TYPE_FILE,
  WECHAT_MEDIA_TYPE_VIDEO,
  isWeChatVideoFile,
} from '../src/crypto-types.js';
import {
  WECHAT_ITEM_TYPE_FILE,
  WECHAT_ITEM_TYPE_VIDEO,
} from '../src/types.js';

describe('WeChat Native Video Sending and File Fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. routes .mp4 / video/mp4 as native video (mediaType 2, item type 5, video_item with video_size)', async () => {
    const uploadSpy = vi.spyOn(cryptoModule, 'uploadMediaBuffer').mockResolvedValue({
      filekey: 'mock-filekey',
      downloadEncryptedQueryParam: 'param_enc_video_123',
      aeskey: 'aeskey_video_base64_test',
      fileSize: 1024,
      fileSizeCiphertext: 1040,
    });

    const sentRequests: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sentRequests.push({ url: urlStr, body });
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const transport = new CredentialedWeChatTransport(
      {
        botToken: 'test-token',
        ilinkBotId: 'test-bot',
        baseUrl: 'http://127.0.0.1:9999',
      },
      {
        fetch: mockFetch as unknown as typeof fetch,
      }
    );

    // Mock internal running state
    (transport as any)._running = true;

    // Test with .mp4 filename (case insensitive)
    const res = await transport.sendFile(
      'user_test_synthetic_01',
      'ctx_synthetic_token_123',
      Buffer.from('video-synthetic-bytes'),
      'sample_clip.MP4'
    );

    expect(res.success).toBe(true);
    expect(res.messageId).toMatch(/^msg_wc_video_/);

    // Assert media upload used mediaType 2 (VIDEO)
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0].mediaType).toBe(WECHAT_MEDIA_TYPE_VIDEO);
    expect(uploadSpy.mock.calls[0][0].fileName).toBe('sample_clip.MP4');

    // Assert sendmessage payload
    const sendMsgReq = sentRequests.find((r) => r.url.includes('ilink/bot/sendmessage'));
    expect(sendMsgReq).toBeDefined();
    const item = sendMsgReq?.body.msg.item_list[0];
    expect(item.type).toBe(WECHAT_ITEM_TYPE_VIDEO);
    expect(item.file_item).toBeUndefined();
    expect(item.video_item).toEqual({
      media: {
        encrypt_query_param: 'param_enc_video_123',
        aes_key: 'aeskey_video_base64_test',
        encrypt_type: 1,
      },
      video_size: 1040,
    });
  });

  it('2. routes non-video as standard file (mediaType 3, item type 4, file_item with len)', async () => {
    const uploadSpy = vi.spyOn(cryptoModule, 'uploadMediaBuffer').mockResolvedValue({
      filekey: 'mock-filekey',
      downloadEncryptedQueryParam: 'param_enc_file_123',
      aeskey: 'aeskey_file_base64_test',
      fileSize: 500,
      fileSizeCiphertext: 512,
    });

    const sentRequests: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sentRequests.push({ url: urlStr, body });
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const transport = new CredentialedWeChatTransport(
      {
        botToken: 'test-token',
        ilinkBotId: 'test-bot',
        baseUrl: 'http://127.0.0.1:9999',
      },
      {
        fetch: mockFetch as unknown as typeof fetch,
      }
    );

    (transport as any)._running = true;

    const fileBuf = Buffer.from('document-synthetic-content');
    const res = await transport.sendFile(
      'user_test_synthetic_01',
      'ctx_synthetic_token_123',
      fileBuf,
      'notes.pdf',
      'application/pdf'
    );

    expect(res.success).toBe(true);
    expect(res.messageId).toMatch(/^msg_wc_file_/);

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy.mock.calls[0][0].mediaType).toBe(WECHAT_MEDIA_TYPE_FILE);

    const sendMsgReq = sentRequests.find((r) => r.url.includes('ilink/bot/sendmessage'));
    expect(sendMsgReq).toBeDefined();
    const item = sendMsgReq?.body.msg.item_list[0];
    expect(item.type).toBe(WECHAT_ITEM_TYPE_FILE);
    expect(item.video_item).toBeUndefined();
    expect(item.file_item).toEqual({
      media: {
        encrypt_query_param: 'param_enc_file_123',
        aes_key: 'aeskey_file_base64_test',
        encrypt_type: 1,
      },
      file_name: 'notes.pdf',
      len: String(fileBuf.length),
    });
  });

  it('3. falls back to regular file sending when native video upload or sendmessage fails', async () => {
    let callCount = 0;
    const uploadSpy = vi.spyOn(cryptoModule, 'uploadMediaBuffer').mockImplementation(async (params) => {
      callCount++;
      if (params.mediaType === WECHAT_MEDIA_TYPE_VIDEO) {
        throw new Error('CDN video upload rejected by upstream');
      }
      return {
        filekey: 'mock-filekey-fallback',
        downloadEncryptedQueryParam: 'param_enc_fallback_file',
        aeskey: 'aeskey_fallback_base64',
        fileSize: 2048,
        fileSizeCiphertext: 2064,
      };
    });

    const sentRequests: Array<{ url: string; body: any }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const body = init?.body ? JSON.parse(init.body as string) : {};
      sentRequests.push({ url: urlStr, body });
      return new Response(JSON.stringify({ ret: 0, errcode: 0, errmsg: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const transport = new CredentialedWeChatTransport(
      {
        botToken: 'test-token',
        ilinkBotId: 'test-bot',
        baseUrl: 'http://127.0.0.1:9999',
      },
      {
        fetch: mockFetch as unknown as typeof fetch,
      }
    );

    (transport as any)._running = true;

    const fileBuf = Buffer.from('video-synthetic-bytes');
    const res = await transport.sendFile(
      'user_test_synthetic_01',
      'ctx_synthetic_token_123',
      fileBuf,
      'movie.mp4'
    );

    // Call succeeded via fallback
    expect(res.success).toBe(true);
    expect(res.messageId).toMatch(/^msg_wc_file_/);

    // uploadMediaBuffer was called twice: 1st video, 2nd file
    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(uploadSpy.mock.calls[0][0].mediaType).toBe(WECHAT_MEDIA_TYPE_VIDEO);
    expect(uploadSpy.mock.calls[1][0].mediaType).toBe(WECHAT_MEDIA_TYPE_FILE);

    // Final sent message was file_item
    const sendMsgReq = sentRequests.find((r) => r.url.includes('ilink/bot/sendmessage'));
    expect(sendMsgReq).toBeDefined();
    const item = sendMsgReq?.body.msg.item_list[0];
    expect(item.type).toBe(WECHAT_ITEM_TYPE_FILE);
    expect(item.file_item).toMatchObject({
      file_name: 'movie.mp4',
      len: String(fileBuf.length),
    });
  });

  it('4. FakeWeChatTransport records [Video: ...] for MP4 files', async () => {
    const fakeTransport = new FakeWeChatTransport();
    await fakeTransport.start();

    const res = await fakeTransport.sendFile(
      'user_test_synthetic_01',
      'ctx_synthetic_token_123',
      Buffer.from('fake-video'),
      'clip.mp4'
    );

    expect(res.success).toBe(true);
    expect(res.messageId).toMatch(/^msg_wc_vid_/);
    expect(fakeTransport.sentReplies[0].text).toContain('[Video: clip.mp4]');

    await fakeTransport.stop();
  });
});

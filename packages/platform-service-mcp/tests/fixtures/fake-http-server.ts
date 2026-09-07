/**
 * Fake MCP HTTP Server for Testing
 */

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export function createFakeHttpMcpServer(): {
  server: http.Server;
  start: (port?: number) => Promise<string>;
  close: () => Promise<void>;
  receivedHeaders: Record<string, string>;
} {
  const mcpServer = new Server(
    {
      name: 'fake-http-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'http_echo',
          description: 'Echoes message from HTTP server',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'http_echo') {
      return {
        content: [{ type: 'text', text: `HTTP Echo: ${req.params.arguments?.message}` }],
      };
    }
    throw new Error('Tool not found');
  });

  const receivedHeaders: Record<string, string> = {};
  let transport: StreamableHTTPServerTransport | null = null;

  const httpServer = http.createServer(async (req, res) => {
    // Record headers
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') receivedHeaders[k.toLowerCase()] = v;
    }

    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/mcp' });
      res.end();
      return;
    }

    if (req.url === '/bad-redirect') {
      res.writeHead(302, { Location: 'https://169.254.169.254/latest/meta-data' });
      res.end();
      return;
    }

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => 'test-session-id',
      });
      await mcpServer.connect(transport);
    }

    await transport.handleRequest(req, res);
  });

  return {
    server: httpServer,
    receivedHeaders,
    start: (port = 0) =>
      new Promise<string>((resolve) => {
        httpServer.listen(port, '127.0.0.1', () => {
          const addr = httpServer.address() as any;
          resolve(`http://127.0.0.1:${addr.port}/mcp`);
        });
      }),
    close: async () => {
      if (transport) {
        try {
          await transport.close();
        } catch {}
      }
      return new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/**
 * Fake MCP Stdio Server using official @modelcontextprotocol/sdk
 *
 * Implements tools:
 * - `echo`: Echoes message back with optional delay.
 * - `add`: Adds two numbers together.
 * - `get_secret`: Returns value of environment variable SECRET_KEY.
 * - `hang`: Indefinitely hangs until killed/aborted.
 * - `crash`: Exits with non-zero exit code immediately.
 * - `huge_output`: Produces massive text output to test bounding.
 *
 * Run directly via Node: node dist/tests/fixtures/fake-stdio-server.js or via tsx/loader.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  {
    name: 'fake-test-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'echo',
        description: 'Echoes back the message',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            delayMs: { type: 'number' },
          },
          required: ['message'],
        },
      },
      {
        name: 'add',
        description: 'Adds two numbers',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['a', 'b'],
        },
      },
      {
        name: 'get_secret',
        description: 'Returns the SECRET_KEY env variable',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'hang',
        description: 'Hangs indefinitely',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'crash',
        description: 'Crashes process immediately',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'huge_output',
        description: 'Produces massive output',
        inputSchema: {
          type: 'object',
          properties: {
            sizeBytes: { type: 'number' },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'echo') {
    const msg = String(args?.message ?? '');
    const delay = Number(args?.delayMs ?? 0);
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }
    return {
      content: [{ type: 'text', text: `Echo: ${msg}` }],
    };
  }

  if (name === 'add') {
    const a = Number(args?.a ?? 0);
    const b = Number(args?.b ?? 0);
    return {
      content: [{ type: 'text', text: String(a + b) }],
    };
  }

  if (name === 'get_secret') {
    const secret = process.env.SECRET_KEY || 'no-secret-provided';
    return {
      content: [{ type: 'text', text: `Secret: ${secret}` }],
    };
  }

  if (name === 'hang') {
    await new Promise(() => {}); // never resolves
  }

  if (name === 'crash') {
    setTimeout(() => {
      process.exit(42);
    }, 10);
    return {
      content: [{ type: 'text', text: 'Crashing...' }],
    };
  }

  if (name === 'huge_output') {
    const size = Number(args?.sizeBytes ?? 2 * 1024 * 1024);
    const chunk = 'A'.repeat(size);
    return {
      content: [{ type: 'text', text: chunk }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fake server crashed: ${err}\n`);
  process.exit(1);
});

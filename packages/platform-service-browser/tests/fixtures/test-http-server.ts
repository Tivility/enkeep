/**
 * Test HTTP Server Fixture
 *
 * Provides a lightweight local HTTP server for integration testing the browser service on 127.0.0.1.
 *
 * @module @enkeep/platform-service-browser/tests/fixtures/test-http-server
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestHttpServer {
  readonly server: http.Server;
  readonly port: number;
  readonly origin: string;
  close(): Promise<void>;
}

export async function createTestHttpServer(
  requestHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestHttpServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (requestHandler) {
        requestHandler(req, res);
        return;
      }

      // Default routes
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

      if (url.pathname === '/redirect-loopback') {
        res.writeHead(302, { Location: 'http://127.0.0.1:9999/secret' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-private') {
        res.writeHead(302, { Location: 'http://10.0.0.1/admin' });
        res.end();
        return;
      }

      if (url.pathname === '/redirect-metadata') {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }

      if (url.pathname === '/interactive-page') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Test Interactive Page</title></head>
            <body>
              <h1>Welcome to Test Page</h1>
              <p>This is a paragraph of text.</p>
              <button id="btn-submit" onclick="document.getElementById('status').innerText = 'Clicked!'">Submit Button</button>
              <input id="input-name" type="text" placeholder="Enter username" />
              <select id="select-role">
                <option value="user">User</option>
                <option value="admin">Administrator</option>
              </select>
              <a id="link-target" href="/destination">Go to Destination</a>
              <div id="status">Ready</div>
              <script>
                // Non-rendered inline script
              </script>
            </body>
          </html>
        `);
        return;
      }

      if (url.pathname === '/destination') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>Destination Page</title></head><body><h1>Reached Destination</h1></body></html>`);
        return;
      }

      if (url.pathname === '/cookies-test') {
        const cookies = req.headers.cookie || '';
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'session_token=secret_value_123; HttpOnly; Path=/',
        });
        res.end(JSON.stringify({ receivedCookies: cookies }));
        return;
      }

      if (url.pathname === '/huge-page') {
        let html = '<!DOCTYPE html><html><body><h1>Huge Page</h1>';
        for (let i = 0; i < 1500; i++) {
          html += `<div class="item"><button id="btn-${i}">Action ${i}</button><p>Description text for item ${i}</p></div>`;
        }
        html += '</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }

      if (url.pathname === '/hanging-page') {
        // Never ends response to trigger timeout
        return;
      }

      // Default index
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>Default Index</title></head><body><h1>Hello World</h1></body></html>`);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const port = addr.port;
      const origin = `http://127.0.0.1:${port}`;

      resolve({
        server,
        port,
        origin,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });

    server.on('error', (err) => reject(err));
  });
}

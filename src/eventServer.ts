import * as http from 'http';
import { AddressInfo } from 'net';

export interface HookEventBody {
  event?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

type EventHandler = (eventName: string, payload: Record<string, unknown>) => void;

/**
 * Tiny localhost-only HTTP server for Cursor hook bridge posts.
 */
export class EventServer {
  private server?: http.Server;
  private readonly handler: EventHandler;
  private port: number;
  private onListening?: (port: number) => void;

  constructor(port: number, handler: EventHandler) {
    this.port = port;
    this.handler = handler;
  }

  setOnListening(cb: (port: number) => void): void {
    this.onListening = cb;
  }

  async start(): Promise<number> {
    if (this.server) {
      return this.port;
    }

    const tryListen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this.handle(req, res).catch(() => {
            res.writeHead(500);
            res.end('error');
          });
        });
        const onError = (err: NodeJS.ErrnoException) => {
          server.close();
          reject(err);
        };
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          const addr = server.address() as AddressInfo;
          this.server = server;
          this.port = addr.port;
          this.onListening?.(this.port);
          resolve(this.port);
        });
      });

    try {
      return await tryListen(this.port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EADDRINUSE') {
        // Fall back to an ephemeral free port.
        return await tryListen(0);
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  getPort(): number {
    return this.port;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // CORS not needed; only local bridge.
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'cursor-gf-live' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/event') {
      const raw = await readBody(req);
      let body: HookEventBody = {};
      try {
        body = raw ? (JSON.parse(raw) as HookEventBody) : {};
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }

      const eventName =
        (typeof body.hook_event_name === 'string' && body.hook_event_name) ||
        (typeof body.hookEventName === 'string' && body.hookEventName) ||
        (typeof body.event_name === 'string' && body.event_name) ||
        (typeof body.eventName === 'string' && body.eventName) ||
        (typeof body.event === 'string' && body.event) ||
        'unknown';

      this.handler(eventName, body as Record<string, unknown>);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

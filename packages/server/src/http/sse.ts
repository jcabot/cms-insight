import type { FastifyReply } from 'fastify';

export interface SseClient {
  send(event: string, data: unknown): void;
  close(): void;
}

export function attachSse(reply: FastifyReply): SseClient {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no');
  reply.raw.flushHeaders();

  const send = (event: string, data: unknown): void => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    reply.raw.write(`event: ${event}\n`);
    for (const line of payload.split('\n')) {
      reply.raw.write(`data: ${line}\n`);
    }
    reply.raw.write('\n');
  };

  const close = (): void => {
    try {
      reply.raw.end();
    } catch {
      /* ignore */
    }
  };

  return { send, close };
}

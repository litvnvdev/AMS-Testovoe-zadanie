import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ZodError } from 'zod';
import { ConfirmInputSchema, DomainError, TaskInputSchema } from './types.js';
import type { TaskService } from './service.js';
import { redactText } from './util.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

const issues = (e: ZodError) => e.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));

/**
 * HTTP-слой: только разбор запроса, валидация входа и вызов TaskService.
 * Никакой доменной логики и работы с БД здесь нет.
 */
export function buildApp(service: TaskService, opts: { webDir?: string } = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', issues: issues(err) } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'BAD_REQUEST', message: 'Bad request' } });
    }
    console.error('[http]', redactText(err instanceof Error ? err.message : String(err)));
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }); // без деталей и стека
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/tasks', async (req, reply) => {
    const input = TaskInputSchema.parse(req.body);
    const { task, created } = service.createTask(input);
    return reply.code(created ? 201 : 200).send({ ...service.view(task), duplicate: !created });
  });

  app.get<{ Params: { id: string } }>('/tasks/:id', async (req) => service.view(service.getTask(req.params.id)));

  app.get<{ Params: { id: string } }>('/tasks/:id/events', async (req) => ({
    task_id: req.params.id,
    events: service.getEvents(req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/tasks/:id/confirm', async (req) =>
    service.confirm(req.params.id, ConfirmInputSchema.parse(req.body)),
  );

  app.post<{ Params: { id: string } }>('/tasks/:id/cancel', async (req) => {
    const body = (req.body ?? {}) as { user_id?: unknown };
    return service.cancel(req.params.id, typeof body.user_id === 'string' ? body.user_id : undefined);
  });

  // Статика собранной React-панели (без отдельного пакета, с защитой от path traversal).
  const webDir = opts.webDir ? resolve(opts.webDir) : undefined;
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || !webDir || !existsSync(webDir) || req.url.startsWith('/tasks')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0] ?? '/').replace(/^\/+/, '');
    } catch {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Bad request' } });
    }
    let file = resolve(join(webDir, normalize(urlPath || 'index.html')));
    const inside = file === webDir || file.startsWith(webDir + sep);
    if (!inside || !existsSync(file) || !statSync(file).isFile()) file = join(webDir, 'index.html');
    if (!existsSync(file)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return reply.type(MIME[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
  });

  return app;
}

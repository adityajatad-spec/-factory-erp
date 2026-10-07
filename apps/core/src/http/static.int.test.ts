import type { FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../test/test-db';
import { buildApp } from './app';

// Production topology (R2-D1): the core serves the built web app and the API on one origin.
let env: TestEnv;
let app: FastifyInstance;
let webDir: string;

beforeAll(async () => {
  env = await createTestEnv();
  webDir = await mkdtemp(path.join(tmpdir(), 'ferp-web-'));
  await mkdir(path.join(webDir, 'assets'));
  await writeFile(
    path.join(webDir, 'index.html'),
    '<!doctype html><title>Factory ERP</title><div id="root"></div>',
  );
  await writeFile(path.join(webDir, 'assets', 'app.js'), 'console.log("app")');
  app = await buildApp({ ...env.services, config: { ...env.services.config, webDistDir: webDir } });
});
afterAll(async () => {
  await app.close();
  await env.destroy();
  await rm(webDir, { recursive: true, force: true });
});

describe('serving the web app', () => {
  it('serves index.html and static assets', async () => {
    const index = await app.inject('/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<div id="root">');
    const js = await app.inject('/assets/app.js');
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject('/sales/invoices/some-id');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('keeps JSON 404s for unknown API routes and non-GET requests', async () => {
    const api = await app.inject('/api/v1/nope');
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/problem+json');
    const post = await app.inject({ method: 'POST', url: '/sales/invoices', payload: {} });
    expect(post.statusCode).toBe(404);
  });

  it('returns 404 (not index.html) for missing asset files', async () => {
    const res = await app.inject('/assets/stale-build-123.js');
    expect(res.statusCode).toBe(404);
  });

  it('serves files added after startup (rebuild without restart)', async () => {
    await writeFile(path.join(webDir, 'assets', 'new-build.js'), 'console.log("new")');
    const res = await app.inject('/assets/new-build.js');
    expect(res.statusCode).toBe(200);
  });

  it('still serves the API', async () => {
    expect((await app.inject('/api/v1/health')).json()).toMatchObject({ status: 'ok' });
  });
});

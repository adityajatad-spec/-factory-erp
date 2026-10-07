import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/db/migrate';

export const TEMPLATE_DB = 'ferp_test_template';

declare module 'vitest' {
  export interface ProvidedContext {
    testDbAdminUrl: string;
    testTemplateDb: string;
  }
}

export function adminUrl(): string {
  return (
    process.env.TEST_DATABASE_ADMIN_URL ??
    'postgres://factoryerp:factoryerp@127.0.0.1:5432/postgres'
  );
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * Build a fully migrated template database once per test run. Each integration test file then
 * clones it (CREATE DATABASE … TEMPLATE), which takes milliseconds and isolates files completely.
 * This also proves that every migration applies cleanly to an empty database.
 */
export default async function setup(project: TestProject) {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.query(`create database ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  await migrate(withDatabase(adminUrl(), TEMPLATE_DB));

  project.provide('testDbAdminUrl', adminUrl());
  project.provide('testTemplateDb', TEMPLATE_DB);
}

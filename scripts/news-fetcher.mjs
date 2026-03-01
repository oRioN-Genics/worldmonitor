#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_CURSOR = '.cursor.json';
const MAX_SEEN_IDS = 5000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function parseIsoOrNull(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toISOString();
}

async function loadCursor(cursorPath) {
  if (!existsSync(cursorPath)) return null;
  try {
    const raw = await readFile(cursorPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      since: parseIsoOrNull(parsed?.since),
      seenIds: Array.isArray(parsed?.seenIds) ? parsed.seenIds.map(String) : [],
      updatedAt: parseIsoOrNull(parsed?.updatedAt),
    };
  } catch {
    return null;
  }
}

async function saveCursor(cursorPath, payload) {
  const next = {
    since: payload.since,
    seenIds: payload.seenIds.slice(0, MAX_SEEN_IDS),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(cursorPath, JSON.stringify(next, null, 2), 'utf8');
}

function appendIf(params, key, value) {
  if (value == null || value === '') return;
  params.set(key, String(value));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args['base-url'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const cursorPath = resolve(process.cwd(), args.cursor || DEFAULT_CURSOR);
  const disableCursorWrite = String(args['no-cursor-update'] || '').toLowerCase() === 'true';

  const cliSince = parseIsoOrNull(args.since);
  if (args.since && !cliSince) {
    console.error(JSON.stringify({ error: 'Invalid --since value. Use ISO-8601 date-time.' }));
    process.exitCode = 1;
    return;
  }

  const existingCursor = await loadCursor(cursorPath);
  const since = cliSince || existingCursor?.since || null;

  const params = new URLSearchParams();
  appendIf(params, 'variant', args.variant || 'full');
  appendIf(params, 'lang', args.lang || 'en');
  appendIf(params, 'limit', args.limit || '50');
  appendIf(params, 'source', args.source);
  appendIf(params, 'category', args.category);
  appendIf(params, 'keywords', args.keywords);
  appendIf(params, 'region', args.region);
  appendIf(params, 'importanceMin', args['importance-min']);
  appendIf(params, 'alertOnly', args['alert-only']);
  appendIf(params, 'since', since);

  const endpoint = `${baseUrl}/api/export/news?${params.toString()}`;
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(JSON.stringify({ error: `Request failed with ${response.status}`, body }));
    process.exitCode = 1;
    return;
  }

  const payload = await response.json();
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];

  const seen = new Set((existingCursor?.seenIds || []).map(String));
  const freshItems = rawItems.filter((item) => {
    const id = String(item?.id || '');
    if (!id) return false;
    if (seen.has(id)) return false;
    return true;
  });

  const allSeen = [...freshItems.map((i) => String(i.id)), ...(existingCursor?.seenIds || [])]
    .slice(0, MAX_SEEN_IDS);

  const maxPublishedAt = freshItems.length > 0
    ? Math.max(...freshItems.map((i) => Number(i.publishedAt || 0)))
    : (since ? Date.parse(since) : 0);
  const nextSince = maxPublishedAt > 0 ? new Date(maxPublishedAt).toISOString() : since;

  if (!disableCursorWrite) {
    await saveCursor(cursorPath, {
      since: nextSince,
      seenIds: allSeen,
    });
  }

  const output = {
    meta: {
      ...payload?.meta,
      cursorPath,
      cursorBefore: existingCursor?.since || null,
      cursorAfter: nextSince || null,
      cursorUpdated: !disableCursorWrite,
      rawCount: rawItems.length,
      newCount: freshItems.length,
    },
    items: freshItems,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((err) => {
  console.error(JSON.stringify({ error: 'Unhandled error', detail: String(err) }));
  process.exitCode = 1;
});

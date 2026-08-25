/**
 * Unit tests for the OneCLI codex auth sync.
 *
 * The sync pushes `~/.codex/auth.json` into the OneCLI vault's Codex secret when
 * its `last_refresh` is newer than the last value pushed. Covers the fresh-file
 * push, idempotency (no change → no push), and the fetch-failure path.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above imports and can't close over local consts.
// Use vi.hoisted to compute paths at module scope.
const paths = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  const home = nodePath.join(nodeOs.tmpdir(), 'onecli-codex-sync-test-home');
  const data = nodePath.join(nodeOs.tmpdir(), 'onecli-codex-sync-test-data');
  return {
    home,
    data,
    authPath: nodePath.join(home, '.codex', 'auth.json'),
  };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: paths.data,
    ONECLI_URL: 'http://127.0.0.1:10254',
    ONECLI_API_KEY: undefined,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => paths.home };
});

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { CODEX_AUTH_PATH, syncCodexAuthIfNewer } from './onecli-codex-sync.js';

const SECRET_ID = '70216f57-8dcc-4356-ada8-f9551ba5a06d';

function authFile(refresh: string): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig',
        refresh_token: 'rt.1.abcdefghijklmnop',
        id_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.id',
        account_id: 'e5ec5e49-28c7-40d0-a1f1-9f8990',
      },
      last_refresh: refresh,
    },
    null,
    2,
  );
}

/** The sentinel skeleton `codex login` leaves when the flow never completes. */
function placeholderFile(refresh: string): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: { access_token: 'at', refresh_token: 'rt', id_token: 'it', account_id: 'acct' },
      last_refresh: refresh,
    },
    null,
    2,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fs.mkdirSync(path.dirname(CODEX_AUTH_PATH), { recursive: true });
  fs.mkdirSync(paths.data, { recursive: true });
  // Fresh state marker + auth file each test — no prior push or file lingering.
  fs.rmSync(path.join(paths.data, 'onecli-codex-sync-state.json'), { force: true });
  fs.rmSync(CODEX_AUTH_PATH, { force: true });

  fetchMock = vi.fn(async (url: string) => {
    const listUrl = `http://127.0.0.1:10254/api/secrets`;
    if (String(url) === listUrl) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: SECRET_ID, name: 'Codex' }],
      };
    }
    if (String(url) === `${listUrl}/${SECRET_ID}`) {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(paths.home, { recursive: true, force: true });
  fs.rmSync(paths.data, { recursive: true, force: true });
});

describe('syncCodexAuthIfNewer', () => {
  it('pushes a fresh auth file into the vault', async () => {
    const refresh = '2026-08-14T05:51:34.583569Z';
    fs.writeFileSync(CODEX_AUTH_PATH, authFile(refresh));

    const result = await syncCodexAuthIfNewer();

    expect(result).toBe(true);
    const patchCall = fetchMock.mock.calls.find(([url]) => String(url).includes(SECRET_ID));
    expect(patchCall).toBeTruthy();
    const [, init] = patchCall as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as { value: string };
    expect(JSON.parse(body.value)).toMatchObject({ last_refresh: refresh });
  });

  it('does not push again when the marker already matches', async () => {
    const refresh = '2026-08-14T05:51:34.583569Z';
    fs.writeFileSync(CODEX_AUTH_PATH, authFile(refresh));
    expect(await syncCodexAuthIfNewer()).toBe(true);

    // No file change → no second push.
    fetchMock.mockClear();
    expect(await syncCodexAuthIfNewer()).toBe(false);
    const patchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes(SECRET_ID));
    expect(patchCalls).toHaveLength(0);
  });

  it('pushes again when last_refresh advances', async () => {
    const first = '2026-08-14T05:51:34.583569Z';
    const second = '2026-08-15T05:51:34.583569Z';
    fs.writeFileSync(CODEX_AUTH_PATH, authFile(first));
    expect(await syncCodexAuthIfNewer()).toBe(true);

    fs.writeFileSync(CODEX_AUTH_PATH, authFile(second));
    expect(await syncCodexAuthIfNewer()).toBe(true);
  });

  it('returns false when the auth file is absent', async () => {
    expect(await syncCodexAuthIfNewer()).toBe(false);
    const patchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes(SECRET_ID));
    expect(patchCalls).toHaveLength(0);
  });

  it('never pushes a login placeholder skeleton over a valid vault token', async () => {
    // A placeholder file that is newer than the last pushed refresh must still
    // be refused — otherwise it would clobber the good vault credential.
    fs.writeFileSync(CODEX_AUTH_PATH, placeholderFile('2099-01-01T00:00:00.000Z'));

    expect(await syncCodexAuthIfNewer()).toBe(false);
    const patchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes(SECRET_ID));
    expect(patchCalls).toHaveLength(0);
  });

  it('does not push when the vault secrets list fails', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    fs.writeFileSync(CODEX_AUTH_PATH, authFile('2026-08-14T05:51:34.583569Z'));

    expect(await syncCodexAuthIfNewer()).toBe(false);
  });

  it('does not push when no Codex secret exists in the vault', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (String(url) === 'http://127.0.0.1:10254/api/secrets') {
        return { ok: true, status: 200, json: async () => [{ id: 'x', name: 'DeepSeek' }] };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    fs.writeFileSync(CODEX_AUTH_PATH, authFile('2026-08-14T05:51:34.583569Z'));

    expect(await syncCodexAuthIfNewer()).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles } from './dotenv.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cmsi-env-'));
}

describe('loadEnvFiles', () => {
  let dir: string;
  let originalKey: string | undefined;

  beforeEach(async () => {
    dir = await tmpDir();
    await fs.mkdir(path.join(dir, '.cmsinsight'), { recursive: true });
    originalKey = process.env['CMSI_TEST_KEY'];
    delete process.env['CMSI_TEST_KEY'];
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env['CMSI_TEST_KEY'];
    else process.env['CMSI_TEST_KEY'] = originalKey;
  });

  it('loads keys from <contentDir>/.cmsinsight/.env', async () => {
    await fs.writeFile(
      path.join(dir, '.cmsinsight', '.env'),
      'CMSI_TEST_KEY=from-project\n',
      'utf8',
    );
    const result = await loadEnvFiles({ contentDir: dir });
    expect(process.env['CMSI_TEST_KEY']).toBe('from-project');
    expect(result.loadedFrom).toEqual([path.join(dir, '.cmsinsight', '.env')]);
  });

  it('does not overwrite keys already set in process.env', async () => {
    process.env['CMSI_TEST_KEY'] = 'from-shell';
    await fs.writeFile(
      path.join(dir, '.cmsinsight', '.env'),
      'CMSI_TEST_KEY=from-project\n',
      'utf8',
    );
    await loadEnvFiles({ contentDir: dir });
    expect(process.env['CMSI_TEST_KEY']).toBe('from-shell');
  });

  it('returns empty loadedFrom when no .env exists', async () => {
    const result = await loadEnvFiles({ contentDir: dir });
    expect(result.loadedFrom).toEqual([]);
  });

  it('parses quoted values, comments, and `export` prefixes', async () => {
    await fs.writeFile(
      path.join(dir, '.cmsinsight', '.env'),
      [
        '# a comment',
        '',
        'CMSI_TEST_KEY="quoted value"',
        'CMSI_TEST_KEY_2 = unquoted # inline comment',
        'export CMSI_TEST_KEY_3=exported',
      ].join('\n'),
      'utf8',
    );
    delete process.env['CMSI_TEST_KEY_2'];
    delete process.env['CMSI_TEST_KEY_3'];
    await loadEnvFiles({ contentDir: dir });
    expect(process.env['CMSI_TEST_KEY']).toBe('quoted value');
    expect(process.env['CMSI_TEST_KEY_2']).toBe('unquoted');
    expect(process.env['CMSI_TEST_KEY_3']).toBe('exported');
    delete process.env['CMSI_TEST_KEY_2'];
    delete process.env['CMSI_TEST_KEY_3'];
  });
});

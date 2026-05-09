import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const STATE_DIR = path.join(os.homedir(), '.cmsinsight');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export interface AppState {
  lastRootPath?: string;
  lastActiveSiteId?: string;
}

export async function loadState(): Promise<AppState | undefined> {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(text) as Partial<AppState>;
    const out: AppState = {};
    if (typeof parsed.lastRootPath === 'string') out.lastRootPath = parsed.lastRootPath;
    if (typeof parsed.lastActiveSiteId === 'string') out.lastActiveSiteId = parsed.lastActiveSiteId;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function saveState(state: AppState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

export const STATE_FILE_PATH = STATE_FILE;

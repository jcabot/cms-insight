import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const STATE_DIR = path.join(os.homedir(), '.cmsinsight');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export interface AppState {
  lastContentDir: string;
}

export async function loadState(): Promise<AppState | undefined> {
  try {
    const text = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(text) as Partial<AppState>;
    if (typeof parsed.lastContentDir !== 'string') return undefined;
    return { lastContentDir: parsed.lastContentDir };
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

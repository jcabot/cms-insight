import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function atomicWrite(target: string, contents: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(contents);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

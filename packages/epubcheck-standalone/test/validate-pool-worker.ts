// Child-process entry for validate-pool.ts. One fresh Node process per pool
// slot (its own engine run queue and compiled-source cache), validating whichever
// books the pool sends over IPC. Runs the in-process library API directly -- the
// same path a normal Node caller uses.

import { validate } from '../dist/index.js';
import { fs, fsDir, url } from '../dist/plugins.js';
import type { EpubCheckResult } from '../dist/index.js';

if (typeof process.send !== 'function') {
  throw new Error('validate-pool-worker: no IPC channel (must be run via fork)');
}
const send = process.send.bind(process);

interface Task {
  index: number;
  path: string;
  kind: 'file' | 'dir' | 'url';
  reports?: Array<'json' | 'xml' | 'xmp'>;
}

async function runTask(task: Task): Promise<EpubCheckResult> {
  const options = task.reports ? { reports: task.reports } : {};
  if (task.kind === 'url') return validate(await url(task.path), options);
  if (task.kind === 'dir') return validate(await fsDir(task.path), options);
  return validate(await fs(task.path), options);
}

process.on('message', (task: Task) => {
  runTask(task).then(
    (result) => send({ index: task.index, ok: true, result }),
    (err: unknown) => send({ index: task.index, ok: false, error: String((err as Error)?.stack ?? err) }),
  );
});

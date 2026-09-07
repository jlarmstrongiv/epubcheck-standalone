// Test-only child-process pool for the parity / reports suites.
//
// The library runs the engine IN-PROCESS on the calling thread and serializes
// concurrent calls through an internal queue, so a single thread validates books
// one at a time. Test-suite throughput is the suite's own business, so these
// suites bring their OWN parallelism: a pool of long-lived CHILD PROCESSES, each
// a fresh Node process with its own engine queue that validates many books in a
// row (reusing the once-read engine source across its books; each run still gets
// a fresh scope). Child PROCESSES rather than worker_threads on purpose: a
// process is fully isolated and can be killed outright when the pool is done, so
// tearing the pool down never blocks on disposing a worker isolate that still
// holds an engine runtime.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EpubCheckResult } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, 'validate-pool-worker.ts');

export interface PoolTask {
  /** A packaged .epub path (file), an expanded EPUB directory (dir), or an http(s) URL (url). */
  path: string;
  /** How to validate it. Default: 'file'. */
  kind?: 'file' | 'dir' | 'url';
  /** Also produce epubcheck's own JSON/XML/XMP report output for this task. */
  reports?: Array<'json' | 'xml' | 'xmp'>;
}

interface ChildReply {
  index: number;
  ok: boolean;
  result?: EpubCheckResult;
  error?: string;
}

/**
 * Validate every task across a pool of `concurrency` child processes and return
 * the results in input order. Rejects if any task threw in its child.
 */
export async function validatePool(
  tasks: PoolTask[],
  concurrency: number,
): Promise<EpubCheckResult[]> {
  const results: EpubCheckResult[] = new Array(tasks.length);
  if (tasks.length === 0) return results;
  const n = Math.max(1, Math.min(concurrency, tasks.length));
  let next = 0;
  let done = 0;

  return new Promise<EpubCheckResult[]>((resolve, reject) => {
    let settled = false;
    // Set true the instant we start SIGKILLing the pool (success OR failure), so
    // the exit/error handlers can tell OUR teardown kills from an unexpected
    // early death. Only teardown kills are ignored; anything else fails loudly.
    let tearingDown = false;
    const children: ChildProcess[] = [];

    const teardown = (): void => {
      tearingDown = true;
      for (const c of children) c.kill('SIGKILL');
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      teardown();
      reject(err);
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(results);
    };

    const feed = (c: ChildProcess): void => {
      if (next >= tasks.length) return; // no more work; child idles until killed
      const index = next++;
      const task = tasks[index]!;
      c.send({ index, path: task.path, kind: task.kind ?? 'file', reports: task.reports });
    };

    for (let i = 0; i < n; i++) {
      const c = fork(CHILD, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(c);
      c.on('message', (reply: ChildReply) => {
        if (settled) return;
        if (!reply.ok) {
          fail(new Error(`validate-pool: task ${reply.index} (${tasks[reply.index]!.path}) failed: ${reply.error}`));
          return;
        }
        results[reply.index] = reply.result!;
        done++;
        if (done === tasks.length) {
          succeed();
          return;
        }
        feed(c);
      });
      c.on('error', (err: unknown) => {
        // Teardown SIGKILLs can surface as an IPC-channel error on the parent;
        // ignore errors once we are tearing down. Before that, fail loudly.
        if (tearingDown) return;
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      c.on('exit', (code, signal) => {
        // Ignore ONLY the SIGKILLs our own teardown sends. Any other early exit --
        // including an OOM kill (also SIGKILL) before completion -- fails loudly
        // instead of swallowing it and hanging the suite with no verdict.
        if (tearingDown) return;
        fail(new Error(`validate-pool: child exited early (code ${code}, signal ${signal})`));
      });
      feed(c);
    }
  });
}

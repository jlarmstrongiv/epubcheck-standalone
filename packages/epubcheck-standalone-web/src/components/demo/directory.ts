// ---------------------------------------------------------------------------
// Expanded-EPUB directory gathering (main thread).
//
// A folder can arrive two ways: dragged onto the dropzone, or chosen through the
// <input webkitdirectory> picker. Either way we produce the same shape — the
// File objects, a PARALLEL array of relative '/'-separated paths with the outer
// folder segment stripped (so the EPUB root, where mimetype/META-INF live, is
// the source root), and the folder's own name. The worker builds the library's
// fileList directory source from exactly this (Files and arrays cross the
// comlink boundary cleanly; FileReaderSync only exists in the worker).
// ---------------------------------------------------------------------------
export interface GatheredDirectory {
  files: File[];
  paths: string[];
  folderName: string;
}

// Picker path: File.webkitRelativePath is "Folder/sub/file"; strip the shared
// top-level "Folder/" segment and keep it as the folder name.
export function gatherFromWebkitDirectory(files: File[]): GatheredDirectory {
  const rels = files.map(
    (f) =>
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name,
  );
  const first = rels[0]?.split("/")[0] ?? "";
  const sharedTop =
    first.length > 0 && rels.every((r) => r.startsWith(first + "/"));
  const paths = sharedTop ? rels.map((r) => r.slice(first.length + 1)) : rels;
  const folderName = sharedTop ? first : "book";
  return { files, paths, folderName };
}

// Read every batch a FileSystemDirectoryReader yields — readEntries returns at
// most a page of entries per call and must be pumped until it returns empty.
function readAllEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const pump = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

// Bounded-concurrency map that PRESERVES input order: `results[i]` is always
// `fn(items[i])`, so callers can flatten in `items` order deterministically.
// Independent children fan out, but no more than `cap` `fn` calls run at once
// (a dropped folder can hold many files — a naked Promise.all would be
// unbounded). Same lane-pool shape as teavm/reports-teavm.ts.
const WALK_CONCURRENCY = 8;

async function mapBounded<T, R>(
  items: T[],
  cap: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(cap, items.length) }, () => lane()),
  );
  return results;
}

// Recursively collect files under one FileSystemEntry, building each file's path
// from `prefix` (the path so far, relative to the dropped folder root). Returns
// the subtree's entries in DFS pre-order (files before recursing is not the
// order — each child is expanded fully in child order, matching the original
// sequential walk exactly). Independent children resolve concurrently but their
// results are stitched back in child order, so the flattened output is
// byte-for-byte the same sequence the old sequential push produced.
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
): Promise<{ file: File; path: string }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ file, path: prefix + entry.name }];
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(
      (entry as FileSystemDirectoryEntry).createReader(),
    );
    const childResults = await mapBounded(children, WALK_CONCURRENCY, (child) =>
      walkEntry(child, prefix + entry.name + "/"),
    );
    return childResults.flat();
  }
  return [];
}

// Drop path: walk a dropped directory entry. Paths are relative to INSIDE the
// folder (its own name is not part of them — it becomes the folder name), so the
// walk starts at the folder's children with an empty prefix.
export async function gatherFromDroppedDirectory(
  dirEntry: FileSystemDirectoryEntry,
): Promise<GatheredDirectory> {
  const children = await readAllEntries(dirEntry.createReader());
  const childResults = await mapBounded(children, WALK_CONCURRENCY, (child) =>
    walkEntry(child, ""),
  );
  const out = childResults.flat();
  return {
    files: out.map((w) => w.file),
    paths: out.map((w) => w.path),
    folderName: dirEntry.name || "book",
  };
}

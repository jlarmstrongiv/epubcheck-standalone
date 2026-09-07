import { wrap } from "comlink";
import type { Remote } from "comlink";

// Typed-worker handshake, adapted from
// https://github.com/jlarmstrongiv/fontquant-pyodide (src/worker/spawnWorker.ts).
// spawn worker example https://github.com/GoogleChromeLabs/comlink/issues/635#issuecomment-1598913044
// abort controller example https://stackoverflow.com/a/65805464

export type RemoteWorker<T> = { remote: Remote<T>; worker: Worker };

export const READY_MESSAGE = { __READY__: true };
export const ABORT_WORKER_REASON = "__ABORT_WORKER_REASON__";

export type SpawnParameters = {
  scriptUrl: string;
  options?: WorkerOptions;
  abortController: AbortController;
};
export async function spawnWorker<T>({
  abortController,
  options = {},
  scriptUrl,
}: SpawnParameters): Promise<RemoteWorker<T>> {
  // Module worker by default (same as fontquant). The engine is the TeaVM
  // JS-backend build of epubcheck (plain JavaScript), consumed as real ESM, so
  // nothing here needs a classic worker.
  options.type ??= "module";
  const worker = new Worker(scriptUrl, options);

  await new Promise<void>((resolve, reject) => {
    // Remove every handshake listener once the promise settles, so a later
    // worker error (during validation) is not handled here a second time.
    function cleanup(): void {
      worker.removeEventListener("message", readyListener);
      worker.removeEventListener("error", failListener);
      worker.removeEventListener("messageerror", failListener);
      abortController.signal.removeEventListener("abort", abortListener);
    }

    function readyListener(event: MessageEvent<typeof READY_MESSAGE>) {
      if (event.data.__READY__ === true) {
        cleanup();
        resolve();
      }
    }

    // A worker module-init throw (engine-asset fetch failure, top-level error)
    // arrives as an `error` event; an inbound message that cannot be
    // structured-cloned arrives as `messageerror`. Either means READY can never
    // fire, so terminate the leaked worker and reject: useEpubcheck's catch then
    // leaves "validating" and shows its error state.
    function failListener(event: Event): void {
      cleanup();
      worker.terminate();
      reject(handshakeError(event));
    }

    function abortListener({ target }: Event): void {
      cleanup();
      worker.terminate();
      reject(getReason(target));
    }

    worker.addEventListener("message", readyListener);
    worker.addEventListener("error", failListener);
    worker.addEventListener("messageerror", failListener);
    abortController.signal.addEventListener("abort", abortListener);
  });

  const remote = wrap<T>(worker);

  return { worker, remote };
}

// Build the rejection for a failed handshake from the worker event that killed
// it. `error` events are ErrorEvents carrying a message; `messageerror` events
// carry no detail beyond the deserialization failure itself.
function handshakeError(event: Event): Error {
  if (event instanceof ErrorEvent && event.message) {
    return new Error("epubcheck worker failed to start: " + event.message);
  }
  if (event.type === "messageerror") {
    return new Error(
      "epubcheck worker sent a message that could not be deserialized",
    );
  }
  return new Error("epubcheck worker failed to start");
}

// reason does not exist in typescript for EventTarget https://stackoverflow.com/questions/71211861/property-reason-does-not-exist-on-type-eventtarget-ts2339
function getReason(target: EventTarget | null): string | undefined {
  if (
    target !== null &&
    "reason" in target &&
    typeof target.reason === "string"
  ) {
    return target.reason;
  }
}

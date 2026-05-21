// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { StubHook, RpcPayload, RpcStub, PropertyPath, PayloadStubHook, ErrorStubHook, RpcTarget, unwrapStubAndPath, streamImpl } from "./core.js";
import { ExportId, ImportId, Exporter, Importer, serialize } from "./serialize.js";
import type { BaseType } from "./types.js";
import type { EncodedExpression } from "./serialize.js";
import { defaultMessageSize } from "./transport/default/message-size.js";
import {
  type OutgoingExpression,
  type OutgoingRpcMessage,
  type RpcSerializer,
  type RpcTransport,
} from "./serializer.js";

// Entry on the exports table.
type ExportTableEntry = {
  hook: StubHook,
  refcount: number,
  pull?: Promise<void>,

  // If true, the export should be automatically released (with refcount 1) after its "resolve"
  // or "reject" message is sent. This is set for exports created by ["stream"] messages.
  autoRelease?: boolean,

  // If this export was created by a ["pipe"] message, this holds the ReadableStream end of the
  // pipe. It is consumed (and set to undefined) when a ["readable", importId] expression
  // references this export.
  pipeReadable?: ReadableStream
};

// Entry on the imports table.
class ImportTableEntry<M, S> {
  constructor(public session: RpcSessionImpl<M, S>, public importId: number, pulling: boolean) {
    if (pulling) {
      this.activePull = Promise.withResolvers<void>();
    }
  }

  public localRefcount: number = 0;
  public remoteRefcount: number = 1;

  private activePull?: PromiseWithResolvers<void>;
  public resolution?: StubHook;

  // List of integer indexes into session.onBrokenCallbacks which are callbacks registered on
  // this import. Initialized on first use (so `undefined` is the same as an empty list).
  private onBrokenRegistrations?: number[];

  resolve(resolution: StubHook) {
    // TODO: Need embargo handling here? PayloadStubHook needs to be wrapped in a
    // PromiseStubHook awaiting the embargo I suppose. Previous notes on embargoes:
    // - Resolve message specifies last call that was received before the resolve. The introducer is
    //   responsible for any embargoes up to that point.
    // - Any further calls forwarded by the introducer after that point MUST immediately resolve to
    //   a forwarded call. The caller is responsible for ensuring the last of these is handed off
    //   before direct calls can be delivered.

    if (this.localRefcount == 0) {
      // Already disposed (canceled), so ignore the resolution and don't send a redundant release.
      resolution.dispose();
      return;
    }

    this.resolution = resolution;
    this.sendRelease();

    if (this.onBrokenRegistrations) {
      // Delete all our callback registrations from this session and re-register them on the
      // target stub.
      for (let i of this.onBrokenRegistrations) {
        let callback = this.session.onBrokenCallbacks[i];
        let endIndex = this.session.onBrokenCallbacks.length;
        resolution.onBroken(callback);
        if (this.session.onBrokenCallbacks[endIndex] === callback) {
          // Oh, calling onBroken() just registered the callback back on this connection again.
          // But when the connection dies, we want all the callbacks to be called in the order in
          // which they were registered. So we don't want this one pushed to the back of the line
          // here. So, let's remove the newly-added registration and keep the original.
          // TODO: This is quite hacky, think about whether this is really the right answer.
          delete this.session.onBrokenCallbacks[endIndex];
        } else {
          // The callback is now registered elsewhere, so delete it from our session.
          delete this.session.onBrokenCallbacks[i];
        }
      }
      this.onBrokenRegistrations = undefined;
    }

    if (this.activePull) {
      this.activePull.resolve();
      this.activePull = undefined;
    }
  }

  async awaitResolution(): Promise<RpcPayload> {
    if (!this.activePull) {
      this.session.sendPull(this.importId);
      this.activePull = Promise.withResolvers<void>();
    }
    await this.activePull.promise;
    return this.resolution!.pull();
  }

  dispose() {
    if (this.resolution) {
      this.resolution.dispose();
    } else {
      this.abort(new Error("RPC was canceled because the RpcPromise was disposed."));
      this.sendRelease();
    }
  }

  abort(error: any) {
    if (!this.resolution) {
      this.resolution = new ErrorStubHook(error);

      if (this.activePull) {
        this.activePull.reject(error);
        this.activePull = undefined;
      }

      // The RpcSession itself will have called all our callbacks so we don't need to track the
      // registrations anymore.
      this.onBrokenRegistrations = undefined;
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.resolution) {
      this.resolution.onBroken(callback);
    } else {
      let index = this.session.onBrokenCallbacks.length;
      this.session.onBrokenCallbacks.push(callback);

      if (!this.onBrokenRegistrations) this.onBrokenRegistrations = [];
      this.onBrokenRegistrations.push(index);
    }
  }

  private sendRelease() {
    if (this.remoteRefcount > 0) {
      this.session.sendRelease(this.importId, this.remoteRefcount);
      this.remoteRefcount = 0;
    }
  }
};

class RpcImportHook<M, S> extends StubHook {
  public entry?: ImportTableEntry<M, S>;  // undefined when we're disposed

  // `pulling` is true if we already expect that this import is going to be resolved later, and
  // null if this import is not allowed to be pulled (i.e. it's a stub not a promise).
  constructor(public isPromise: boolean, entry: ImportTableEntry<M, S>) {
    super();
    ++entry.localRefcount;
    this.entry = entry;
  }

  collectPath(path: PropertyPath): RpcImportHook<M, S> {
    return this;
  }

  getEntry(): ImportTableEntry<M, S> {
    if (this.entry) {
      return this.entry;
    } else {
      // Shouldn't get here in practice since the holding stub should have replaced the hook when
      // disposed.
      throw new Error("This RpcImportHook was already disposed.");
    }
  }

  // -------------------------------------------------------------------------------------
  // implements StubHook

  call(path: PropertyPath, args: RpcPayload): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.call(path, args);
    } else {
      return entry.session.sendCall(entry.importId, path, args);
    }
  }

  stream(path: PropertyPath, args: RpcPayload): {promise: Promise<void>, size?: number} {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.stream(path, args);
    } else {
      return entry.session.sendStream(entry.importId, path, args);
    }
  }

  map(path: PropertyPath, captures: StubHook[], instructions: EncodedExpression[]): StubHook {
    let entry: ImportTableEntry<M, S>;
    try {
      entry = this.getEntry();
    } catch (err) {
      for (let cap of captures) {
        cap.dispose();
      }
      throw err;
    }

    if (entry.resolution) {
      return entry.resolution.map(path, captures, instructions);
    } else {
      return entry.session.sendMap(entry.importId, path, captures, instructions);
    }
  }

  get(path: PropertyPath): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.get(path);
    } else {
      return entry.session.sendCall(entry.importId, path);
    }
  }

  dup(): RpcImportHook<M, S> {
    return new RpcImportHook<M, S>(false, this.getEntry());
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    let entry = this.getEntry();

    if (!this.isPromise) {
      throw new Error("Can't pull this hook because it's not a promise hook.");
    }

    if (entry.resolution) {
      return entry.resolution.pull();
    }

    return entry.awaitResolution();
  }

  ignoreUnhandledRejections(): void {
    // We don't actually have to do anything here because this method only has to ignore rejections
    // if pull() is *not* called, and if pull() is not called then we won't generate any rejections
    // anyway.
  }

  dispose(): void {
    let entry = this.entry;
    this.entry = undefined;
    if (entry) {
      if (--entry.localRefcount === 0) {
        entry.dispose();
      }
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.entry) {
      this.entry.onBroken(callback);
    }
  }
}

class RpcMainHook<M, S> extends RpcImportHook<M, S> {
  private session?: RpcSessionImpl<M, S>;

  constructor(entry: ImportTableEntry<M, S>) {
    super(false, entry);
    this.session = entry.session;
  }

  dispose(): void {
    if (this.session) {
      let session = this.session;
      this.session = undefined;
      session.shutdown();
    }
  }
}

/**
 * Options to customize behavior of an RPC session. All functions which start a session should
 * optionally accept this.
 */
export type RpcSessionOptions = {
  /**
   * If provided, this function will be called whenever an `Error` object is serialized (for any
   * reason, not just because it was thrown). This can be used to log errors, and also to redact
   * them.
   *
   * If `onSendError` returns an Error object, than object will be substituted in place of the
   * original. If it has a stack property, the stack will be sent to the client.
   *
   * If `onSendError` doesn't return anything (or is not provided at all), the default behavior is
   * to serialize the error with the stack omitted.
   */
  onSendError?: (error: Error) => Error | void;
};

class RpcSessionImpl<M, S> implements Importer, Exporter {
  private exports: Array<ExportTableEntry> = [];
  private reverseExports: Map<StubHook, ExportId> = new Map();
  private imports: Array<ImportTableEntry<M, S>> = [];
  private abortReason?: any;
  private cancelReadLoop?: (error: any) => void;
  private serializer: RpcSerializer<M, S>;

  // We assign positive numbers to imports we initiate, and negative numbers to exports we
  // initiate. So the next import ID is just `imports.length`, but the next export ID needs
  // to be tracked explicitly.
  private nextExportId = -1;

  // If set, call this when all incoming calls are complete.
  private onBatchDone?: Omit<PromiseWithResolvers<void>, "promise">;

  // How many promises is our peer expecting us to resolve?
  private pullCount = 0;

  // Sparse array of onBrokenCallback registrations. Items are strictly appended to the end but
  // may be deleted from the middle (hence leaving the array sparse).
  onBrokenCallbacks: ((error: any) => void)[] = [];

  constructor(private transport: RpcTransport<M, S>, mainHook: StubHook,
      private options: RpcSessionOptions) {
    this.serializer = transport.serializer;

    // Export zero is automatically the bootstrap object.
    this.exports.push({hook: mainHook, refcount: 1});

    // Import zero is the other side's bootstrap object.
    this.imports.push(new ImportTableEntry<M, S>(this, 0, false));

    this.readLoop().catch(err => this.abort(err));
  }

  // Should only be called once immediately after construction.
  getMainImport(): RpcImportHook<M, S> {
    return new RpcMainHook<M, S>(this.imports[0]);
  }

  shutdown(): void {
    // TODO(someday): Should we add some sort of "clean shutdown" mechanism? This gets the job
    //   done just fine for the moment.
    this.abort(new Error("RPC session was shut down by disposing the main stub"), false);
  }

  exportStub(hook: StubHook): ExportId {
    if (this.abortReason) throw this.abortReason;

    let existingExportId = this.reverseExports.get(hook);
    if (existingExportId !== undefined) {
      ++this.exports[existingExportId].refcount;
      return existingExportId;
    } else {
      let exportId = this.nextExportId--;
      this.exports[exportId] = { hook, refcount: 1 };
      this.reverseExports.set(hook, exportId);
      // TODO: Use onBroken().
      return exportId;
    }
  }

  exportPromise(hook: StubHook): ExportId {
    if (this.abortReason) throw this.abortReason;

    // Promises always use a new ID because otherwise the recipient could miss the resolution.
    let exportId = this.nextExportId--;
    this.exports[exportId] = { hook, refcount: 1 };
    this.reverseExports.set(hook, exportId);

    // Automatically start resolving any promises we send.
    this.ensureResolvingExport(exportId);
    return exportId;
  }

  unexport(ids: Array<ExportId>): void {
    for (let id of ids) {
      this.releaseExport(id, 1);
    }
  }

  private releaseExport(exportId: ExportId, refcount: number) {
    let entry = this.exports[exportId];
    if (!entry) {
      throw new Error(`no such export ID: ${exportId}`);
    }
    if (entry.refcount < refcount) {
      throw new Error(`refcount would go negative: ${entry.refcount} < ${refcount}`);
    }
    entry.refcount -= refcount;
    if (entry.refcount === 0) {
      delete this.exports[exportId];
      this.reverseExports.delete(entry.hook);
      entry.hook.dispose();
    }
  }

  onSendError(error: Error): Error | void {
    if (this.options.onSendError) {
      return this.options.onSendError(error);
    }
  }

  private ensureResolvingExport(exportId: ExportId) {
    let exp = this.exports[exportId];
    if (!exp) {
      throw new Error(`no such export ID: ${exportId}`);
    }
    if (!exp.pull) {
      let resolve = async () => {
        let hook = exp.hook;
        for (;;) {
          let payload = await hook.pull();
          if (payload.value instanceof RpcStub) {
            let {hook: inner, pathIfPromise} = unwrapStubAndPath(payload.value);
            if (pathIfPromise && pathIfPromise.length == 0) {
              if (this.getImport(hook) === undefined) {
                // Optimization: The resolution is just another promise, and it is not a promise
                // pointing back to the peer. So if we send a resolve message, it's just going to
                // resolve to another new promise export, which is just going to have to wait for
                // another resolve message later. This intermediate resolve message gives the peer
                // no useful information, so let's skip it and just wait for the chained
                // resolution.
                hook = inner;
                continue;
              }
            }
          }

          return payload;
        }
      };

      let autoRelease = exp.autoRelease;

      ++this.pullCount;
      exp.pull = resolve().then(
        payload => {
          // We don't transfer ownership of stubs in the payload since the payload
          // belongs to the hook which sticks around to handle pipelined requests.
          this.send({ kind: "resolve", exportId, value: payload.value, source: payload });
          if (autoRelease) this.releaseExport(exportId, 1);
        },
        error => {
          this.send({ kind: "reject", exportId, error });
          if (autoRelease) this.releaseExport(exportId, 1);
        }
      ).catch(
        error => {
          // If serialization failed, report the serialization error, which should
          // itself always be serializable.
          try {
            this.send({ kind: "reject", exportId, error });
            if (autoRelease) this.releaseExport(exportId, 1);
          } catch (error2) {
            // TODO: Shouldn't happen, now what?
            this.abort(error2);
          }
        }
      ).finally(() => {
        if (--this.pullCount === 0) {
          if (this.onBatchDone) {
            this.onBatchDone.resolve();
          }
        }
      });
    }
  }

  getImport(hook: StubHook): ImportId | undefined {
    if (hook instanceof RpcImportHook && hook.entry && hook.entry.session === this) {
      return hook.entry.importId;
    } else {
      return undefined;
    }
  }

  importStub(idx: ImportId): RpcImportHook<M, S> {
    if (this.abortReason) throw this.abortReason;

    let entry = this.imports[idx];
    if (!entry) {
      entry = new ImportTableEntry<M, S>(this, idx, false);
      this.imports[idx] = entry;
    }
    return new RpcImportHook<M, S>(/*isPromise=*/false, entry);
  }

  importPromise(idx: ImportId): StubHook {
    if (this.abortReason) throw this.abortReason;

    if (this.imports[idx]) {
      // Can't reuse an existing ID for a promise!
      return new ErrorStubHook(new Error(
          "Bug in RPC system: The peer sent a promise reusing an existing export ID."));
    }

    // Create an already-pulling hook.
    let entry = new ImportTableEntry<M, S>(this, idx, true);
    this.imports[idx] = entry;
    return new RpcImportHook<M, S>(/*isPromise=*/true, entry);
  }

  getExport(idx: ExportId): StubHook | undefined {
    return this.exports[idx]?.hook;
  }

  getPipeReadable(exportId: ExportId): ReadableStream {
    let entry = this.exports[exportId];
    if (!entry || !entry.pipeReadable) {
      throw new Error(`Export ${exportId} is not a pipe or its readable end was already consumed.`);
    }
    let readable = entry.pipeReadable;
    entry.pipeReadable = undefined;
    return readable;
  }

  createPipe(readable: ReadableStream, readableHook: StubHook): ImportId {
    if (this.abortReason) throw this.abortReason;

    this.send({ kind: "pipe" });

    let importId = this.imports.length;
    // The pipe import is not a promise -- it's immediately usable as a writable stream.
    let entry = new ImportTableEntry<M, S>(this, importId, false);
    this.imports.push(entry);

    // Create a proxy WritableStream from the import hook and pump the ReadableStream into it.
    let hook = new RpcImportHook<M, S>(/*isPromise=*/false, entry);
    let writable = streamImpl.createWritableStreamFromHook(hook);
    readable.pipeTo(writable).catch(() => {
      // Errors are handled by the writable stream's error handling -- either the write fails
      // and the writable side reports it, or the readable side errors and pipeTo aborts the
      // writable side. Either way, the hook's disposal will handle cleanup.
    }).finally(() => readableHook.dispose());

    return importId;
  }

  // Serializes and sends a message. Returns the byte/character length of the serialized
  // message. Serialization errors propagate to the caller: ensureResolvingExport's catch
  // turns them into rejects, matching today's "non-serializable return value" behavior.
  private send(msg: OutgoingRpcMessage): number {
    if (this.abortReason !== undefined) {
      // Ignore sends after we've aborted.
      return 0;
    }

    let wire = this.serializer.serialize(msg, this);

    this.transport.send(wire)
        // If send fails, abort the connection, but don't try to send an abort message since
        // that'll probably also fail.
        .catch(err => this.abort(err, false));

    return this.serializer.sizeOf ? this.serializer.sizeOf(wire) : defaultMessageSize(wire);
  }

  sendCall(id: ImportId, path: PropertyPath, args?: RpcPayload): RpcImportHook<M, S> {
    if (this.abortReason) throw this.abortReason;

    this.send({ kind: "push", expression: { kind: "call", importId: id, path, args } });

    // Serializing the payload takes ownership of all stubs within, so the payload itself
    // does not need to be disposed.

    let entry = new ImportTableEntry<M, S>(this, this.imports.length, false);
    this.imports.push(entry);
    return new RpcImportHook<M, S>(/*isPromise=*/true, entry);
  }

  sendStream(id: ImportId, path: PropertyPath, args: RpcPayload)
      : {promise: Promise<void>, size: number} {
    if (this.abortReason) throw this.abortReason;

    let size = this.send({
      kind: "stream",
      expression: { kind: "call", importId: id, path, args },
    });

    // Create the import entry in "already pulling" state (pulling=true), since stream messages
    // are automatically pulled. Set remoteRefcount to 0 so that resolve() won't send a release
    // message — the server implicitly releases the export after sending the resolve. Set
    // localRefcount to 1 so that resolve() doesn't treat this as already-disposed.
    let importId = this.imports.length;
    let entry = new ImportTableEntry<M, S>(this, importId, /*pulling=*/true);
    entry.remoteRefcount = 0;
    entry.localRefcount = 1;
    this.imports.push(entry);

    // Await the resolution, then dispose the result payload and clean up the import table entry.
    // (Normally, sendRelease() cleans up the import table, but since remoteRefcount is 0, we
    // need to do it manually.)
    let promise = entry.awaitResolution().then(
      p => { p.dispose(); delete this.imports[importId]; },
      err => { delete this.imports[importId]; throw err; }
    );

    return { promise, size };
  }

  sendMap(id: ImportId, path: PropertyPath, captures: StubHook[], instructions: EncodedExpression[])
      : RpcImportHook<M, S> {
    if (this.abortReason) {
      for (let cap of captures) {
        cap.dispose();
      }
      throw this.abortReason;
    }

    this.send({
      kind: "push",
      expression: { kind: "map", importId: id, path, captures, instructions },
    });

    let entry = new ImportTableEntry<M, S>(this, this.imports.length, false);
    this.imports.push(entry);
    return new RpcImportHook<M, S>(/*isPromise=*/true, entry);
  }

  sendPull(id: ImportId) {
    if (this.abortReason) throw this.abortReason;
    this.send({ kind: "pull", importId: id });
  }

  sendRelease(id: ImportId, remoteRefcount: number) {
    if (this.abortReason) return;
    this.send({ kind: "release", importId: id, refcount: remoteRefcount });
    delete this.imports[id];
  }

  abort(error: any, trySendAbortMessage: boolean = true) {
    // Don't double-abort.
    if (this.abortReason !== undefined) return;

    this.cancelReadLoop?.(error);
    this.cancelReadLoop = undefined;

    if (trySendAbortMessage) {
      try {
        let wire = this.serializer.serialize({ kind: "abort", reason: error }, this);
        this.transport.send(wire).catch(err => {});
      } catch (err) {
        // ignore, probably the whole reason we're aborting is because the transport is broken
      }
    }

    if (error === undefined) {
      // Shouldn't happen, but if it does, avoid setting `abortReason` to `undefined`.
      error = "undefined";
    }

    this.abortReason = error;
    if (this.onBatchDone) {
      this.onBatchDone.reject(error);
    }

    if (this.transport.abort) {
      // Call transport's abort handler, but guard against buggy app code.
      try {
        this.transport.abort(error);
      } catch (err) {
        // Treat as unhandled rejection.
        Promise.resolve(err);
      }
    }

    // WATCH OUT: these are sparse arrays. `for/let/of` will iterate only positive indexes
    // including deleted indexes -- bad. We need to use `for/let/in` instead.
    for (let i in this.onBrokenCallbacks) {
      try {
        this.onBrokenCallbacks[i](error);
      } catch (err) {
        // Treat as unhandled rejection.
        Promise.resolve(err);
      }
    }
    for (let i in this.imports) {
      this.imports[i].abort(error);
    }
    for (let i in this.exports) {
      this.exports[i].hook.dispose();
    }
  }

  private async readLoop() {
    while (!this.abortReason) {
      // Each receive needs its own abort promise so Promise.race() doesn't retain old reads.
      let readCanceled = Promise.withResolvers<never>();
      this.cancelReadLoop = readCanceled.reject;

      let wire: M;
      try {
        wire = await Promise.race([this.transport.receive(), readCanceled.promise]);
      } finally {
        if (this.cancelReadLoop === readCanceled.reject) {
          this.cancelReadLoop = undefined;
        }
      }

      if (this.abortReason) break;  // check again before processing

      let msg = this.serializer.deserialize(wire, this);

      switch (msg.kind) {
        case "push": {
          let hook = new PayloadStubHook(msg.payload);

          // It's possible for a rejection to occur before the client gets a chance to send
          // a "pull" message or to use the promise in a pipeline. We don't want that to be
          // treated as an unhandled rejection on our end.
          hook.ignoreUnhandledRejections();

          this.exports.push({ hook, refcount: 1 });
          continue;
        }

        case "stream": {
          // Like "push", but:
          // - Promise pipelining on the result is not supported.
          // - The export is automatically considered "pulled".
          // - Once the "resolve" is sent, the export is implicitly released.
          let hook = new PayloadStubHook(msg.payload);
          hook.ignoreUnhandledRejections();

          let exportId = this.exports.length;
          this.exports.push({ hook, refcount: 1, autoRelease: true });

          this.ensureResolvingExport(exportId);
          continue;
        }

        case "pipe": {
          // Create a TransformStream. The writable end becomes the export (so the sender can
          // write/close/abort it). The readable end is stashed for later retrieval via a
          // subsequent "readable" reference on the wire.
          let { readable, writable } = new TransformStream();
          let hook = streamImpl.createWritableStreamHook(writable);
          this.exports.push({ hook, refcount: 1, pipeReadable: readable });
          continue;
        }

        case "pull":
          this.ensureResolvingExport(msg.importId);
          continue;

        case "resolve": {
          // The sender's exportId is our importId.
          let imp = this.imports[msg.exportId];
          if (imp) {
            imp.resolve(new PayloadStubHook(msg.payload));
          } else {
            // We released this import already, so the resolution is unwanted. Dispose the
            // payload so any stubs it contains are released.
            msg.payload.dispose();
          }
          continue;
        }

        case "reject": {
          let imp = this.imports[msg.exportId];
          if (imp) {
            // HACK: We expect errors are always simple values (no stubs) so we can just
            //   pull the value out of the payload.
            msg.payload.dispose();  // should be a no-op
            imp.resolve(new ErrorStubHook(msg.payload.value));
          } else {
            msg.payload.dispose();
          }
          continue;
        }

        case "release":
          this.releaseExport(msg.importId, msg.refcount);
          continue;

        case "abort": {
          let payload = msg.payload;
          payload.dispose();  // just in case -- should be no-op
          this.abort(payload, false);
          break;
        }
      }
    }
  }

  async drain(): Promise<void> {
    if (this.abortReason) {
      throw this.abortReason;
    }

    if (this.pullCount > 0) {
      let {promise, resolve, reject} = Promise.withResolvers<void>();
      this.onBatchDone = {resolve, reject};
      await promise;
    }
  }

  getStats(): {imports: number, exports: number} {
    let result = {imports: 0, exports: 0};
    // We can't just use `.length` because the arrays can be sparse and can have negative indexes.
    for (let i in this.imports) {
      ++result.imports;
    }
    for (let i in this.exports) {
      ++result.exports;
    }
    return result;
  }
}

// Public interface that wraps RpcSession and hides private implementation details (even from
// JavaScript with no type enforcement).
export class RpcSession<M = string, S = BaseType> {
  #session: RpcSessionImpl<M, S>;
  #mainStub: RpcStub;

  constructor(transport: RpcTransport<M, S>, localMain?: any, options: RpcSessionOptions = {}) {
    let mainHook: StubHook;
    if (localMain) {
      mainHook = new PayloadStubHook(RpcPayload.fromAppReturn(localMain));
    } else {
      mainHook = new ErrorStubHook(new Error("This connection has no main object."));
    }
    this.#session = new RpcSessionImpl<M, S>(transport, mainHook, options);
    this.#mainStub = new RpcStub(this.#session.getMainImport());
  }

  getRemoteMain(): RpcStub {
    return this.#mainStub;
  }

  getStats(): {imports: number, exports: number} {
    return this.#session.getStats();
  }

  drain(): Promise<void> {
    return this.#session.drain();
  }
}

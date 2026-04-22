// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTarget as RpcTargetImpl, RpcStub as RpcStubImpl, RpcPromise as RpcPromiseImpl } from "./core.js";
import { serialize, deserialize } from "./serialize.js";
import { RpcSession as RpcSessionImpl, RpcSessionOptions } from "./rpc.js";
import type { RpcTransport, RpcSerializer } from "./serializer.js";
import { defaultRpcSerializer } from "./default-serializer.js";
import { BaseType, RpcTargetBranded, RpcCompatible, Stub, Stubify, __RPC_TARGET_BRAND } from "./types.js";
import { forceInitMap } from "./map.js";
import { forceInitStreams } from "./streams.js";

forceInitMap();
forceInitStreams();

// Re-export public API types.
export { serialize, deserialize, defaultRpcSerializer };
export type { RpcTransport, RpcSerializer, RpcSessionOptions, RpcCompatible, BaseType };

// Building blocks for authoring a custom RpcSerializer. These are the types and classes
// a custom wire format composes against; most users never need them.
export type {
  OutgoingRpcMessage, OutgoingExpression, IncomingRpcMessage,
} from "./serializer.js";
export type { Exporter, Importer, ExportId, ImportId } from "./serialize.js";
export { Devaluator, Evaluator } from "./serialize.js";
export type { PropertyPath } from "./core.js";
export { RpcPayload, StubHook, makeCallResultPayload } from "./core.js";

// Raw types that custom transports / serializers compose against.
export type { Stub, Provider, Stubify } from "./types.js";

/**
 * Represents a reference to a remote object, on which methods may be remotely invoked via RPC.
 *
 * `RpcStub` can represent any interface (when using TypeScript, you pass the specific interface
 * type as `T`, but this isn't known at runtime). The way this works is, `RpcStub` is actually a
 * `Proxy`. It makes itself appear as if every possible method / property name is defined. You can
 * invoke any method name, and the invocation will be sent to the server. If it turns out that no
 * such method exists on the remote object, an exception is thrown back. But the client does not
 * actually know, until that point, what methods exist.
 */
export type RpcStub<
  T extends RpcCompatible<T, SupportedTypes>,
  SupportedTypes,
> = Stub<T, SupportedTypes>;

// The runtime constructor intentionally keeps a single-generic signature so
// that `new RpcStub(value)` infers T directly. The second type parameter is
// only relevant for the type alias.
export const RpcStub: {
  new <T extends RpcCompatible<T>>(value: T): RpcStub<T, BaseType>;
} = <any>RpcStubImpl;

/**
 * Represents the result of an RPC call.
 *
 * Also used to represent properties. That is, `stub.foo` evaluates to an `RpcPromise` for the
 * value of `foo`.
 *
 * This isn't actually a JavaScript `Promise`. It does, however, have `then()`, `catch()`, and
 * `finally()` methods, like `Promise` does, and because it has a `then()` method, JavaScript will
 * allow you to treat it like a promise, e.g. you can `await` it.
 *
 * An `RpcPromise` is also a proxy, just like `RpcStub`, where calling methods or awaiting
 * properties will make a pipelined network request.
 *
 * Note that an `RpcPromise` is "lazy": the actual final result is not requested from the server
 * until you actually `await` the promise (or call `then()`, etc. on it). This is an optimization:
 * if you only intend to use the promise for pipelining and you never await it, then there's no
 * need to transmit the resolution!
 */
export type RpcPromise<
  T extends RpcCompatible<T, SupportedTypes>,
  SupportedTypes,
> = Stub<T, SupportedTypes> & Promise<Stubify<T, SupportedTypes>>;

export const RpcPromise: {
  // Note: Cannot construct directly!
} = <any>RpcPromiseImpl;

/**
 * Use to construct an `RpcSession` on top of a custom `RpcTransport`.
 *
 * Most people won't use this. You only need it if you've implemented your own `RpcTransport`.
 */
export interface RpcSession<
  T extends RpcCompatible<T, SupportedTypes>,
  Message,
  SupportedTypes,
> {
  getRemoteMain(): RpcStub<T, SupportedTypes>;
  getStats(): {imports: number, exports: number};

  // Waits until the peer is not waiting on any more promise resolutions from us. This is useful
  // in particular to decide when a batch is complete.
  drain(): Promise<void>;
}

export const RpcSession: {
  new <
    T extends RpcCompatible<T, SupportedTypes>,
    Message,
    SupportedTypes,
  >(
      transport: RpcTransport<Message, SupportedTypes>,
      localMain?: any,
      options?: RpcSessionOptions): RpcSession<T, Message, SupportedTypes>;
} = <any>RpcSessionImpl;

/**
 * Classes which are intended to be passed by reference and called over RPC must extend
 * `RpcTarget`. A class which does not extend `RpcTarget` (and which doesn't have built-in support
 * from the RPC system) cannot be passed in an RPC message at all; an exception will be thrown.
 *
 * Note that on Cloudflare Workers, this `RpcTarget` is an alias for the one exported from the
 * "cloudflare:workers" module, so they can be used interchangably.
 */
export interface RpcTarget extends RpcTargetBranded {};
export const RpcTarget: {
  new(): RpcTarget;
} = RpcTargetImpl;

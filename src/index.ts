// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcTarget as RpcTargetImpl, RpcStub as RpcStubImpl, RpcPromise as RpcPromiseImpl } from "./core.js";
import { serialize, deserialize } from "./serialize.js";
import { RpcSession as RpcSessionImpl, RpcSessionOptions } from "./rpc.js";
import type { RpcTransport, RpcSerializer } from "./serializer.js";
import { defaultRpcSerializer } from "./default-serializer.js";
import { BaseType, RpcTargetBranded, RpcCompatible, Stub, Stubify, __RPC_TARGET_BRAND } from "./types.js";
import { newWebSocketRpcSession as newWebSocketRpcSessionImpl,
         newWorkersWebSocketRpcResponse } from "./websocket.js";
import { newHttpBatchRpcSession as newHttpBatchRpcSessionImpl,
         newHttpBatchRpcResponse, nodeHttpBatchRpcResponse } from "./batch.js";
import { newMessagePortRpcSession as newMessagePortRpcSessionImpl } from "./messageport.js";
import { forceInitMap } from "./map.js";
import { forceInitStreams } from "./streams.js";

forceInitMap();
forceInitStreams();

// Re-export public API types.
export { serialize, deserialize, newWorkersWebSocketRpcResponse, newHttpBatchRpcResponse,
         nodeHttpBatchRpcResponse, defaultRpcSerializer };
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

// Hack the type system to make RpcStub's types work nicely!
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
  SupportedTypes = BaseType,
> = Stub<T, SupportedTypes>;
// The runtime constructor intentionally keeps the original single-generic signature: adding a
// defaulted `SupportedTypes` parameter here would break `new RpcStub(value)` inference (TS
// resolves `SupportedTypes` to `unknown` at the call site while the type alias uses `BaseType`,
// producing mismatched `Provider` shapes). Custom-typed stubs should be obtained through the
// type alias (e.g. on a session that produces them).
export const RpcStub: {
  new <T extends RpcCompatible<T>>(value: T): RpcStub<T>;
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
 * Note that and `RpcPromise` is "lazy": the actual final result is not requested from the server
 * until you actually `await` the promise (or call `then()`, etc. on it). This is an optimization:
 * if you only intend to use the promise for pipelining and you never await it, then there's no
 * need to transmit the resolution!
 */
export type RpcPromise<
  T extends RpcCompatible<T, SupportedTypes>,
  SupportedTypes = BaseType,
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
  T extends RpcCompatible<T, SupportedTypes> = undefined,
  Message = string,
  SupportedTypes = BaseType,
> {
  getRemoteMain(): RpcStub<T, SupportedTypes>;
  getStats(): {imports: number, exports: number};

  // Waits until the peer is not waiting on any more promise resolutions from us. This is useful
  // in particular to decide when a batch is complete.
  drain(): Promise<void>;
}
export const RpcSession: {
  new <
    T extends RpcCompatible<T, SupportedTypes> = undefined,
    Message = string,
    SupportedTypes = BaseType,
  >(
      transport: RpcTransport<Message, SupportedTypes>,
      localMain?: any,
      options?: RpcSessionOptions): RpcSession<T, Message, SupportedTypes>;
} = <any>RpcSessionImpl;

// RpcTarget needs some hackage too to brand it properly and account for the implementation
// conditionally being imported from "cloudflare:workers".
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

/**
 * Empty interface used as default type parameter for sessions where the other side doesn't
 * necessarily export a main interface.
 */
interface Empty {}

/**
 * Start a WebSocket session given either an already-open WebSocket or a URL.
 *
 * @param webSocket Either the `wss://` URL to connect to, or an already-open WebSocket object to
 * use.
 * @param localMain The main RPC interface to expose to the peer. Returns a stub for the main
 * interface exposed from the peer.
 */
export let newWebSocketRpcSession:<T extends RpcCompatible<T> = Empty>
    (webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions) => RpcStub<T> =
    <any>newWebSocketRpcSessionImpl;

/**
 * Initiate an HTTP batch session from the client side.
 *
 * The parameters to this method have exactly the same signature as `fetch()`, but the return
 * value is an RpcStub. You can customize anything about the request except for the method
 * (it will always be set to POST) and the body (which the RPC system will fill in).
 */
export let newHttpBatchRpcSession:<T extends RpcCompatible<T>>
    (urlOrRequest: string | Request, options?: RpcSessionOptions) => RpcStub<T> =
    <any>newHttpBatchRpcSessionImpl;

/**
 * Initiate an RPC session over a MessagePort, which is particularly useful for communicating
 * between an iframe and its parent frame in a browser context. Each side should call this function
 * on its own end of the MessageChannel.
 */
export let newMessagePortRpcSession:<T extends RpcCompatible<T> = Empty>
    (port: MessagePort, localMain?: any, options?: RpcSessionOptions) => RpcStub<T> =
    <any>newMessagePortRpcSessionImpl;

/**
 * Implements unified handling of HTTP-batch and WebSocket responses for the Cloudflare Workers
 * Runtime.
 *
 * SECURITY WARNING: This function accepts cross-origin requests. If you do not want this, you
 * should validate the `Origin` header before calling this, or use `newHttpBatchRpcSession()` and
 * `newWebSocketRpcSession()` directly with appropriate security measures for each type of request.
 * But if your API uses in-band authorization (i.e. it has an RPC method that takes the user's
 * credentials as parameters and returns the authorized API), then cross-origin requests should
 * be safe.
 */
export async function newWorkersRpcResponse(request: Request, localMain: any) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain);
    // Since we're exposing the same API over WebSocket, too, and WebSocket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}

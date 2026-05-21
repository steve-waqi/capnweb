// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { PropertyPath, RpcPayload, StubHook } from "./core.js";
import type { Exporter, Importer, EncodedExpression } from "./serialize.js";

// =======================================================================================
// Protocol messages
//
// These are the typed shapes rpc.ts produces and consumes. Together they describe every
// piece of data that crosses an RPC boundary; a custom RpcSerializer implements the whole
// wire format against this surface, nothing else.

// The three shapes that can appear inside a `push` or `stream`. `value` is a plain app
// value; `call` is a pipelined invocation (or property get, if `args` is omitted); `map`
// is a recorded .map() callback. `source` / `args` are the owning RpcPayloads -- required
// so the serializer can walk stubs correctly (stub ownership follows the payload).
export type OutgoingExpression =
  | { readonly kind: "value"; readonly value: any; readonly source: RpcPayload }
  | {
      readonly kind: "call";
      readonly importId: number;
      readonly path: PropertyPath;
      readonly args?: RpcPayload;
    }
  | {
      readonly kind: "map";
      readonly importId: number;
      readonly path: PropertyPath;
      readonly captures: readonly StubHook[];
      readonly instructions: readonly EncodedExpression[];
    };

// Every message the session can emit. IDs use the sender's perspective: `importId` is an
// entry in the sender's imports table; `exportId` is in the sender's exports table.
export type OutgoingRpcMessage =
  | { readonly kind: "push"; readonly expression: OutgoingExpression }
  | { readonly kind: "stream"; readonly expression: OutgoingExpression }
  | { readonly kind: "pipe" }
  | { readonly kind: "pull"; readonly importId: number }
  | {
      readonly kind: "resolve";
      readonly exportId: number;
      readonly value: any;
      readonly source: RpcPayload;
    }
  | { readonly kind: "reject"; readonly exportId: number; readonly error: any }
  | { readonly kind: "release"; readonly importId: number; readonly refcount: number }
  | { readonly kind: "abort"; readonly reason: any };

// The parsed shape of a received message. Value-bearing kinds already carry a hydrated
// RpcPayload -- the serializer has resolved any `call` / `map` expressions against the
// Importer. The receiver only dispatches on `kind`.
export type IncomingRpcMessage =
  | { readonly kind: "push"; readonly payload: RpcPayload }
  | { readonly kind: "stream"; readonly payload: RpcPayload }
  | { readonly kind: "pipe" }
  | { readonly kind: "pull"; readonly importId: number }
  | { readonly kind: "resolve"; readonly exportId: number; readonly payload: RpcPayload }
  | { readonly kind: "reject"; readonly exportId: number; readonly payload: RpcPayload }
  | { readonly kind: "release"; readonly importId: number; readonly refcount: number }
  | { readonly kind: "abort"; readonly payload: RpcPayload };

// =======================================================================================

// Owns the entire wire format: the envelope shape, the expression shape inside push/stream,
// and the value devaluation itself. Stubs, promises, and streams that appear in values MUST
// go through `exporter` (outgoing) and `importer` (incoming) -- these allocate IDs and track
// refcounts. See default-serializer.ts for the reference implementation.
//
// `SupportedTypes` is a phantom type parameter that drives the compile-time
// `RpcCompatible<T, SupportedTypes>` check. It is the set of leaf values this serializer can
// carry unchanged (beyond BaseType, which is always supported).
export interface RpcSerializer<Message, SupportedTypes> {
  // Errors thrown here propagate to the caller. For `resolve` / `reject` of a pulled export,
  // the session's resolution pipeline catches and converts the error into a reject message,
  // matching today's behavior for non-serializable return values. Errors during abort
  // serialization are swallowed since the session is already tearing down.
  serialize(message: OutgoingRpcMessage, exporter: Exporter): Message;

  // Errors thrown here abort the session: a malformed inbound message is unrecoverable.
  deserialize(message: Message, importer: Importer): IncomingRpcMessage;

  // Size of a serialized message, used for stream flow-control backpressure (sendStream
  // surfaces this as `size`). If omitted, the session falls back to `message.length ??
  // message.byteLength ?? 0`.
  sizeOf?(message: Message): number;
}

// =======================================================================================

// Interface for an RPC transport, which is a simple bidirectional message stream. Implement
// this (along with a matching RpcSerializer) if the built-in transports (HTTP batch, WebSocket,
// MessagePort) don't meet your needs. The `serializer` field ties the transport's wire format
// to the set of leaf values it preserves.
export interface RpcTransport<Message, SupportedTypes> {
  send(message: Message): Promise<void>;

  // Receives the next message sent by the other end.
  //
  // If and when the transport becomes disconnected, this will reject. The thrown error will
  // be propagated to all outstanding calls and future calls on any stubs associated with the
  // session. If there are no outstanding calls (and none are made in the future), then the
  // error does not propagate anywhere -- this is considered a "clean" shutdown.
  receive(): Promise<Message>;

  // Indicates that the RPC system has suffered an error that prevents the session from
  // continuing. The transport should ideally try to send any queued messages if it can, and
  // then close the connection. (It's not strictly necessary to deliver queued messages, but
  // the last message sent before abort() is called is often an "abort" message, which
  // communicates the error to the peer, so if that is dropped, the peer may have less
  // information about what happened.)
  abort?(reason: any): void;

  readonly serializer: RpcSerializer<Message, SupportedTypes>;
}

// Fallback `sizeOf` used when a serializer doesn't provide its own. Handles strings (UTF-16
// length) and typed arrays (byteLength). Unrecognized message types report 0.
export function defaultMessageSize(message: unknown): number {
  if (typeof message === "string") return message.length;
  if (message != null && typeof (message as { byteLength?: unknown }).byteLength === "number") {
    return (message as { byteLength: number }).byteLength;
  }
  return 0;
}

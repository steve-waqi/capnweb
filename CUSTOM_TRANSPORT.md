# Implementing a Custom Transport

This guide explains one common extension model in Cap'n Web:

- keep Cap'n Web's RPC semantics
- keep the default value walker (`Devaluator` / `Evaluator`)
- customize the wire format and transport

That means you are **not** designing a brand new RPC protocol. You are encoding Cap'n Web's
existing RPC IR in a different way.

This is the right model if you want to use:

- protobuf
- MessagePack
- CBOR
- binary frames
- structured clone objects
- a custom socket / stream / worker transport

## What is customizable

You can customize:

- the transport mechanism
- the outer message type, such as `string`, `Uint8Array`, or a plain object
- the envelope format, such as JSON, protobuf, or another binary schema

You are still encoding the same Cap'n Web message kinds:

- `push`
- `stream`
- `pipe`
- `pull`
- `resolve`
- `reject`
- `release`
- `abort`

and the same expression kinds:

- `value`
- `call`
- `map`

## The three layers

1. `RpcSession`
   Owns imports, exports, pipelining, refcounts, and dispatch.

2. `RpcSerializer`
   Encodes and decodes the Cap'n Web RPC IR.

3. `RpcTransport`
   Sends and receives serialized messages.

In practice:

- write a custom `RpcTransport` if you need a new connection type
- write a custom `RpcSerializer` if you need a new wire format
- most custom integrations need both together

## `RpcTransport`

```ts
export interface RpcTransport<Message, SupportedTypes> {
  send(message: Message): Promise<void>;
  receive(): Promise<Message>;
  abort?(reason: any): void;
  readonly serializer: RpcSerializer<Message, SupportedTypes>;
}
```

### What it does

- `send()` sends one already-serialized message
- `receive()` yields the next serialized message
- `abort()` optionally tears down the underlying connection
- `serializer` tells the session how to encode and decode the transport's `Message` type

The transport should be boring. It should mostly move bytes or objects around.

## `RpcSerializer`

```ts
export interface RpcSerializer<Message, SupportedTypes> {
  serialize(message: OutgoingRpcMessage, exporter: Exporter): Message;
  deserialize(message: Message, importer: Importer): IncomingRpcMessage;
  sizeOf?(message: Message): number;
}
```

### What it does

- `serialize()` converts a Cap'n Web outgoing message into your wire format
- `deserialize()` parses your wire format back into a Cap'n Web incoming message
- `sizeOf()` optionally reports message size for stream backpressure

This is the important mental model:

> A custom serializer is a custom codec for Cap'n Web's IR.

If you use protobuf, you are not replacing the IR. You are encoding the same IR with protobuf.

## Using the default `Devaluator` / `Evaluator`

This document focuses on the case where you:

- keep Cap'n Web's existing value codec
- customize only the outer envelope and transport

In that model, `Devaluator` and `Evaluator` handle the value-level transformation for the
default codec.

The default codec handles:

- ordinary primitives: `null`, booleans, finite numbers, strings
- plain objects and arrays
- JS values that the default codec rewrites into explicit protocol forms:
  - `undefined`
  - `Infinity`, `-Infinity`, `NaN`
  - `bigint`
  - `Date`
  - `Uint8Array` / bytes
  - `Headers`
  - `Request`
  - `Response`
  - `Error`
- RPC-aware values that the default codec rewrites into capability- or pipe-related references:
  - stubs
  - RPC promises
  - functions / `RpcTarget`s sent by reference
  - `ReadableStream`
  - `WritableStream`

### What "transformed" means

Some values can go on the wire almost directly. Others need a codec-specific representation.

In the default codec, for example:

- `undefined` becomes a tagged representation
- `NaN` and infinities become tagged values
- `Date` becomes a timestamp
- `Error` becomes a structured error representation
- a stub or promise becomes an import/export/pipeline reference tied to the session
- a stream becomes a pipe-related reference

These examples describe the default Cap'n Web value codec only. A custom serializer may support a
different set of special types, or no special leaf types beyond primitives, as long as it still
encodes the Cap'n Web RPC IR correctly.

## What `Exporter` and `Importer` are for

When `Devaluator` sees an RPC-aware value, it needs help from the session.

### `Exporter`

Used during serialization to:

- allocate export IDs for stubs and callbacks
- allocate promise IDs
- create pipes for streams
- roll back exports if serialization fails

### `Importer`

Used during deserialization to:

- turn import IDs back into local hooks
- reconstruct promise references
- retrieve pipe readables
- resolve pipelined references

If your serializer uses `Devaluator` / `Evaluator`, these hooks are what make capabilities,
promises, and streams work.

## A straightforward approach

If you want a custom transport without also inventing a new value codec, a simple approach is:

1. keep Cap'n Web's default value encoding
2. write a custom envelope format around it
3. use `Devaluator` to encode values and expressions
4. use `Evaluator` to decode them

This keeps the serializer focused on framing and transport concerns, while the default value codec
continues to handle JS values and RPC-aware references.

## Minimal pattern

At a high level, your serializer usually looks like this:

```ts
import {
  Devaluator,
  Evaluator,
  type Exporter,
  type Importer,
  type IncomingRpcMessage,
  type OutgoingRpcMessage,
} from "capnweb";
```

### Outgoing

For message kinds that carry a payload, encode the value using `Devaluator`.

```ts
const encoded = Devaluator.devaluate(message.value, undefined, exporter, message.source);
```

Then wrap that encoded value in your own envelope format.

### Incoming

After parsing your envelope, reconstruct the payload with `Evaluator`.

```ts
const payload = new Evaluator(importer).evaluate(parsed.encodedValue);
return { kind: "resolve", exportId: parsed.id, payload };
```

Create a new `Evaluator` for each decoded payload. Do not reuse one across messages.

## A small example

This example keeps Cap'n Web's default value encoding, but changes the outer message format to a
plain structured object. The transport then sends those objects over `MessagePort`.

```ts
import {
  BaseType,
  Devaluator,
  Evaluator,
  type Exporter,
  type Importer,
  type IncomingRpcMessage,
  type OutgoingRpcMessage,
  type RpcSerializer,
  type RpcTransport,
} from "capnweb";

type WireMessage =
  | { type: "pull"; id: number }
  | { type: "resolve"; id: number; value: unknown };

const serializer: RpcSerializer<WireMessage, BaseType> = {
  serialize(message: OutgoingRpcMessage, exporter: Exporter): WireMessage {
    switch (message.kind) {
      case "pull":
        return { type: "pull", id: message.importId };

      case "resolve":
        return {
          type: "resolve",
          id: message.exportId,
          value: Devaluator.devaluate(message.value, undefined, exporter, message.source),
        };

      default:
        throw new Error("example serializer only handles pull and resolve");
    }
  },

  deserialize(message: WireMessage, importer: Importer): IncomingRpcMessage {
    switch (message.type) {
      case "pull":
        return { kind: "pull", importId: message.id };

      case "resolve":
        return {
          kind: "resolve",
          exportId: message.id,
          payload: new Evaluator(importer).evaluate(message.value as any),
        };
    }
  },
};

export class MyPortTransport implements RpcTransport<WireMessage, BaseType> {
  readonly serializer = serializer;
  private queue: WireMessage[] = [];
  private waiter?: (message: WireMessage) => void;

  constructor(private port: MessagePort) {
    this.port.onmessage = event => {
      const message = event.data as WireMessage;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter(message);
      } else {
        this.queue.push(message);
      }
    };
  }

  async send(message: WireMessage): Promise<void> {
    this.port.postMessage(message);
  }

  async receive(): Promise<WireMessage> {
    const next = this.queue.shift();
    if (next) return next;

    return new Promise(resolve => {
      this.waiter = resolve;
    });
  }

  abort(): void {
    this.port.close();
  }
}
```

## Protobuf mental model

If you want protobuf, keep the same overall shape:

1. define protobuf messages for the Cap'n Web message and expression kinds
2. encode those messages in `serialize()`
3. parse them in `deserialize()`
4. if you are reusing the default value codec, still use `Devaluator` / `Evaluator` for payloads

That means protobuf is handling the outer wire schema, while `Devaluator` / `Evaluator` handle
the default JS-to-RPC value conversion.

## Common confusion

### "If I use `Devaluator`, is the custom serializer fake?"

No. It means you are reusing Cap'n Web's default value codec while customizing the transport or
framing layer.

### "Can I support only primitive leaf values?"

Yes. That is a valid serializer design. The `SupportedTypes` type parameter describes that.

### "What if I want my own full value codec too?"

That is possible. This guide just focuses on the narrower case where you keep the default value
codec and customize the outer transport and framing.

## Rule of thumb

If your goal is "send Cap'n Web RPC over my own wire format while keeping the default value
codec", this document's approach is the relevant one.
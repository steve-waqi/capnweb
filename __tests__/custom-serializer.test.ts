// Exercises a fully custom RpcSerializer paired with a generic transport. The wire
// messages are Uint8Array, the envelope is a 1-byte kind tag plus a JSON body, and the
// value walker is bespoke -- it carries URL as a native leaf (encoded ["url", string])
// alongside the usual primitives/arrays/objects/errors. The serializer does NOT reuse
// Devaluator/Evaluator; it hooks into the RPC machinery only via Exporter/Importer.

import { describe, expect, it } from "vitest";
import {
  makeCallResultPayload,
  RpcPayload,
  RpcSession,
  RpcTarget,
  type BaseType,
  type Exporter,
  type Importer,
  type IncomingRpcMessage,
  type OutgoingExpression,
  type OutgoingRpcMessage,
  type PropertyPath,
  type RpcSerializer,
  type RpcTransport,
} from "../src/index.js";

// Minimal value walker: handles primitives, arrays, plain objects, Error, and URL. Types
// outside that set throw. Stubs are not supported in value positions (this test doesn't
// exchange any).
function encodeValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return ["undefined"];
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return value;
  if (t === "bigint") return ["bigint", (value as bigint).toString()];
  if (value instanceof URL) return ["url", value.toString()];
  if (value instanceof Error) {
    return ["error", value.name, value.message];
  }
  if (Array.isArray(value)) {
    // Escape literal arrays in a one-element outer array, same as Devaluator does, so
    // decoders can distinguish ["tag", ...] from [element, ...].
    return [value.map(encodeValue)];
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k in value as Record<string, unknown>) {
      out[k] = encodeValue((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  throw new TypeError(`custom serializer cannot encode value: ${String(value)}`);
}

function decodeValue(wire: unknown): unknown {
  if (wire === null) return null;
  const t = typeof wire;
  if (t === "string" || t === "number" || t === "boolean") return wire;
  if (Array.isArray(wire)) {
    if (wire.length === 1 && Array.isArray(wire[0])) {
      return (wire[0] as unknown[]).map(decodeValue);
    }
    switch (wire[0]) {
      case "undefined":
        return undefined;
      case "bigint":
        return BigInt(wire[1] as string);
      case "url":
        return new URL(wire[1] as string);
      case "error": {
        const cls = ERROR_CLASSES[wire[1] as string] ?? Error;
        return new cls(wire[2] as string);
      }
    }
    throw new TypeError(`custom serializer cannot decode tagged value: ${JSON.stringify(wire)}`);
  }
  if (wire !== null && typeof wire === "object") {
    const out: Record<string, unknown> = {};
    for (const k in wire as Record<string, unknown>) {
      out[k] = decodeValue((wire as Record<string, unknown>)[k]);
    }
    return out;
  }
  throw new TypeError(`custom serializer cannot decode value: ${JSON.stringify(wire)}`);
}

const ERROR_CLASSES: Record<string, new (message: string) => Error> = {
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
};

// Message framing: one byte for the kind, then a UTF-8 JSON body. The body shape is
// custom (different from Cap'n Web's tagged-array envelopes).
const KIND_TAGS: Record<OutgoingRpcMessage["kind"] | IncomingRpcMessage["kind"], number> = {
  push: 0x01,
  stream: 0x02,
  pipe: 0x03,
  pull: 0x04,
  resolve: 0x05,
  reject: 0x06,
  release: 0x07,
  abort: 0x08,
};
const TAG_TO_KIND = Object.fromEntries(
  Object.entries(KIND_TAGS).map(([k, v]) => [v, k as OutgoingRpcMessage["kind"]])
) as Record<number, OutgoingRpcMessage["kind"]>;

function encodeExpression(expr: OutgoingExpression, _exporter: Exporter): unknown {
  switch (expr.kind) {
    case "value":
      return { v: encodeValue(expr.value) };
    case "call": {
      // `a` present -> invocation; absent -> property get.
      const body: { id: number; p: PropertyPath; a?: unknown[] } = {
        id: expr.importId,
        p: expr.path,
      };
      if (expr.args) {
        const raw = expr.args.value;
        if (!Array.isArray(raw)) {
          throw new TypeError("call args must be an array");
        }
        body.a = raw.map(encodeValue);
      }
      return body;
    }
    case "map":
      throw new Error("map() recordings are not exercised by this test");
  }
}

function encodeBody(msg: OutgoingRpcMessage, exporter: Exporter): unknown {
  switch (msg.kind) {
    case "push":
      return encodeExpression(msg.expression, exporter);
    case "stream":
      return encodeExpression(msg.expression, exporter);
    case "pipe":
      return null;
    case "pull":
      return { id: msg.importId };
    case "resolve":
      return { id: msg.exportId, v: encodeValue(msg.value) };
    case "reject":
      return { id: msg.exportId, e: encodeValue(msg.error) };
    case "release":
      return { id: msg.importId, n: msg.refcount };
    case "abort":
      return { r: encodeValue(msg.reason) };
  }
}

function decodePushPayload(body: unknown, importer: Importer): RpcPayload {
  if (body === null || typeof body !== "object") {
    throw new Error("push: bad body");
  }
  const obj = body as Record<string, unknown>;
  if ("v" in obj) {
    const payload = RpcPayload.forEvaluate([], []);
    payload.value = decodeValue(obj.v);
    return payload;
  }
  if ("id" in obj && "p" in obj) {
    const importId = obj.id as number;
    const path = obj.p as PropertyPath;
    const hookRef = importer.getExport(importId);
    if (!hookRef) throw new Error(`push: no such export ${importId}`);
    if ("a" in obj) {
      const argv = (obj.a as unknown[]).map(decodeValue);
      const argsPayload = RpcPayload.forEvaluate([], []);
      argsPayload.value = argv;
      return makeCallResultPayload(hookRef.call(path, argsPayload));
    }
    return makeCallResultPayload(hookRef.get(path));
  }
  throw new Error(`push: unrecognized body: ${JSON.stringify(obj)}`);
}

function decodeBody(tag: number, body: unknown, importer: Importer): IncomingRpcMessage {
  const kind = TAG_TO_KIND[tag];
  if (kind === undefined) throw new Error(`unknown kind tag: ${tag}`);

  const obj = body as Record<string, unknown>;
  switch (kind) {
    case "push":
      return { kind: "push", payload: decodePushPayload(body, importer) };
    case "stream":
      return { kind: "stream", payload: decodePushPayload(body, importer) };
    case "pipe":
      return { kind: "pipe" };
    case "pull":
      return { kind: "pull", importId: obj.id as number };
    case "resolve": {
      const payload = RpcPayload.forEvaluate([], []);
      payload.value = decodeValue(obj.v);
      return { kind: "resolve", exportId: obj.id as number, payload };
    }
    case "reject": {
      const payload = RpcPayload.forEvaluate([], []);
      payload.value = decodeValue(obj.e);
      return { kind: "reject", exportId: obj.id as number, payload };
    }
    case "release":
      return { kind: "release", importId: obj.id as number, refcount: obj.n as number };
    case "abort": {
      const payload = RpcPayload.forEvaluate([], []);
      payload.value = decodeValue(obj.r);
      return { kind: "abort", payload };
    }
  }
}

const urlAwareSerializer: RpcSerializer<Uint8Array, BaseType | URL> = {
  serialize(message, exporter) {
    const body = encodeBody(message, exporter);
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body ?? null));
    const out = new Uint8Array(bodyBytes.length + 1);
    out[0] = KIND_TAGS[message.kind];
    out.set(bodyBytes, 1);
    return out;
  },

  deserialize(message, importer) {
    if (message.byteLength < 1) throw new Error("empty message");
    const tag = message[0];
    const body = JSON.parse(new TextDecoder().decode(message.subarray(1)));
    return decodeBody(tag, body, importer);
  },

  sizeOf(message) {
    return message.byteLength;
  },
};

// Loopback transport pair carrying Uint8Array messages.
class LoopbackTransport implements RpcTransport<Uint8Array, BaseType | URL> {
  readonly serializer = urlAwareSerializer;

  private queue: Uint8Array[] = [];
  private waiter?: (msg: Uint8Array) => void;
  private rejecter?: (err: unknown) => void;
  private error?: unknown;

  readonly captured: Uint8Array[] = [];
  partner!: LoopbackTransport;

  async send(message: Uint8Array): Promise<void> {
    this.captured.push(message);
    this.partner.deliver(message);
  }

  async receive(): Promise<Uint8Array> {
    if (this.error !== undefined) throw this.error;
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.rejecter = reject;
    });
  }

  abort(reason: unknown): void {
    this.error = reason;
    if (this.rejecter) {
      this.rejecter(reason);
      this.waiter = undefined;
      this.rejecter = undefined;
    }
  }

  private deliver(msg: Uint8Array) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.rejecter = undefined;
      w(msg);
    } else {
      this.queue.push(msg);
    }
  }
}

function pair(): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.partner = b;
  b.partner = a;
  return [a, b];
}

async function pumpMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

class UrlService extends RpcTarget {
  echoUrl(url: URL): URL {
    return new URL(url.toString());
  }

  canonicalHost(url: URL): string {
    return url.hostname;
  }

  pair(a: URL, b: URL): { first: URL; second: URL } {
    return { first: a, second: b };
  }

  explode(): URL {
    throw new TypeError("nope");
  }
}

describe("custom serializer + generic transport", () => {
  it("round-trips URL values through a binary wire format", async () => {
    const [clientT, serverT] = pair();
    new RpcSession<undefined, Uint8Array, BaseType | URL>(serverT, new UrlService());
    const client = new RpcSession<UrlService, Uint8Array, BaseType | URL>(clientT);
    const api = client.getRemoteMain() as any;

    const echoed = await api.echoUrl(new URL("https://example.com/a?b=1"));
    expect(echoed).toBeInstanceOf(URL);
    expect((echoed as URL).toString()).toBe("https://example.com/a?b=1");

    const host = await api.canonicalHost(new URL("https://hello.world:1234/x"));
    expect(host).toBe("hello.world");

    const nested = await api.pair(
      new URL("https://a.example/"),
      new URL("https://b.example/"),
    );
    expect(nested.first).toBeInstanceOf(URL);
    expect(nested.second).toBeInstanceOf(URL);
    expect((nested.first as URL).hostname).toBe("a.example");
    expect((nested.second as URL).hostname).toBe("b.example");

    await pumpMicrotasks();
  });

  it("propagates errors through the custom wire", async () => {
    const [clientT, serverT] = pair();
    new RpcSession<undefined, Uint8Array, BaseType | URL>(serverT, new UrlService());
    const client = new RpcSession<UrlService, Uint8Array, BaseType | URL>(clientT);
    const api = client.getRemoteMain() as any;

    await expect(api.explode()).rejects.toThrow("nope");

    await pumpMicrotasks();
  });

  it("does not emit Cap'n Web's envelope tags on the wire", async () => {
    const [clientT, serverT] = pair();
    new RpcSession<undefined, Uint8Array, BaseType | URL>(serverT, new UrlService());
    const client = new RpcSession<UrlService, Uint8Array, BaseType | URL>(clientT);
    const api = client.getRemoteMain() as any;
    await api.echoUrl(new URL("https://example.com/"));
    await pumpMicrotasks();

    const allBytes = [
      ...clientT.captured.map((b) => new TextDecoder().decode(b)),
      ...serverT.captured.map((b) => new TextDecoder().decode(b)),
    ].join("");

    // None of Cap'n Web's envelope/expression tags should appear; our walker uses
    // numeric kind bytes and a different body shape.
    for (const tag of ['"push"', '"stream"', '"pipe"', '"resolve"',
                       '"reject"', '"release"', '"abort"',
                       '"pipeline"', '"remap"']) {
      expect(allBytes, `found tag ${tag}`).not.toContain(tag);
    }

    // But our own "url" tag does, proving URL travels as a native leaf.
    expect(allBytes).toContain('"url"');
  });
});

// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Reference implementation of RpcSerializer and the wire format the built-in transports use.
// Every tagged-array literal (["push", ...], ["pipeline", ...], ["remap", ...], etc.) and
// every JSON.stringify/parse call in Cap'n Web lives in this file; rpc.ts no longer knows
// about them. Custom serializers can import Devaluator/Evaluator from ./serialize.js to
// keep the value-level encoding and swap only the framing.

import { Devaluator, Evaluator, type Exporter, type Importer } from "./serialize.js";
import type { RpcPayload } from "./core.js";
import {
  defaultMessageSize,
  type IncomingRpcMessage,
  type OutgoingExpression,
  type OutgoingRpcMessage,
  type RpcSerializer,
} from "./serializer.js";
import type { BaseType } from "./types.js";

function encodeExpression(expr: OutgoingExpression, exporter: Exporter): unknown {
  switch (expr.kind) {
    case "value":
      return Devaluator.devaluate(expr.value, undefined, exporter, expr.source);

    case "call": {
      // ["pipeline", importId, path] for a property get, or ["pipeline", importId, path,
      // devaluedArgs] for a method call.
      let wire: unknown[] = ["pipeline", expr.importId, expr.path];
      if (expr.args) {
        let devalued = Devaluator.devaluate(expr.args.value, undefined, exporter, expr.args);
        // HACK: Since args is an array, devaluator wraps it in a second array. Unwrap it
        // so the wire has ["pipeline", id, path, args] not ["pipeline", id, path, [args]].
        // TODO: Clean this up somehow.
        wire.push((devalued as unknown[])[0]);
      }
      return wire;
    }

    case "map": {
      // Captures are stub hooks already held by us; they go on the wire as ["import", id]
      // when the peer already has them, or ["export", id] when we export them fresh.
      let devaluedCaptures = expr.captures.map(hook => {
        let importId = exporter.getImport(hook);
        if (importId !== undefined) return ["import", importId];
        return ["export", exporter.exportStub(hook)];
      });
      return ["remap", expr.importId, expr.path, devaluedCaptures, expr.instructions];
    }
  }
}

function encodeMessage(msg: OutgoingRpcMessage, exporter: Exporter): unknown {
  switch (msg.kind) {
    case "push":
      return ["push", encodeExpression(msg.expression, exporter)];
    case "stream":
      return ["stream", encodeExpression(msg.expression, exporter)];
    case "pipe":
      return ["pipe"];
    case "pull":
      return ["pull", msg.importId];
    case "resolve":
      return ["resolve", msg.exportId,
          Devaluator.devaluate(msg.value, undefined, exporter, msg.source)];
    case "reject":
      return ["reject", msg.exportId, Devaluator.devaluate(msg.error, undefined, exporter)];
    case "release":
      return ["release", msg.importId, msg.refcount];
    case "abort":
      return ["abort", Devaluator.devaluate(msg.reason, undefined, exporter)];
  }
}

// Each evaluator instance keeps its own hooks/promises arrays, so we cannot share one
// across messages.
function evaluatePayload(wire: unknown, importer: Importer): RpcPayload {
  return new Evaluator(importer).evaluate(wire);
}

function decodeMessage(raw: unknown, importer: Importer): IncomingRpcMessage {
  if (!(raw instanceof Array) || raw.length < 1) {
    throw new Error(`bad RPC message: ${JSON.stringify(raw)}`);
  }

  switch (raw[0]) {
    case "push":
      if (raw.length > 1) {
        return { kind: "push", payload: evaluatePayload(raw[1], importer) };
      }
      break;

    case "stream":
      if (raw.length > 1) {
        return { kind: "stream", payload: evaluatePayload(raw[1], importer) };
      }
      break;

    case "pipe":
      return { kind: "pipe" };

    case "pull":
      if (typeof raw[1] === "number") {
        return { kind: "pull", importId: raw[1] };
      }
      break;

    case "resolve":
      if (typeof raw[1] === "number" && raw.length > 2) {
        return { kind: "resolve", exportId: raw[1],
                 payload: evaluatePayload(raw[2], importer) };
      }
      break;

    case "reject":
      if (typeof raw[1] === "number" && raw.length > 2) {
        return { kind: "reject", exportId: raw[1],
                 payload: evaluatePayload(raw[2], importer) };
      }
      break;

    case "release":
      if (typeof raw[1] === "number" && typeof raw[2] === "number") {
        return { kind: "release", importId: raw[1], refcount: raw[2] };
      }
      break;

    case "abort":
      return { kind: "abort", payload: evaluatePayload(raw[1], importer) };
  }

  throw new Error(`bad RPC message: ${JSON.stringify(raw)}`);
}

// Cap'n Web's built-in wire format: JSON-encoded tagged arrays. Used by every built-in
// transport (WebSocket, HTTP batch, MessagePort).
export const defaultRpcSerializer: RpcSerializer<string, BaseType> = {
  serialize(message, exporter) {
    return JSON.stringify(encodeMessage(message, exporter));
  },

  deserialize(message, importer) {
    return decodeMessage(JSON.parse(message), importer);
  },

  sizeOf(message) {
    return defaultMessageSize(message);
  },
};

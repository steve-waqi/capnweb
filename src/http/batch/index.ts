// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcSession as RpcSessionImpl, RpcSessionOptions } from "../../rpc.js";
import type { RpcSerializer, RpcTransport } from "../../serializer.js";
import { defaultRpcSerializer } from "../../default-serializer.js";
import type { BaseType } from "../../types.js";
import type { RpcCompatible } from "../../index.js";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";
import type { SupportedTypes, RpcStub } from "./types.js";

export type { RpcStub, RpcPromise, RpcSession, RpcSessionOptions, RpcTarget, RpcTransport, RpcSerializer, SupportedTypes } from "./types.js";

// ---------------------------------------------------------------------------
// Client-side batch transport
// ---------------------------------------------------------------------------

type SendBatchFunc = (batch: string[]) => Promise<string[]>;

class BatchClientTransport implements RpcTransport<string, BaseType> {
  readonly serializer: RpcSerializer<string, BaseType> = defaultRpcSerializer;

  constructor(sendBatch: SendBatchFunc) {
    this.#promise = this.#scheduleBatch(sendBatch);
  }

  #promise: Promise<void>;
  #aborted: any;

  #batchToSend: string[] | null = [];
  #batchToReceive: string[] | null = null;

  async send(message: string): Promise<void> {
    if (this.#batchToSend !== null) {
      this.#batchToSend.push(message);
    }
  }

  async receive(): Promise<string> {
    if (!this.#batchToReceive) {
      await this.#promise;
    }

    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      throw new Error("Batch RPC request ended.");
    }
  }

  abort?(reason: any): void {
    this.#aborted = reason;
  }

  async #scheduleBatch(sendBatch: SendBatchFunc) {
    await new Promise(resolve => setTimeout(resolve, 0));

    if (this.#aborted !== undefined) {
      throw this.#aborted;
    }

    let batch = this.#batchToSend!;
    this.#batchToSend = null;
    this.#batchToReceive = await sendBatch(batch);
  }
}

export function newHttpBatchRpcSession<
  T extends RpcCompatible<T, SupportedTypes> = undefined,
>(
  urlOrRequest: string | Request, options?: RpcSessionOptions
): RpcStub<T> {
  let sendBatch: SendBatchFunc = async (batch: string[]) => {
    let response = await fetch(urlOrRequest, {
      method: "POST",
      body: batch.join("\n"),
    });

    if (!response.ok) {
      response.body?.cancel();
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    let body = await response.text();
    return body == "" ? [] : body.split("\n");
  };

  let transport = new BatchClientTransport(sendBatch);
  let rpc = new RpcSessionImpl(transport, undefined, options);
  return rpc.getRemoteMain() as any;
}

// ---------------------------------------------------------------------------
// Server-side batch transport
// ---------------------------------------------------------------------------

class BatchServerTransport implements RpcTransport<string, BaseType> {
  readonly serializer: RpcSerializer<string, BaseType> = defaultRpcSerializer;

  constructor(batch: string[]) {
    this.#batchToReceive = batch;
  }

  #batchToSend: string[] = [];
  #batchToReceive: string[];
  #allReceived: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  async send(message: string): Promise<void> {
    this.#batchToSend.push(message);
  }

  async receive(): Promise<string> {
    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      this.#allReceived.resolve();
      return new Promise(r => {});
    }
  }

  abort?(reason: any): void {
    this.#allReceived.reject(reason);
  }

  whenAllReceived() {
    return this.#allReceived.promise;
  }

  getResponseBody(): string {
    return this.#batchToSend.join("\n");
  }
}

/**
 * Implements the server end of an HTTP batch session, using standard Fetch API types to represent
 * HTTP requests and responses.
 *
 * @param request The request received from the client initiating the session.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options.
 * @returns The HTTP response to return to the client. Note that the returned object has mutable
 *     headers, so you can modify them using e.g. `response.headers.set("Foo", "bar")`.
 */
export async function newHttpBatchRpcResponse(
    request: Request, localMain: any, options?: RpcSessionOptions): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint only accepts POST requests.", { status: 405 });
  }

  let body = await request.text();
  let batch = body === "" ? [] : body.split("\n");

  let transport = new BatchServerTransport(batch);
  let rpc = new RpcSessionImpl(transport, localMain, options);

  await transport.whenAllReceived();
  await rpc.drain();

  return new Response(transport.getResponseBody());
}

/**
 * Implements the server end of an HTTP batch session using traditional Node.js HTTP APIs.
 *
 * @param request The request received from the client initiating the session.
 * @param response The response object, to which the response should be written.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options. You can also pass headers to set on the response.
 */
export async function nodeHttpBatchRpcResponse(
    request: IncomingMessage, response: ServerResponse,
    localMain: any,
    options?: RpcSessionOptions & {
      headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
    }): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, "This endpoint only accepts POST requests.");
  }

  let body = await new Promise<string>((resolve, reject) => {
    let chunks: Buffer[] = [];
    request.on("data", chunk => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString());
    });
    request.on("error", reject);
  });
  let batch = body === "" ? [] : body.split("\n");

  let transport = new BatchServerTransport(batch);
  let rpc = new RpcSessionImpl(transport, localMain, options);

  await transport.whenAllReceived();
  await rpc.drain();

  response.writeHead(200, options?.headers);
  response.end(transport.getResponseBody());
}

// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcSession as RpcSessionImpl, RpcSessionOptions } from "../rpc.js";
import type { RpcSerializer, RpcTransport } from "../serializer.js";
import { defaultRpcSerializer } from "../default-serializer.js";
import type { BaseType } from "../types.js";
import type { RpcCompatible } from "../index.js";
import type { SupportedTypes, RpcStub } from "./types.js";

export type { RpcStub, RpcPromise, RpcSession, RpcSessionOptions, RpcTarget, RpcTransport, RpcSerializer, SupportedTypes } from "./types.js";

// ---------------------------------------------------------------------------
// MessagePort transport
// ---------------------------------------------------------------------------

class MessagePortTransport implements RpcTransport<string, BaseType> {
  readonly serializer: RpcSerializer<string, BaseType> = defaultRpcSerializer;

  constructor (port: MessagePort) {
    this.#port = port;

    // Start listening for messages
    port.start();

    port.addEventListener("message", (event: MessageEvent<any>) => {
      if (this.#error) {
        // Ignore further messages.
      } else if (event.data === null) {
        // Peer is signaling that they're closing the connection
        this.#receivedError(new Error("Peer closed MessagePort connection."));
      } else if (typeof event.data === "string") {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      } else {
        this.#receivedError(new TypeError("Received non-string message from MessagePort."));
      }
    });

    port.addEventListener("messageerror", (event: MessageEvent) => {
      this.#receivedError(new Error("MessagePort message error."));
    });
  }

  #port: MessagePort;
  #receiveResolver?: (message: string) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: string[] = [];
  #error?: any;

  async send(message: string): Promise<void> {
    if (this.#error) {
      throw this.#error;
    }
    this.#port.postMessage(message);
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<string>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    // Send close signal to peer before closing
    try {
      this.#port.postMessage(null);
    } catch (err) {
      // Ignore errors when sending close signal - port might already be closed
    }

    this.#port.close();

    if (!this.#error) {
      this.#error = reason;
    }
  }

  #receivedError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export function newMessagePortRpcSession<
  T extends RpcCompatible<T, SupportedTypes> = undefined,
>(
  port: MessagePort, localMain?: any, options?: RpcSessionOptions
): RpcStub<T> {
  let transport = new MessagePortTransport(port);
  let rpc = new RpcSessionImpl(transport, localMain, options);
  return rpc.getRemoteMain() as any;
}

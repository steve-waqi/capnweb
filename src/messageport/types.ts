// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcSession as RpcSessionImpl, RpcSessionOptions } from "../rpc.js";
import { RpcStub as GenericRpcStub, RpcPromise as GenericRpcPromise, RpcSession as GenericRpcSession, RpcTarget, BaseType, type RpcCompatible, type RpcSerializer, type RpcTransport } from "../index.js";
import type { Stub, Stubify } from "../types.js";

export type SupportedTypes = BaseType;

export type RpcStub<T extends RpcCompatible<T, SupportedTypes>> =
  Stub<T, SupportedTypes>;

export type RpcPromise<T extends RpcCompatible<T, SupportedTypes>> =
  RpcStub<T> & Promise<Stubify<T, SupportedTypes>>;

export interface RpcSession<T extends RpcCompatible<T, SupportedTypes> = undefined> {
  getRemoteMain(): RpcStub<T>;
  getStats(): { imports: number; exports: number };
  drain(): Promise<void>;
}

export const RpcSession: {
  new <T extends RpcCompatible<T, SupportedTypes> = undefined>(
    transport: RpcTransport<string, SupportedTypes>,
    localMain?: any,
    options?: RpcSessionOptions
  ): RpcSession<T>;
} = <any>RpcSessionImpl;

export { RpcTarget };
export type { RpcSessionOptions } from "../rpc.js";
export type { RpcTransport, RpcSerializer } from "../serializer.js";

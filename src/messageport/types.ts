// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Concrete type aliases for the built-in MessagePort transport (string messages, BaseType supported).

import {
  BaseType,
  type RpcSession as GenericRpcSession,
  type RpcCompatible
} from "../index.js";
import type { Stub, Stubify } from "../types.js";

export type SupportedTypes = BaseType;

export type RpcStub<T extends RpcCompatible<T, SupportedTypes>> =
  Stub<T, SupportedTypes>;

export type RpcPromise<T extends RpcCompatible<T, SupportedTypes>> =
  RpcStub<T> & Promise<Stubify<T, SupportedTypes>>;

// Alias the generic session type with Message = string and SupportedTypes = BaseType baked in.
export type RpcSession<T extends RpcCompatible<T, SupportedTypes> = undefined> =
  GenericRpcSession<T, string, SupportedTypes>;

export type { RpcSessionOptions } from "../rpc.js";
export type { RpcSerializer, RpcTransport } from "../serializer.js";


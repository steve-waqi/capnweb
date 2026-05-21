// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { EncodedExpression, EncodedValue } from "../../serialize.js";

// Tagged-array wire envelope used by the built-in JSON serializer and transports.
export type EncodedMessage =
  | ["push", EncodedExpression]
  | ["stream", EncodedExpression]
  | ["pipe"]
  | ["pull", number]
  | ["resolve", number, EncodedValue]
  | ["reject", number, EncodedValue]
  | ["release", number, number]
  | ["abort", EncodedValue];

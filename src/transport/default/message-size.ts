// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Fallback `sizeOf` for the default string wire format. Handles strings (UTF-16 length) and
// typed arrays (byteLength). Unrecognized message types report 0.
export function defaultMessageSize(message: unknown): number {
  if (typeof message === "string") return message.length;
  if (message != null && typeof (message as { byteLength?: unknown }).byteLength === "number") {
    return (message as { byteLength: number }).byteLength;
  }
  return 0;
}

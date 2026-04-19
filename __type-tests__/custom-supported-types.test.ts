import {
  RpcTarget,
  type BaseType,
  type RpcCompatible,
  type RpcStub,
} from "../src/index.js"
import type { Provider, Stub, Stubify } from "../src/types.js"
import type { Equal, Expect } from "./helpers.js"

// URL stands in for any extra "leaf" a transport might preserve natively (e.g. because it uses
// structured clone). It matters that it has object shape, so the default machinery would
// otherwise descend into its properties.
type MyExtras = BaseType | URL

class Counter extends RpcTarget {
  increment(by: number = 1): number {
    return by
  }
}

interface Api {
  getUrl(): Promise<URL>
  getCounter(): Counter
  getRecord(): Promise<{ u: URL; label: string; counter: Counter }>
  getPair(): Promise<[URL, Counter]>
  echoUrl(url: URL): Promise<URL>
}

// RpcCompatible must accept a non-BaseType leaf when it appears in SupportedTypes.
type _ExtraAcceptsUrl = Expect<
  Equal<URL extends RpcCompatible<URL, MyExtras> ? true : false, true>
>

// Stubify keeps SupportedTypes members opaque and still stubifies Stubable siblings.
type _StubifiedUrl = Expect<Equal<Stubify<URL, MyExtras>, URL>>

type _StubifiedRecord = Stubify<{ u: URL; label: string; counter: Counter }, MyExtras>
type _RecordKeepsUrl = Expect<Equal<_StubifiedRecord["u"], URL>>
type _RecordKeepsLabel = Expect<Equal<_StubifiedRecord["label"], string>>
type _RecordStubifiesCounter = Expect<
  Equal<_StubifiedRecord["counter"], Stub<Counter, MyExtras>>
>

type _StubifiedTuple = Stubify<[URL, Counter], MyExtras>
type _TupleKeepsUrl = Expect<Equal<_StubifiedTuple[0], URL>>
type _TupleStubifiesCounter = Expect<
  Equal<_StubifiedTuple[1], Stub<Counter, MyExtras>>
>

// Sanity check that SupportedTypes actually changes behavior: with the default, URL is not a
// leaf and Stubify recurses into its shape, so the result no longer equals `URL`.
type _DefaultDiffersFromLeaf = Expect<
  Equal<Stubify<URL>, URL> extends true ? false : true
>

// Provider / RpcStub surface threads SupportedTypes through arg and return positions.
type _ApiProvider = Provider<Api, MyExtras>

// Arguments of a SupportedTypes leaf stay bare — no `Stub | URL` union gets injected.
type _EchoUrlArg = Parameters<_ApiProvider["echoUrl"]>[0]
type _EchoUrlArgAcceptsUrl = Expect<URL extends _EchoUrlArg ? true : false>

type _NestedReturn = Awaited<ReturnType<_ApiProvider["getRecord"]>>
type _NestedKeepsUrl = Expect<Equal<_NestedReturn["u"], URL>>

declare const customApi: RpcStub<Api, MyExtras>
type _CustomApiKeepsUrl = Expect<
  Equal<Awaited<ReturnType<typeof customApi.getRecord>>["u"], URL>
>

import type { ReactNode } from "react";
import { expectTypeOf, test } from "vitest";
import type {
  ArmPaintIsData,
  DiffLineAnchor,
  DiffLineAnchorIsData,
} from "@/features/diff/DiffSurface";
import type { Assert, IsData } from "@/features/diff/held-data";

// `tsc -b` checks this file (tsconfig.test.json). Every alias is exported, so an
// unused-local error can never satisfy a directive: each `@ts-expect-error`
// below is met only by `Assert` refusing its shape (each one reaches something
// callable, but for the ones marked as refused on purpose), and a directive
// left unmet fails the build (TS2578).

type AnchorRenderer = (row: string) => ReactNode;
interface CallableRenderer {
  (row: string): ReactNode;
}
interface Nested {
  a: { b: readonly { c?: AnchorRenderer }[] };
}
type Defaulted<T = () => void> = (value: T) => void;
type WithCallback = DiffLineAnchor & { onDone: () => void };
// biome-ignore lint/suspicious/noExplicitAny: the control is `any` itself
type AnchorWithAny = DiffLineAnchor & { extra?: any };
class PrivateCallback {
  private run = () => undefined;
  readonly id = this.run.name;
}
class ProtectedCallback {
  protected run = () => undefined;
  readonly id = this.run.name;
}
class HashPrivateCallback {
  #run = () => undefined;
  readonly id = this.#run.name;
}
class PrivateNumber {
  private n = 1;
  readonly id = this.n;
}
class PublicData {
  readonly id = "d";
  line = 1;
}
type Plain = { id: string };
type Runs = { id: string; run(): void };
type Brand = string & { readonly __brand: unique symbol };
type LineNo = number & { readonly __brand: "line" };
interface Box<T> {
  v: T;
}
interface Tree {
  value: string;
  kids: readonly Tree[];
}
interface TreeWithVisitor {
  value: string;
  kids: readonly TreeWithVisitor[];
  visit?: () => void;
}
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
interface Outer {
  id: string;
  child?: Inner;
}
interface Inner {
  id: string;
  child?: Inner;
  run?: () => void;
}
interface Growing<T> {
  value: T;
  next?: Growing<T[]>;
}
type IndexHides = {
  [key: string]: { id: string };
  special: { id: string; run(): void };
};
type AnchorIndexHides = DiffLineAnchor & { extra?: IndexHides };
type NumberIndexHides = {
  [key: number]: { id: string };
  0: { id: string; run(): void };
};
type PatternIndexHides = {
  [key: `on${string}`]: { id: string };
  onSpecial: { id: string; run(): void };
};
type IndexData = {
  [key: string]: { id: string };
  special: { id: string; line: number };
};
type Id = string & { readonly parent?: Id };
type RunsId = string & { readonly parent?: RunsId; readonly run?: () => void };
class Rows extends Array<string> {
  #cb = () => undefined;
  readonly size = this.#cb.name;
}

// @ts-expect-error an arrow-typed member
export type ArrowMember = Assert<IsData<{ render: () => void }>>;
// @ts-expect-error a method
export type Method = Assert<IsData<{ draw(): void }>>;
// @ts-expect-error an optional union through an alias
export type OptionalAlias = Assert<IsData<{ render?: AnchorRenderer | null }>>;
// @ts-expect-error a construct signature
export type Construct = Assert<IsData<{ make: { new (): object } }>>;
// @ts-expect-error a callable interface
export type CallableIface = Assert<IsData<{ render: CallableRenderer }>>;
// @ts-expect-error nested through readonly arrays
export type ThroughArrays = Assert<IsData<Nested>>;
// @ts-expect-error a function index signature
export type IndexSig = Assert<IsData<{ readonly [key: string]: () => void }>>;
// @ts-expect-error a symbol-keyed method
export type Dispose = Assert<IsData<{ [Symbol.dispose](): void }>>;
// @ts-expect-error a ReactNode
export type ReactNodeMember = Assert<IsData<{ node: ReactNode }>>;
// @ts-expect-error any
// biome-ignore lint/suspicious/noExplicitAny: the control is `any` itself
export type AnyMember = Assert<IsData<{ value: any }>>;
// @ts-expect-error a class instance with methods
export type MapMember = Assert<IsData<{ map: Map<string, string> }>>;
// @ts-expect-error an intersection adding a callback
export type AddsCallback = Assert<IsData<WithCallback>>;
// @ts-expect-error a defaulted generic alias
export type DefaultedAlias = Assert<IsData<{ render?: Defaulted }>>;
// @ts-expect-error unknown, which a function is assignable to
export type UnknownMember = Assert<IsData<{ value: unknown }>>;
// @ts-expect-error object, which a function is assignable to
export type ObjectMember = Assert<IsData<{ value: object }>>;
// @ts-expect-error a class whose callback is private
export type PrivateMember = Assert<IsData<{ value: PrivateCallback }>>;
// @ts-expect-error a class whose callback is protected
export type ProtectedMember = Assert<IsData<{ value: ProtectedCallback }>>;
// @ts-expect-error a class whose callback is #private
export type HashPrivateMember = Assert<IsData<{ value: HashPrivateCallback }>>;

// Refused on purpose though it is data: a function has every key it names, so
// a function is assignable to it.
// @ts-expect-error data shaped like a function
export type FunctionShaped = Assert<IsData<{ value: { name: string } }>>;
// Refused on purpose though it is data: its own keys can't rebuild a class
// with a private member, whatever that member holds.
// @ts-expect-error a class whose private member is data
export type PrivateData = Assert<IsData<{ value: PrivateNumber }>>;

// @ts-expect-error an optional any
// biome-ignore lint/suspicious/noExplicitAny: the control is `any` itself
export type OptionalAny = Assert<IsData<{ id: string; extra?: any }>>;
// @ts-expect-error an optional any added to a held type
export type AnchorAny = Assert<IsData<AnchorWithAny>>;
// @ts-expect-error an optional tuple slot of any
// biome-ignore lint/suspicious/noExplicitAny: the control is `any` itself
export type OptionalSlotAny = Assert<IsData<{ pair: [a: string, b?: any] }>>;
// @ts-expect-error a union whose second constituent has a method
export type UnionTop = Assert<IsData<Plain | Runs>>;
// @ts-expect-error that union as a readonly array's element
export type UnionElement = Assert<IsData<{ list: readonly (Plain | Runs)[] }>>;
// @ts-expect-error that union as an optional member
export type UnionMember = Assert<IsData<{ item?: Plain | Runs | null }>>;
// @ts-expect-error a callback under three optional levels
export type OptionalDeep = Assert<IsData<{ a?: { b?: { c?: Runs } } }>>;
// @ts-expect-error a callback five generic levels down
export type GenericDeep = Assert<IsData<Box<Box<Box<Box<Box<Runs>>>>>>>;
// @ts-expect-error a recursive type with a callback
export type RecursiveCallback = Assert<IsData<TreeWithVisitor>>;
// @ts-expect-error a brand that carries a callback
export type BrandCallback = Assert<IsData<{ id: string & Runs }>>;
// @ts-expect-error a primitive intersected with a function
export type CallablePrimitive = Assert<IsData<{ id: string & (() => void) }>>;
// @ts-expect-error an array intersected with a callback
export type ArrayCallback = Assert<IsData<{ list: string[] & Runs }>>;
// @ts-expect-error a callback on a type its parent is mutually assignable with
export type LooksSeen = Assert<IsData<Outer>>;
// @ts-expect-error a named callback beside a string index, added to a held type
export type AnchorIndexNamed = Assert<IsData<AnchorIndexHides>>;
// @ts-expect-error a named callback beside a number index
export type NumberIndexNamed = Assert<IsData<NumberIndexHides>>;
// @ts-expect-error a named callback beside a template-pattern index
export type PatternIndexNamed = Assert<IsData<PatternIndexHides>>;
// @ts-expect-error a brand that refers to itself and carries a callback
export type RecursiveBrandCallback = Assert<IsData<{ id: RunsId }>>;
// Refused on purpose though it is data: it never repeats, so the level bound
// ends the read.
// @ts-expect-error a generic that grows its own argument
export type GrowsForever = Assert<IsData<Growing<string>>>;
// Refused on purpose though it holds no callback of the host's: an object with
// methods is not data here.
// @ts-expect-error a Date
export type DateMember = Assert<IsData<{ at: Date }>>;

// Read as data on purpose: a primitive's own methods are not callbacks, and a
// brand member under one of its keys can't be told from them.
export type BrandShadow = Assert<IsData<{ id: string & { at: () => void } }>>;
// Read as data on purpose (out of reach): a readonly array's added member
// under a mutable array's method name is skipped as the array's own.
export type ReadonlyPopShadow = Assert<
  IsData<{ list: readonly string[] & { pop: () => void } }>
>;
// Read as data on purpose (out of reach): an Array subclass is read by its
// elements and public members, never its non-public ones.
export type ArraySubclassHidden = Assert<IsData<{ rows: Rows }>>;
// Read as data on purpose (out of reach): beside a `string` index signature,
// only its value is read, never a template-pattern index's.
export type PatternIndexHidden = Assert<
  IsData<{
    byKey: { [k: string]: { id: string } } & {
      [k: `x${string}`]: () => void;
    };
  }>
>;
// Read as data on purpose (out of reach): a member declared beside an index
// signature is split out on plain objects only, never on a brand.
export type BrandIndexHidden = Assert<
  IsData<{
    id: string & {
      [k: string]: { id: string };
      special: { id: string; run(): void };
    };
  }>
>;

// A data-only decoy: no directive, so it must compile as it stands.
export type DataDecoy = Assert<
  IsData<{
    meta: { a: string; b?: readonly (number | null)[] };
    pair: [string, number];
    byId: { [id: string]: { line: number } | undefined };
    rows: readonly [first: string, rest?: number];
    instance: PublicData;
    id: Brand;
    line: LineNo | undefined;
    choice: { kind: "a"; a: Brand } | { kind: "b"; b: readonly LineNo[] };
    tree: Tree;
    json: Json;
    boxed: Box<Box<Box<Box<Box<Plain>>>>>;
    gone: never;
    unset?: undefined;
    indexed: IndexData;
    parentId: Id;
  }>
>;

test("the held diff types are data only (checked by tsc -b)", () => {
  expectTypeOf<DiffLineAnchorIsData>().toEqualTypeOf<true>();
  expectTypeOf<ArmPaintIsData>().toEqualTypeOf<true>();
  expectTypeOf<IsData<{ render: () => void }>>().toEqualTypeOf<false>();
});

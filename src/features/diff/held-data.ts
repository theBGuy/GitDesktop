/**
 * Compile-time proof that a type carries data only: `IsData<T>` is `true` when
 * nothing reachable from a `T` value is or may be callable, through any member
 * (an optional one, or one declared beside an index signature, too), element,
 * index signature or union constituent, and `Assert<IsData<T>>` then compiles,
 * so `tsc -b` fails on a held type that gains a callback. An object with
 * methods is not data here (`Date`, `Map`, a class instance with one), and
 * neither is a type nested deeper than `MaxLevels`. Out of reach, so read as
 * data: a member a brand adds under one of its primitive's own keys
 * (`string & { at: () => void }`), a member a readonly array adds under a
 * mutable array's method name (`readonly string[] & { pop: () => void }`),
 * a callback an Array subclass keeps in a non-public member, the value of a
 * template-pattern index signature beside a `string` one on the same type
 * (only the `string` one is read), and a member declared beside an
 * index signature on a brand, array or tuple (that split runs on plain
 * objects only).
 */
export type IsData<T> = [HasCallable<T>] extends [false] ? true : false;

export type Assert<T extends true> = T;

type MaxLevels = 32;
type Primitive = string | number | bigint | boolean | symbol;
type Callable = (...args: never[]) => unknown;
type Constructor = abstract new (...args: never[]) => unknown;

/** The primitive `T` narrows: its keys are the ones no brand added, and its
 *  own methods are not callbacks. */
type Base<T, P = Primitive> = P extends unknown
  ? [T] extends [P]
    ? P
    : never
  : never;

/** An array's own keys but its index, which leaves `Rest` the elements, a
 *  tuple's slots and any member an intersection adds. */
type ArrayKeys = Exclude<keyof unknown[], number>;

/** The types of `T`'s members but for the `Skip` keys. Indexed through a
 *  mapped type, since `string[never]` is `string`. */
type Rest<T, Skip> = {
  [K in Exclude<keyof T, Skip>]: T[K];
}[Exclude<keyof T, Skip>];

/** The types of an object's declared members, read apart from its index
 *  signatures: `keyof` of `{ [key: string]: A; b: B }` is `string | number`,
 *  which absorbs `b`, so `Rest` reads only `A` there. A key is an index
 *  signature's (string, number, symbol or a template pattern) when an empty
 *  object is assignable to a record over it. */
type Declared<T> = {
  [K in keyof T as Record<never, never> extends Record<K, 1> ? never : K]: T[K];
};
type DeclaredValues<T> = Declared<T>[keyof Declared<T>];

/**
 * One level down from each constituent of `T`: `true` when it is or may be
 * callable, its member types in a one-tuple otherwise, `never` when `Seen`
 * holds it. `any` takes both branches of the first test, so it is `true`; so
 * is a type a function is assignable to (`unknown`, `object`, `{}`, and data
 * whose every key a function also has, such as `{ name: string }`), and an
 * object its own `keyof` members can't rebuild (a class with a private,
 * protected or `#private` member, whatever that member holds). `Seen` is
 * matched by type identity written inline: through an alias, a type that
 * differs by one optional member matches too. It is read before a brand's
 * members, so a brand that refers to itself ends.
 */
type Step<T, Seen> = T extends Callable | Constructor
  ? true
  : (<G>() => G extends T ? 1 : 2) extends Seen
    ? never
    : T extends Primitive | null | undefined | void
      ? [Rest<T, keyof Base<T>>]
      : Callable extends T
        ? true
        : T extends readonly unknown[]
          ? [Rest<T, ArrayKeys>]
          : [{ [K in keyof T]: T[K] }] extends [T]
            ? [Rest<T, never> | DeclaredValues<T>]
            : true;

/**
 * Whether anything callable is reachable from `T`, read a level at a time
 * with each distinct type expanded once, so a recursive type ends. A type
 * still unread after `MaxLevels` levels is `true`, which bounds a generic that
 * grows its own argument (unbounded, it ends only in TS2589).
 */
type HasCallable<T, Seen = never, Level extends 0[] = []> = [T] extends [never]
  ? false
  : Level["length"] extends MaxLevels
    ? true
    : true extends Step<T, Seen>
      ? true
      : HasCallable<
          Extract<Step<T, Seen>, [unknown]>[0],
          Seen | (T extends unknown ? <G>() => G extends T ? 1 : 2 : never),
          [...Level, 0]
        >;

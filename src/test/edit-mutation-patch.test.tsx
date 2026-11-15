import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgeIssueEdit, forgePrEdit } from "@/lib/git/api";
import {
  issueDetailsOptions,
  prDetailsOptions,
  prDiffOptions,
  repoKeys,
  useEditIssue,
  useEditPr,
} from "@/lib/git/queries";
import { projectItemsRepoKey } from "@/lib/git/queries/board-writes";
import type { RemoteLens } from "@/lib/git/types";
import { unmockedCommands } from "./setup";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  forgeIssueEdit: vi.fn(),
  forgePrEdit: vi.fn(),
}));

// Names the may-have-landed and other-changes-saved classes by sentinels
// rather than Rust's sentences; every other error keeps the real answer.
const { MAY_HAVE_LANDED, OTHER_CHANGES_SAVED } = vi.hoisted(() => ({
  MAY_HAVE_LANDED: new Error("sentinel: the edit may have landed"),
  OTHER_CHANGES_SAVED: new Error("sentinel: the other changes were saved"),
}));
vi.mock("@/lib/error-summary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/error-summary")>();
  return {
    ...actual,
    mayHaveLanded: (e: unknown) =>
      e === MAY_HAVE_LANDED || actual.mayHaveLanded(e),
    otherChangesSaved: (e: unknown) =>
      e === OTHER_CHANGES_SAVED || actual.otherChangesSaved(e),
  };
});

afterAll(() => expect(unmockedCommands).toEqual([]));

const REPO = "C:/repos/edit-patch";
const N = 7;

type Item = { number: number; title: string; body: string; extra: string };
const OLD: Item = {
  number: N,
  title: "Old title",
  body: "Old body",
  extra: "x",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BOARD: QueryKey = [...projectItemsRepoKey(REPO), "board"];
const ISSUES_ORIGIN: QueryKey = [...repoKeys.issueList(REPO), "origin", "open"];
const ISSUES_UPSTREAM: QueryKey = [
  ...repoKeys.issueList(REPO),
  "upstream",
  "open",
];
const PRS_ORIGIN: QueryKey = [...repoKeys.prList(REPO), "origin", "open"];

/** Each hook under test, with the details key it patches, its api write, and
 *  the keys an origin save's settle must refresh (`settles`) or leave (`spares`). */
const HOOKS = [
  {
    name: "useEditIssue",
    use: (lens: RemoteLens) => useEditIssue(REPO, lens),
    // Untagged: the fixture is a partial details object.
    key: (lens: RemoteLens): QueryKey => [
      ...issueDetailsOptions(REPO, N, lens).queryKey,
    ],
    write: vi.mocked(forgeIssueEdit),
    settles: [ISSUES_ORIGIN, BOARD],
    spares: [ISSUES_UPSTREAM, PRS_ORIGIN],
  },
  {
    name: "useEditPr",
    use: (lens: RemoteLens) => useEditPr(REPO, lens),
    key: (lens: RemoteLens): QueryKey => [
      ...prDetailsOptions(REPO, N, lens).queryKey,
    ],
    write: vi.mocked(forgePrEdit),
    // The whole-repo settle.
    settles: [PRS_ORIGIN, ISSUES_UPSTREAM, BOARD],
    spares: [],
  },
] as const;

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(forgeIssueEdit).mockReset();
  vi.mocked(forgePrEdit).mockReset();
});

describe.each(HOOKS)("$name optimistic patch", (hook) => {
  const read = (lens: RemoteLens = "origin") =>
    client.getQueryData<Item>(hook.key(lens));

  /** Starts a save on a held write; returns the write's handle and the
   *  settled outcome of the save's promise. */
  function save(
    args: Partial<{
      title: string;
      body: string;
      attachments: { session: string; names: string[] };
    }>,
    lens: RemoteLens = "origin",
  ) {
    const write = deferred<never>();
    hook.write.mockReturnValue(write.promise as never);
    const { result } = renderHook(() => hook.use(lens), { wrapper });
    let settled: Promise<unknown> = Promise.resolve();
    act(() => {
      settled = result.current
        .mutateAsync({
          number: N,
          title: "New title",
          body: "New body",
          ...args,
        })
        .then(
          () => "ok",
          () => "err",
        );
    });
    return { write, settled };
  }

  it("patches title and description at once for an image-less save", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    expect(read()).toEqual({ ...OLD, title: "New title", body: "New body" });
    write.resolve(undefined as never);
    expect(await settled).toBe("ok");
    expect(client.getQueryState(hook.key("origin"))?.isInvalidated).toBe(true);
  });

  it("patches only the title for a save that carries an image", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    save({
      body: "See ![a](a.png)",
      attachments: { session: "s1", names: ["a.png"] },
    });
    await waitFor(() => expect(read()?.title).toBe("New title"));
    expect(read()?.body).toBe("Old body");
  });

  it("patches title and description for a save whose image list is empty", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    save({ attachments: { session: "s1", names: [] } });
    await waitFor(() => expect(read()?.title).toBe("New title"));
    expect(read()).toEqual({ ...OLD, title: "New title", body: "New body" });
  });

  it("refreshes what the save can change once it settles", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    for (const key of [...hook.settles, ...hook.spares])
      client.setQueryData(key, []);
    const { write, settled } = save({});
    write.resolve(undefined as never);
    expect(await settled).toBe("ok");
    await waitFor(() => {
      for (const key of hook.settles)
        expect(
          client.getQueryState(key)?.isInvalidated,
          JSON.stringify(key),
        ).toBe(true);
    });
    for (const key of hook.spares)
      expect(
        client.getQueryState(key)?.isInvalidated,
        JSON.stringify(key),
      ).toBe(false);
  });

  it("restores both fields on a rejection", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    write.reject(new Error("boom"));
    expect(await settled).toBe("err");
    expect(read()).toEqual(OLD);
  });

  it("keeps the patch on a rejection that may have landed, still refreshing the item", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    write.reject(MAY_HAVE_LANDED);
    expect(await settled).toBe("err");
    expect(read()).toEqual({ ...OLD, title: "New title", body: "New body" });
    await waitFor(() =>
      expect(client.getQueryState(hook.key("origin"))?.isInvalidated).toBe(
        true,
      ),
    );
  });

  const IMAGE_SAVE = {
    body: "See ![a](a.png)",
    attachments: { session: "s1", names: ["a.png"] },
  };

  it("keeps an image save's title when the rejection says its other changes were saved", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save(IMAGE_SAVE);
    await waitFor(() => expect(read()?.title).toBe("New title"));
    write.reject(OTHER_CHANGES_SAVED);
    expect(await settled).toBe("err");
    expect(read()).toEqual({ ...OLD, title: "New title" });
    await waitFor(() =>
      expect(client.getQueryState(hook.key("origin"))?.isInvalidated).toBe(
        true,
      ),
    );
  });

  it("restores an image save's title on an ordinary rejection", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save(IMAGE_SAVE);
    await waitFor(() => expect(read()?.title).toBe("New title"));
    write.reject(new Error("boom"));
    expect(await settled).toBe("err");
    expect(read()).toEqual(OLD);
  });

  it("leaves a newer value of a patched field alone on rejection", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    client.setQueryData<Item>(hook.key("origin"), (d) =>
      d ? { ...d, title: "Someone else's title" } : d,
    );
    write.reject(new Error("boom"));
    await settled;
    expect(read()?.title).toBe("Someone else's title");
    expect(read()?.body).toBe("Old body");
  });

  it("leaves a sibling field changed meanwhile alone on rejection", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const { write, settled } = save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    client.setQueryData<Item>(hook.key("origin"), (d) =>
      d ? { ...d, extra: "changed" } : d,
    );
    write.reject(new Error("boom"));
    await settled;
    expect(read()).toEqual({ ...OLD, extra: "changed" });
  });

  it("neither cancels nor writes when the key holds no data", async () => {
    const pending = deferred<Item>();
    const firstLoad = client.fetchQuery({
      queryKey: hook.key("origin"),
      queryFn: () => pending.promise,
    });
    const cancel = vi.spyOn(client, "cancelQueries");
    const set = vi.spyOn(client, "setQueryData");
    const { write, settled } = save({});
    await waitFor(() => expect(hook.write).toHaveBeenCalled());
    expect(cancel).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    pending.resolve(OLD);
    await expect(firstLoad).resolves.toEqual(OLD);
    write.resolve(undefined as never);
    await settled;
  });

  it("does not cancel a read in flight on a longer key under the item", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    const longer = [...hook.key("origin"), "diff"];
    const pending = deferred<string>();
    const inFlight = client.fetchQuery({
      queryKey: longer,
      queryFn: () => pending.promise,
    });
    save({});
    await waitFor(() => expect(read()?.title).toBe("New title"));
    pending.resolve("patch text");
    await expect(inFlight).resolves.toBe("patch text");
  });

  it("patches the upstream lens's key only", async () => {
    client.setQueryData(hook.key("origin"), OLD);
    client.setQueryData(hook.key("upstream"), OLD);
    save({}, "upstream");
    await waitFor(() => expect(read("upstream")?.title).toBe("New title"));
    expect(read("origin")).toEqual(OLD);
  });
});

it("the PR diff key is the details key plus one axis", () => {
  expect(prDiffOptions(REPO, N, "origin").queryKey).toEqual([
    ...prDetailsOptions(REPO, N, "origin").queryKey,
    "diff",
  ]);
});

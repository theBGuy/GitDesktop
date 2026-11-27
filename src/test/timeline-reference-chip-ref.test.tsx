import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { TimelineEventRow } from "@/features/pulls/PrTimeline";
import type {
  ForgeProvider,
  ForgeTimelineEvent,
  ForgeUserRef,
} from "@/lib/git/types";
import { unmockedCommands } from "./setup";

afterEach(cleanup);
afterAll(() => expect(unmockedCommands).toEqual([]));

const mention = (
  sourceKind: string,
  sourceNumber: number,
): ForgeTimelineEvent => ({
  kind: "crossReferenced",
  sourceKind,
  sourceNumber,
  sourceTitle: "",
  sourceRepo: "",
  willClose: false,
  actor: { label: "" } as ForgeUserRef,
  date: "",
});

function renderTimeline(provider: ForgeProvider | null | undefined) {
  render(
    <div>
      {[mention("pr", 12), mention("issue", 7)].map((event, i) => (
        <TimelineEventRow
          key={i}
          event={event}
          ghHost={null}
          onOpenRef={() => undefined}
          selfRepo="acme/app"
          provider={provider}
        />
      ))}
    </div>,
  );
}

describe("a timeline's reference chips number a request by its forge's sigil", () => {
  it.each<[ForgeProvider | null | undefined, string]>([
    ["gitlab", "!12"],
    ["github", "#12"],
    [undefined, "#12"],
  ])(
    "%s: the request chip reads %s, the issue chip #7",
    (provider, request) => {
      renderTimeline(provider);
      expect(screen.getByRole("button", { name: request })).toBeTruthy();
      expect(screen.getByRole("button", { name: "#7" })).toBeTruthy();
    },
  );
});

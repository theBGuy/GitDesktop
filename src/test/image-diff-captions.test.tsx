import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePanes } from "@/features/diff/ImageDiff";
import { type FileBytes, gitFileBase64 } from "@/lib/git/api";

vi.mock("@/lib/git/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/git/api")>()),
  gitFileBase64: vi.fn(),
}));

const PNG = "iVBORw0KGgo=";

/** Each side's answer, keyed by the rev the pane reads it at. */
let sides: Record<string, FileBytes | null> = {};

beforeEach(() => {
  sides = {};
  vi.mocked(gitFileBase64).mockImplementation(async (_repo, rev) =>
    rev === null ? null : (sides[rev] ?? null),
  );
});

function renderPanes() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ImagePanes
        repoPath="/repo"
        filePath="a.png"
        oldPath="a.png"
        revs={{ old: "OLD", new: "NEW" }}
      />
    </QueryClientProvider>,
  );
}

/** jsdom never decodes images: stand in the natural size, then fire `load`. */
function measure(img: HTMLElement, w: number, h: number) {
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  fireEvent.load(img);
}

const shown = (size: number | null): FileBytes => ({
  base64: PNG,
  mime: "image/png",
  tooLarge: false,
  size,
});
const refused = (size: number | null): FileBytes => ({
  base64: null,
  mime: null,
  tooLarge: true,
  size,
});

describe("ImagePanes captions", () => {
  it("adds the byte size to a measured side's dimensions", async () => {
    sides = { OLD: shown(107_417), NEW: shown(null) };
    renderPanes();
    measure(await screen.findByAltText("Old"), 1280, 720);
    measure(screen.getByAltText("New"), 640, 480);
    // formatBytes rounds to whole units at 100 and above.
    expect(screen.getByText("1280 × 720 · 105 KB").tagName).toBe("P");
    // An unknown size leaves the caption at the dimensions alone.
    expect(screen.getByText("640 × 480").textContent).toBe("640 × 480");
  });

  it("shows no caption before the side measures", async () => {
    sides = { OLD: shown(107_417), NEW: shown(107_417) };
    renderPanes();
    await screen.findByAltText("Old");
    expect(screen.queryByText(/105 KB/)).toBeNull();
    expect(screen.queryByText(/ × /)).toBeNull();
  });

  it("names a byte-cap refusal's size", async () => {
    sides = { OLD: refused(25_165_824), NEW: refused(null) };
    renderPanes();
    expect(
      await screen.findByText("Too large to preview (24.0 MB)"),
    ).toBeTruthy();
    // A dimension refusal arrives without a size: no suffix.
    expect(screen.getByText("Too large to preview").textContent).toBe(
      "Too large to preview",
    );
  });
});

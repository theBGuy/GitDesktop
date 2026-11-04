import { render, screen } from "@testing-library/react";
import * as compilerRuntime from "react/compiler-runtime";
import { describe, expect, it, vi } from "vitest";
import { InfoNote } from "@/components/info-note";

// @types/react declares this module empty on purpose, so the one member the
// compiler's output calls is typed here.
type CompilerRuntime = { c: (size: number) => unknown[] };

// Compiled components allocate their memo cache through `c`, so a call proves
// the React Compiler transformed a src/ module under Vitest.
vi.mock("react/compiler-runtime", async (importOriginal) => {
  const actual = await importOriginal<CompilerRuntime>();
  return { ...actual, c: vi.fn(actual.c) };
});

describe("test harness", () => {
  it("renders a src/ component through the React Compiler", () => {
    render(<InfoNote>Compiled note</InfoNote>);

    expect(screen.getByText("Compiled note")).toBeInTheDocument();
    const { c } = compilerRuntime as unknown as CompilerRuntime;
    expect(vi.mocked(c)).toHaveBeenCalled();
  });
});

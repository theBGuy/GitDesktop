import { describe, expect, it } from "vitest";
import {
  appendTranscriptNote,
  appendTranscriptText,
  ensureTranscriptText,
  noticeEffect,
  type TranscriptSegment,
} from "@/lib/ai/agent";

const SENTENCE =
  "GitDesktop could not continue the earlier opencode conversation, so this turn started a new one.";

describe("noticeEffect", () => {
  it("a reset shows its sentence and arms the replacement", () => {
    expect(
      noticeEffect({ code: "nativeSessionReset", text: SENTENCE }),
    ).toEqual({ note: SENTENCE, replaceNativeSession: true });
  });

  it("a reset with blank text shows nothing but still arms", () => {
    expect(noticeEffect({ code: "nativeSessionReset", text: "  " })).toEqual({
      note: null,
      replaceNativeSession: true,
    });
  });

  it("a re-key shows nothing for its empty text and arms", () => {
    expect(noticeEffect({ code: "nativeSessionRekey", text: "" })).toEqual({
      note: null,
      replaceNativeSession: true,
    });
  });

  it("a re-key with text shows it", () => {
    expect(
      noticeEffect({ code: "nativeSessionRekey", text: "Re-keyed." }),
    ).toEqual({
      note: "Re-keyed.",
      replaceNativeSession: true,
    });
  });

  it("a successful sign-in copy is always silent", () => {
    expect(
      noticeEffect({ code: "signInsCopied", text: "Copied your sign-ins." }),
    ).toEqual({ note: null, replaceNativeSession: false });
  });

  it("the other sign-in codes show their text and never arm", () => {
    for (const code of ["signInsNotCopied", "noSignIns"]) {
      expect(noticeEffect({ code, text: "Sign-ins: none." })).toEqual({
        note: "Sign-ins: none.",
        replaceNativeSession: false,
      });
      expect(noticeEffect({ code, text: "" })).toEqual({
        note: null,
        replaceNativeSession: false,
      });
    }
  });

  it("an unknown code shows non-blank text verbatim and changes nothing else", () => {
    expect(noticeEffect({ code: "somethingNew", text: " Padded. " })).toEqual({
      note: " Padded. ",
      replaceNativeSession: false,
    });
    expect(noticeEffect({ code: "somethingNew", text: "\n\t" })).toEqual({
      note: null,
      replaceNativeSession: false,
    });
  });

  it("codes match exactly, never by case or prefix", () => {
    expect(
      noticeEffect({ code: "NativeSessionReset", text: "x" })
        .replaceNativeSession,
    ).toBe(false);
    expect(
      noticeEffect({ code: "nativeSessionResetX", text: "x" })
        .replaceNativeSession,
    ).toBe(false);
    expect(noticeEffect({ code: "signinscopied", text: "x" }).note).toBe("x");
  });
});

describe("appendTranscriptNote", () => {
  const base: TranscriptSegment[] = [{ type: "text", text: "Hello" }];

  it("appends a note segment", () => {
    expect(appendTranscriptNote(base, SENTENCE)).toEqual([
      { type: "text", text: "Hello" },
      { type: "note", text: SENTENCE },
    ]);
  });

  it("returns the same array for blank text", () => {
    expect(appendTranscriptNote(base, "")).toBe(base);
    expect(appendTranscriptNote(base, "   ")).toBe(base);
  });

  it("text after a note starts a new text segment", () => {
    const withNote = appendTranscriptNote(
      [{ type: "text", text: "Before" }],
      SENTENCE,
    );
    expect(appendTranscriptText(withNote, "After")).toEqual([
      { type: "text", text: "Before" },
      { type: "note", text: SENTENCE },
      { type: "text", text: "After" },
    ]);
  });

  it("a whole-message done after a note-only turn adds the text", () => {
    const noteOnly = appendTranscriptNote([], SENTENCE);
    expect(ensureTranscriptText(noteOnly, "The whole message.")).toEqual([
      { type: "note", text: SENTENCE },
      { type: "text", text: "The whole message." },
    ]);
  });
});

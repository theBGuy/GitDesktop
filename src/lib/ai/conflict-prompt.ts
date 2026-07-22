import type { ConflictSides } from "@/lib/git/conflict";
import { safeSlice } from "./truncate";

const CONFLICT_SYSTEM = `You resolve a single git merge conflict. You are given the conflicted file WITH its conflict markers, plus — when available — the clean BASE (common ancestor), OURS (current branch / HEAD side), and THEIRS (incoming side) versions of the whole file.

Produce the correct merged file:
- Integrate the INTENT of both sides. Keep every non-conflicting change from each. Do not discard one side wholesale unless that side made no meaningful change relative to the base.
- Remove ALL conflict markers (\`<<<<<<<\`, \`|||||||\`, \`=======\`, \`>>>>>>>\`). The output must be a clean, valid file with no markers left.
- Preserve the file's existing language, formatting, indentation style, and trailing newline. Do not reformat or "improve" code outside the conflicting regions.
- When the two sides genuinely contradict (not just additive), prefer the combination that keeps the code correct and compiling; if you truly cannot tell, favor OURS but keep THEIRS's additions that don't conflict.

Output ONLY the complete resolved file contents inside a single fenced code block (\`\`\`). Output the ENTIRE file, not just the changed region. Put nothing before or after the block — no explanation, no commentary, no summary of what you changed.`;

export interface ConflictPromptInput {
  path: string;
  sides: ConflictSides;
  repoInstructions: string | null;
  globalInstructions: string;
}

/** Soft per-section cap so a large file's three sides don't blow the context.
 *  The backend already refuses files over 256 KB; this trims each rendered side. */
const SECTION_MAX = 80_000;

function section(title: string, body: string | null): string | null {
  if (body == null) return null;
  const clipped =
    body.length > SECTION_MAX
      ? `${safeSlice(body, SECTION_MAX)}\n[…truncated for length…]`
      : body;
  return `## ${title}\n\`\`\`\n${clipped}\n\`\`\``;
}

export function buildConflictPrompt(input: ConflictPromptInput): {
  system: string;
  prompt: string;
} {
  const systemParts = [CONFLICT_SYSTEM];
  if (input.repoInstructions) {
    systemParts.push(`## Project conventions\n${input.repoInstructions}`);
  }
  if (input.globalInstructions.trim()) {
    systemParts.push(`## User conventions\n${input.globalInstructions.trim()}`);
  }

  const { sides } = input;
  const promptParts = [
    `Resolve the merge conflict in \`${input.path}\`.`,
    // The marked working file is the primary input — its markers label each side
    // in place. The clean sides below are supplementary context.
    section("Conflicted file (with markers)", sides.working),
    section("OURS — current branch / HEAD side", sides.ours),
    section("THEIRS — incoming side", sides.theirs),
    section("BASE — common ancestor", sides.base),
    "Output the fully merged file contents in a single fenced code block.",
  ].filter((p): p is string => Boolean(p));

  return {
    system: systemParts.join("\n\n"),
    prompt: promptParts.join("\n\n"),
  };
}

/**
 * Pulls the resolved file out of a (possibly conversational) model response.
 * Takes everything between the FIRST opening fence and the LAST closing fence,
 * so prose before/after is dropped and a file's own inner code fences (e.g. a
 * markdown document) are preserved. Falls back to the whole text, minus a stray
 * leading fence, when there's no usable pair — e.g. a response that wasn't fenced
 * or one still mid-stream.
 */
export function extractResolvedContent(raw: string): string {
  const text = raw.trim();
  const open = text.indexOf("```");
  if (open !== -1) {
    const afterOpen = text.indexOf("\n", open);
    const close = text.lastIndexOf("```");
    if (afterOpen !== -1 && close > afterOpen) {
      return text.slice(afterOpen + 1, close).replace(/\n$/, "");
    }
  }
  return text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
}

/** Whether unresolved conflict markers remain — a sign the model didn't finish
 *  the merge. Uses only the unambiguous angle/pipe markers (a bare `=======`
 *  line can be a legit markdown underline), so it won't false-positive. */
export function hasConflictMarkers(text: string): boolean {
  return (
    /^<{7}( |\t|$)/m.test(text) ||
    /^>{7}( |\t|$)/m.test(text) ||
    /^\|{7}( |\t|$)/m.test(text)
  );
}

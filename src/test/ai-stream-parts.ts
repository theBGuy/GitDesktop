export type Part = Record<string, unknown>;

/** A `streamText` result stub whose `fullStream` yields `parts`; each test file
 *  feeds it to its own hoisted `streamText` mock. */
export function streamResult(parts: Part[]) {
  return {
    fullStream: (async function* () {
      for (const p of parts) yield p;
    })(),
  };
}

/** The parts of one streamed text block. */
export const text = (t: string): Part[] => [
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", text: t },
  { type: "text-end", id: "1" },
];

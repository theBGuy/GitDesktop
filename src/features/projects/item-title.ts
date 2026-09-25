import type { BoardItem } from "@/lib/git/types";

/** The item's head line wherever a surface names one card in a phrase: the
 *  roadmap lane beside its bar, a bulk failure's Details section heading. */
export function itemTitle(item: BoardItem): string {
  const content = item.content;
  if (content.kind === "redacted") return "Redacted item";
  return content.title === "" ? "Draft item" : content.title;
}

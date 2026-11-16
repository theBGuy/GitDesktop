/** Whether a settings draft differs from the saved settings it was seeded from.
 *  Topics are a case-insensitive set on GitHub and GitLab: the forge may answer
 *  a save in another order, and keeps one spelling of a topic that differs only
 *  in letter case, so neither order nor case nor a repeat counts as a change. */
export function settingsDirty<T extends { topics: string[] }>(
  form: T,
  base: T,
): boolean {
  const canonical = (x: T) =>
    JSON.stringify({
      ...x,
      topics: [...new Set(x.topics.map((t) => t.toLowerCase()))].sort(),
    });
  return canonical(form) !== canonical(base);
}

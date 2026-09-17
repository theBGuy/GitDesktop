/** A git submodule and its state vs. the commit the parent records. */
export interface Submodule {
  path: string;
  /** Its `.gitmodules` name, which git allows to differ from the path. */
  name: string;
  url: string;
  /** The branch it tracks (`submodule.<name>.branch`); null = the remote's default. */
  branch: string | null;
  sha: string;
  describe: string;
  /** "ok" | "uninitialized" | "modified" | "conflict" */
  status: string;
}

/** What a submodule removal actually did. Every field matters to the user: the
 *  removal only ever stages, and a refusal means nothing changed at all. */
export interface SubmoduleRemoveOutcome {
  /** The submodule has local changes and nothing was mutated — retry with force. */
  refusedDirty: boolean;
  moduleDataDeleted: boolean;
  /** Deleting the cached `.git/modules` data failed; the removal itself is still
   *  staged, so this is a disclosure rather than an error. */
  moduleDataError: string | null;
}

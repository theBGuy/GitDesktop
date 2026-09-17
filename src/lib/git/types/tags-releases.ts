/** One git tag, for the Tags list. */
export interface TagInfo {
  name: string;
  /** The commit the tag points to (dereferenced for annotated tags). */
  target: string;
  date: string;
  annotated: boolean;
  /** Tag annotation subject (annotated) or the commit subject (lightweight). */
  subject: string;
}

/** A GitHub release in the list view (merged with tags by tagName). */
export interface ReleaseInfo {
  tagName: string;
  name: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isLatest: boolean;
  publishedAt: string;
}

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadCount: number;
  url: string;
}

export interface ReleaseDetails {
  tagName: string;
  name: string;
  body: string;
  author: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  targetCommitish: string;
  url: string;
  assets: ReleaseAsset[];
}

/** GitHub's auto-generated release notes (suggested title + body). */
export interface GeneratedNotes {
  name: string;
  body: string;
}

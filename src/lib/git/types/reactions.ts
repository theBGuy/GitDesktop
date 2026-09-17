export interface Reaction {
  /** GitHub ReactionContent enum value (THUMBS_UP, HEART, ROCKET, …). */
  content: string;
  count: number;
  /** Whether the signed-in user has this reaction (drives the toggle). */
  viewerReacted: boolean;
}

export interface IssueReactions {
  body: Reaction[];
  /** Reactions per comment, keyed by the comment's id as the thread carries it
   *  (a GraphQL node id on GitHub, a numeric note id on GitLab). */
  comments: Record<string, Reaction[]>;
}

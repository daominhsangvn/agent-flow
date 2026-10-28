/** Operations of the Confluence provider (action and read keys). */
export const ConfluenceActionType = {
  CreatePage: "confluence.create_page",
  UpdatePage: "confluence.update_page",
  Comment: "confluence.comment",
  ResolveComment: "confluence.resolve_comment",
} as const;
export type ConfluenceActionType =
  (typeof ConfluenceActionType)[keyof typeof ConfluenceActionType];

export const ConfluenceReadType = {
  GetPage: "confluence.get_page",
  FindPages: "confluence.find_pages",
  ListComments: "confluence.list_comments",
} as const;
export type ConfluenceReadType =
  (typeof ConfluenceReadType)[keyof typeof ConfluenceReadType];

/** How a page body is read or written. */
export const ConfluenceBodyFormat = {
  /** Markdown, converted to and from Confluence's formats. */
  Markdown: "markdown",
  /** Confluence storage format (XHTML), to edit a page keeping its macros and inline comment markers. */
  Storage: "storage",
} as const;
export type ConfluenceBodyFormat =
  (typeof ConfluenceBodyFormat)[keyof typeof ConfluenceBodyFormat];

/** Which comment threads confluence.list_comments returns. */
export const ConfluenceCommentFilter = { Open: "open", All: "all" } as const;
export type ConfluenceCommentFilter =
  (typeof ConfluenceCommentFilter)[keyof typeof ConfluenceCommentFilter];

export const ConfluenceCommentKind = {
  /** A comment below the page. */
  Footer: "footer",
  /** A comment on highlighted text of the page; can be resolved. */
  Inline: "inline",
} as const;
export type ConfluenceCommentKind =
  (typeof ConfluenceCommentKind)[keyof typeof ConfluenceCommentKind];

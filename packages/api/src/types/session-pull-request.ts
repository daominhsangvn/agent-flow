/** A pull request a session lists (the Sessions page's "Pull requests"). */
export type SessionPR = {
  num: number | string;
  title: string;
  status: string;
  /**
   * The pull request's own page, for one AgentFlow recorded itself: a pull
   * request a workflow action opened, on any provider (e.g. Local Git). The
   * session sync schema does not accept it, so a desktop cannot set it.
   * Without it the UI links the pull request on GitHub.
   */
  url?: string;
};

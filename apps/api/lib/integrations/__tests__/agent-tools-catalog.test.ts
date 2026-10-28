import {
  ConnectionAccess,
  type ConnectionGrants,
  GrantApproval,
  normalizeConnectionGrants,
  PULL_REQUESTS_CONNECTION_KEY,
  PullRequestOperation,
  SourceOperation,
} from "@repo/api/src/types/connection-grants";
import { IntegrationProviderKey } from "@repo/api/src/types/integration";
import {
  IntegrationToolAccess,
  IntegrationToolName,
} from "@repo/api/src/types/integration-tools";
import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_DESCRIPTION_MAX,
  type AgentTool,
  type AgentToolSessionInput,
  buildAgentTools,
  describeAgentToolSession,
  type GrantedConnection,
  PullRequestThreadFilter,
  type RunPullRequestRef,
} from "@/lib/integrations/agent-tools/catalog";
import { AzureDevOpsActionType } from "@/lib/integrations/providers/azure-devops/constants";
import { JiraActionType } from "@/lib/integrations/providers/jira/constants";
import { TeamsActionType } from "@/lib/integrations/providers/microsoft-teams/post-message-action";

/**
 * The tools of an agent session come from its grant alone, against the real
 * providers: source item writes take neither an item nor a connection (so a
 * key in the ticket's text cannot redirect them), external writes name a key
 * from an enum of exactly the granted keys, and every description follows
 * the rules agents rely on to pick the right tool.
 */

const TEAMS_RELEASE: GrantedConnection = {
  key: "teams-release",
  name: "Release channel",
  provider: IntegrationProviderKey.MicrosoftTeams,
  projectConnectionId: "0199a5f0-0000-7000-8000-0000000000c1",
};
const JIRA_INTERNAL: GrantedConnection = {
  key: "jira-internal",
  name: "Internal Jira",
  provider: IntegrationProviderKey.Jira,
  projectConnectionId: "0199a5f0-0000-7000-8000-0000000000c3",
};
const TEAMS_QA: GrantedConnection = {
  ...TEAMS_RELEASE,
  key: "teams-qa",
  name: "QA channel",
  projectConnectionId: "0199a5f0-0000-7000-8000-0000000000c2",
};

describe("buildAgentTools", () => {
  it("only reads the source item without a grant", () => {
    const input = session();
    const tools = buildAgentTools(input);

    expect(names(tools)).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
    ]);
    expect(describeAgentToolSession(input, tools)).toContain(
      "This session only reads"
    );
  });

  it("offers the granted source writes without an item or a connection argument", () => {
    const tools = buildAgentTools(
      session({
        grants: {
          source: [SourceOperation.Comment, SourceOperation.Transition],
        },
      })
    );
    const transition = tool(tools, IntegrationToolName.SourceItemTransition);

    expect(names(tools)).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
      IntegrationToolName.SourceItemComment,
      IntegrationToolName.SourceItemTransition,
    ]);
    expect(transition.operationType).toBe(JiraActionType.TransitionIssue);
    expect(Object.keys(properties(transition))).toEqual(["transitionName"]);
    expect(transition.description).toContain(
      'The item is fixed by AgentFlow and cannot be changed: Jira JB-7 "Login fails" via connection `jira-customer`.'
    );
  });

  it("keeps a transition on the source item when the arguments name another issue", () => {
    // Two Jiras in the project: the run came from jira-customer (JB-7) and
    // the ticket's title names JA-3 of jira-internal.
    const transition = tool(
      buildAgentTools(
        session({ grants: { source: [SourceOperation.Transition] } })
      ),
      IntegrationToolName.SourceItemTransition
    );

    const plan = transition.plan({
      transitionName: "In Progress",
      key: "JA-3",
      connection: "jira-internal",
    });

    expect(plan).toEqual({
      ok: true,
      value: expect.objectContaining({
        kind: "write",
        connection: null,
        config: { transitionName: "In Progress" },
      }),
    });
  });

  it("offers only the comment when only the comment is granted", () => {
    const tools = buildAgentTools(
      session({ grants: { source: [SourceOperation.Comment] } })
    );

    expect(names(tools)).not.toContain(
      IntegrationToolName.SourceItemTransition
    );
    expect(
      tool(tools, IntegrationToolName.SourceItemComment).operationType
    ).toBe(JiraActionType.AddComment);
  });

  it("maps the source writes to the source's own provider", () => {
    const tools = buildAgentTools(
      session({
        provider: IntegrationProviderKey.AzureDevOps,
        grants: { source: [SourceOperation.Transition] },
      })
    );
    const transition = tool(tools, IntegrationToolName.SourceItemTransition);

    expect(transition.operationType).toBe(AzureDevOpsActionType.UpdateState);
    expect(Object.keys(properties(transition))).toEqual(["state"]);
  });

  it.each([
    [
      IntegrationProviderKey.Jira,
      JiraActionType.UpdateLabels,
      JiraActionType.AddLink,
    ],
    [
      IntegrationProviderKey.AzureDevOps,
      AzureDevOpsActionType.UpdateTags,
      AzureDevOpsActionType.AddLink,
    ],
  ])("offers the label and link writes on a %s source item", (provider, label, link) => {
    const tools = buildAgentTools(
      session({
        provider,
        grants: { source: [SourceOperation.Label, SourceOperation.Link] },
      })
    );
    const labels = tool(tools, IntegrationToolName.SourceItemLabel);
    const linkTool = tool(tools, IntegrationToolName.SourceItemLink);

    expect(labels.operationType).toBe(label);
    expect(Object.keys(properties(labels))).toEqual(["add", "remove"]);
    expect(linkTool.operationType).toBe(link);
    expect(Object.keys(properties(linkTool))).toEqual(["url", "title"]);
    expect(names(tools)).not.toContain(IntegrationToolName.SourceItemComment);
  });

  it("offers no source tools for a run without a source connection", () => {
    const tools = buildAgentTools(
      session({
        provider: null,
        grants: { source: [SourceOperation.Comment] },
      })
    );

    expect(names(tools)).toEqual([IntegrationToolName.Overview]);
  });

  it("names an external write's connection from exactly the granted keys", () => {
    const tools = buildAgentTools(
      session({
        grants: {
          "teams-release": [TeamsActionType.PostMessage],
          "teams-qa": [TeamsActionType.PostMessage],
        },
        connections: [TEAMS_RELEASE, TEAMS_QA],
      })
    );
    const post = tool(tools, "microsoft_teams_post_message");

    expect(post.access).toBe(IntegrationToolAccess.Write);
    expect(properties(post).connection).toMatchObject({
      enum: ["teams-release", "teams-qa"],
    });
    expect(post.inputSchema.required).toEqual(["connection"]);
    expect(post.plan({ connection: "teams-ops", message: "Hi" })).toEqual({
      ok: false,
      error: expect.stringContaining(
        "connection must be one of teams-release, teams-qa"
      ),
    });
    expect(post.plan({ connection: "teams-qa", message: "Hi" })).toEqual({
      ok: true,
      value: expect.objectContaining({ connection: TEAMS_QA }),
    });
  });

  it("applies the grant's fixed values and removes them from the arguments", () => {
    const post = tool(
      buildAgentTools(
        session({
          grants: {
            "teams-release": {
              allow: [TeamsActionType.PostMessage],
              with: { title: "Release of {{source.key}}", includeFacts: false },
            },
          },
          connections: [TEAMS_RELEASE],
        })
      ),
      "microsoft_teams_post_message"
    );

    const plan = post.plan({
      connection: "teams-release",
      message: "Shipped.",
      title: "Ignored",
    });

    expect(Object.keys(properties(post))).toEqual(["connection", "message"]);
    expect(post.description).toContain(
      "`teams-release` (Release channel), fixed title=Release of {{source.key}}, includeFacts=false"
    );
    expect(plan).toEqual({
      ok: true,
      value: expect.objectContaining({
        config: {
          title: "Release of {{source.key}}",
          message: "Shipped.",
          includeFacts: false,
        },
        // The workflow's text is rendered, the agent's is used as written.
        renderFields: ["title"],
      }),
    });
  });

  it("renders a template the agent left to its default", () => {
    const post = tool(
      buildAgentTools(
        session({
          grants: { "teams-release": [TeamsActionType.PostMessage] },
          connections: [TEAMS_RELEASE],
        })
      ),
      "microsoft_teams_post_message"
    );

    const plan = post.plan({ connection: "teams-release", title: "Done" });

    expect(plan).toEqual({
      ok: true,
      value: expect.objectContaining({ renderFields: ["message"] }),
    });
  });

  it("queues the writes of a grant that needs approval", () => {
    const input = session({
      grants: {
        "teams-release": {
          allow: [TeamsActionType.PostMessage],
          approval: GrantApproval.Required,
        },
        source: {
          allow: [SourceOperation.Comment],
          approval: GrantApproval.Required,
        },
      },
      connections: [TEAMS_RELEASE],
    });
    const tools = buildAgentTools(input);
    const post = tool(tools, "microsoft_teams_post_message");
    const comment = tool(tools, IntegrationToolName.SourceItemComment);

    expect(post.description).toContain(
      "`teams-release` (Release channel), needs approval"
    );
    expect(post.description).toContain("Needs a person's approval");
    expect(comment.description).toContain("Needs a person's approval");
    expect(
      post.plan({ connection: "teams-release", message: "Shipped." })
    ).toEqual({
      ok: true,
      value: expect.objectContaining({ requiresApproval: true }),
    });
    expect(comment.plan({ message: "Done." })).toEqual({
      ok: true,
      value: expect.objectContaining({ requiresApproval: true }),
    });
  });

  it("says why a granted key has no tools", () => {
    const input = session({
      grants: { "teams-missing": [TeamsActionType.PostMessage] },
    });

    expect(describeAgentToolSession(input, buildAgentTools(input))).toContain(
      "`teams-missing` is not a connection of the run's project."
    );
  });

  it("reads items of granted connections that can be read", () => {
    const tools = buildAgentTools(
      session({
        grants: {
          "jira-internal": ConnectionAccess.Read,
          "teams-release": [TeamsActionType.PostMessage],
        },
        connections: [JIRA_INTERNAL, TEAMS_RELEASE],
      })
    );
    const read = tool(tools, IntegrationToolName.ConnectionGetItem);

    // Teams has no items to read: only the Jira key is offered.
    expect(properties(read).connection).toMatchObject({
      enum: ["jira-internal"],
    });
    expect(read.plan({ connection: "jira-internal", item: "OPS-12" })).toEqual({
      ok: true,
      value: {
        kind: "read_item",
        connection: JIRA_INTERNAL,
        item: "OPS-12",
      },
    });
    expect(read.plan({ connection: "jira-customer", item: "JB-1" })).toEqual({
      ok: false,
      error: expect.stringContaining("connection must be one of jira-internal"),
    });
    expect(
      tool(tools, IntegrationToolName.SourceItemGet).description
    ).toContain(`use ${IntegrationToolName.ConnectionGetItem}`);
  });

  it("reads no other item without a granted connection", () => {
    const tools = buildAgentTools(session());

    expect(names(tools)).not.toContain(IntegrationToolName.ConnectionGetItem);
  });

  it("refuses arguments the operation rejects", () => {
    const transition = tool(
      buildAgentTools(
        session({ grants: { source: [SourceOperation.Transition] } })
      ),
      IntegrationToolName.SourceItemTransition
    );

    expect(transition.plan({ transitionName: "" })).toEqual({
      ok: false,
      error: expect.stringContaining(
        `Invalid arguments for ${JiraActionType.TransitionIssue}: transitionName`
      ),
    });
  });
});

describe("comment attachments", () => {
  it("lets a Jira comment show files the agent uploaded and says how to upload them", () => {
    const input = session({ grants: { source: [SourceOperation.Comment] } });
    const tools = buildAgentTools(input);
    const comment = tool(tools, IntegrationToolName.SourceItemComment);

    expect(Object.keys(properties(comment))).toEqual([
      "message",
      "target",
      "attachments",
    ]);
    expect(comment.description).toContain('"$AGENTFLOW_ATTACH" evidence/');
    expect(comment.description.length).toBeLessThanOrEqual(
      AGENT_TOOL_DESCRIPTION_MAX
    );
    expect(describeAgentToolSession(input, tools)).toContain(
      "The one exception is the file upload command"
    );
    expect(
      comment.plan({ message: "Tested.", attachments: ["10001", "10002"] })
    ).toEqual({
      ok: true,
      value: expect.objectContaining({
        config: expect.not.objectContaining({ attachments: expect.anything() }),
        attachments: ["10001", "10002"],
      }),
    });
  });

  it("refuses more files than one comment shows", () => {
    const comment = tool(
      buildAgentTools(
        session({ grants: { source: [SourceOperation.Comment] } })
      ),
      IntegrationToolName.SourceItemComment
    );

    expect(
      comment.plan({
        message: "Tested.",
        attachments: Array.from({ length: 11 }, (_, index) => String(index)),
      })
    ).toEqual({ ok: false, error: expect.stringContaining("at most 10") });
  });

  it.each([
    [
      "an Azure DevOps source item",
      session({
        provider: IntegrationProviderKey.AzureDevOps,
        grants: { source: [SourceOperation.Comment] },
      }),
    ],
    [
      "a comment that needs approval",
      session({
        grants: {
          source: {
            allow: [SourceOperation.Comment],
            approval: GrantApproval.Required,
          },
        },
      }),
    ],
  ])("offers no files on %s", (_label, input) => {
    const tools = buildAgentTools(input);
    const comment = tool(tools, IntegrationToolName.SourceItemComment);

    expect(Object.keys(properties(comment))).not.toContain("attachments");
    expect(comment.description).not.toContain("AGENTFLOW_ATTACH");
    expect(describeAgentToolSession(input, tools)).toContain(
      "Do not look for other ways (curl"
    );
  });
});

describe("source attachment read tool", () => {
  it("is offered on a source whose provider reads attachments, and plans the file name", () => {
    const tools = buildAgentTools(session());
    const read = tool(tools, IntegrationToolName.SourceItemAttachmentRead);

    expect(read.access).toBe(IntegrationToolAccess.Read);
    expect(Object.keys(properties(read))).toEqual(["name"]);
    expect(read.plan({ name: " PRD-LD-1.md " })).toEqual({
      ok: true,
      value: { kind: "read_source_attachment", name: "PRD-LD-1.md" },
    });
    expect(read.plan({}).ok).toBe(false);
  });

  it("is not offered when the source provider does not read attachments", () => {
    const tools = buildAgentTools(
      session({ provider: IntegrationProviderKey.AzureDevOps })
    );

    expect(names(tools)).not.toContain(
      IntegrationToolName.SourceItemAttachmentRead
    );
  });
});

describe("pull request tools", () => {
  const SHOP_PR: RunPullRequestRef = {
    url: "https://bitbucket.org/acme/shop/pull-requests/12",
    number: 12,
    repository: "acme/shop",
    provider: IntegrationProviderKey.Bitbucket,
  };

  it("are offered with the pull_requests grant only", () => {
    expect(
      names(buildAgentTools(session({ pullRequests: [SHOP_PR] })))
    ).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
    ]);
    expect(
      names(
        buildAgentTools(
          session({ grants: { [PULL_REQUESTS_CONNECTION_KEY]: "read" } })
        )
      )
    ).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
      IntegrationToolName.PullRequestsList,
    ]);
  });

  it("name the pull request from an enum of the run's own and plan the writes", () => {
    const tools = buildAgentTools(
      session({
        grants: {
          [PULL_REQUESTS_CONNECTION_KEY]: {
            allow: [PullRequestOperation.Reply, PullRequestOperation.Resolve],
            approval: GrantApproval.Required,
          },
        },
        pullRequests: [SHOP_PR],
      })
    );
    const reply = tool(tools, IntegrationToolName.PullRequestReply);

    expect(names(tools)).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
      IntegrationToolName.PullRequestsList,
      IntegrationToolName.PullRequestThreads,
      IntegrationToolName.PullRequestReply,
      IntegrationToolName.PullRequestResolve,
    ]);
    expect(properties(reply).pullRequest?.enum).toEqual([SHOP_PR.url]);
    expect(reply.access).toBe(IntegrationToolAccess.Write);
    expect(
      reply.plan({ pullRequest: SHOP_PR.url, threadId: 4211, body: " Done " })
    ).toEqual({
      ok: true,
      value: {
        kind: "pull_request_write",
        pullRequest: SHOP_PR,
        operation: PullRequestOperation.Reply,
        threadId: "4211",
        body: "Done",
        requiresApproval: true,
      },
    });
    expect(
      reply.plan({
        pullRequest: "https://bitbucket.org/acme/other/pull-requests/1",
        threadId: "1",
        body: "Done",
      }).ok
    ).toBe(false);
    expect(
      tool(tools, IntegrationToolName.PullRequestThreads).plan({
        pullRequest: SHOP_PR.url,
      })
    ).toEqual({
      ok: true,
      value: {
        kind: "pull_request_threads",
        pullRequest: SHOP_PR,
        status: PullRequestThreadFilter.Open,
      },
    });
  });
});

describe("provider read tools", () => {
  const WIKI: GrantedConnection = {
    key: "wiki",
    name: "Engineering wiki",
    provider: IntegrationProviderKey.Confluence,
    projectConnectionId: "0199a5f0-0000-7000-8000-0000000000c4",
  };

  it("offers a provider's reads on every granted key, its writes when granted", () => {
    const tools = buildAgentTools(
      session({
        grants: { wiki: ["confluence.comment"] },
        connections: [WIKI],
      })
    );
    const getPage = tool(tools, "confluence_get_page");

    expect(names(tools)).toEqual([
      IntegrationToolName.Overview,
      IntegrationToolName.SourceItemGet,
      IntegrationToolName.SourceItemAttachmentRead,
      "confluence_get_page",
      "confluence_find_pages",
      "confluence_list_comments",
      "confluence_comment",
    ]);
    expect(getPage.access).toBe(IntegrationToolAccess.Read);
    expect(properties(getPage).connection?.enum).toEqual(["wiki"]);
    expect(getPage.plan({ connection: "wiki", page: "123" })).toEqual({
      ok: true,
      value: {
        kind: "read_operation",
        connection: WIKI,
        definition: expect.objectContaining({ key: "confluence.get_page" }),
        input: { page: "123", format: "markdown" },
      },
    });
    expect(getPage.plan({ connection: "jira-internal", page: "1" }).ok).toBe(
      false
    );
    expect(getPage.plan({ connection: "wiki" }).ok).toBe(false);
  });
});

describe("tool descriptions", () => {
  const tools = buildAgentTools(
    session({
      grants: {
        source: [
          SourceOperation.Comment,
          SourceOperation.Transition,
          SourceOperation.Label,
          SourceOperation.Link,
        ],
        "teams-release": [TeamsActionType.PostMessage],
        "jira-internal": ConnectionAccess.Read,
      },
      connections: [TEAMS_RELEASE, JIRA_INTERNAL],
    })
  );

  it.each(
    tools.map((candidate) => [candidate.name, candidate])
  )("%s says what it does, when to use it and what not to use it for", (_name, candidate) => {
    const [first] = candidate.description.split("\n");

    expect(first).toMatch(FIRST_SENTENCE_RE);
    expect(candidate.description).toContain("Use when:");
    expect(candidate.description).toContain("Do not use for:");
    expect(candidate.description).toContain("Returns:");
    expect(candidate.description.length).toBeLessThanOrEqual(
      AGENT_TOOL_DESCRIPTION_MAX
    );
    expect(candidate.description).not.toMatch(SECRET_WORDS_RE);
  });

  it.each(
    tools.map((candidate) => [candidate.name, candidate])
  )("%s describes every argument", (_name, candidate) => {
    for (const property of Object.values(properties(candidate))) {
      expect(property.description).toEqual(expect.any(String));
    }
  });

  it("points each source write at the other one", () => {
    expect(
      tool(tools, IntegrationToolName.SourceItemComment).description
    ).toContain(`use ${IntegrationToolName.SourceItemTransition}`);
    expect(
      tool(tools, IntegrationToolName.SourceItemTransition).description
    ).toContain(`use ${IntegrationToolName.SourceItemComment}`);
  });
});

const FIRST_SENTENCE_RE = /^[A-Z].+\.$/;
const SECRET_WORDS_RE = /token|password|api key|secret/i;

function session(
  overrides: {
    provider?: string | null;
    grants?: ConnectionGrants;
    connections?: GrantedConnection[];
    pullRequests?: RunPullRequestRef[];
  } = {}
): AgentToolSessionInput {
  const provider =
    overrides.provider === undefined
      ? IntegrationProviderKey.Jira
      : overrides.provider;
  return {
    agent: "an instruction",
    workflowName: "Support tickets",
    runUrl: "https://app.test/acme/workflows/w/runs/run-1",
    source: {
      ref: {
        provider: provider ?? "http",
        externalId: "10007",
        key: "JB-7",
        url: "https://customer.atlassian.net/browse/JB-7",
        title: "Login fails",
        container: "JB",
      },
      provider,
      key: provider ? "jira-customer" : null,
    },
    grants: normalizeConnectionGrants(overrides.grants),
    connections: overrides.connections ?? [],
    pullRequests: overrides.pullRequests ?? [],
  };
}

function names(tools: readonly AgentTool[]): string[] {
  return tools.map((candidate) => candidate.name);
}

function tool(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`No tool ${name} in ${names(tools).join(", ")}`);
  }
  return found;
}

function properties(
  candidate: AgentTool
): Record<string, { description?: string; enum?: unknown[] }> {
  return candidate.inputSchema.properties as Record<
    string,
    { description?: string; enum?: unknown[] }
  >;
}

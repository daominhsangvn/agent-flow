/**
 * Atlassian's documented sample body of the Jira Automation "Send web request"
 * action with "Issue data (Jira format)", copied verbatim from
 * https://support.atlassian.com/cloud-automation/docs/issue-data-jira-format-payload-for-send-web-request-action/
 * (fetched 2026-10-04). Automation generates this body itself, so it differs
 * from admin webhooks: numeric ids, epoch-millisecond `created` / `updated`,
 * `renderedFields: null` and `changelog.histories: null`. In the sample the
 * same account is assignee and acting user.
 */

export const AUTOMATION_SAMPLE_ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

export function atlassianAutomationIssueDataSample() {
  return {
    issue: {
      self: "https://sample.jira-dev.com/rest/api/2/issue/11111",
      id: 11_111,
      key: "SP-53",
      changelog: {
        startAt: 0,
        maxResults: 0,
        total: 0,
        histories: null,
      },
      fields: {
        statuscategorychangedate: "2022-02-18T15:20:11.662+0530",
        issuetype: {
          self: "https://sample.jira-dev.com/rest/api/2/issuetype/22222",
          id: 22_222,
          description: "A request that follows ITSM workflows.",
          iconUrl:
            "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/issuetype/avatar/10553?size=medium",
          name: "[System] Service request",
          subtask: false,
          fields: null,
          statuses: [],
          namedValue: "[System] Service request",
        },
        timespent: null,
        customfield_10030: null,
        customfield_10031: {
          languageCode: "en",
          displayName: "English",
        },
        project: {
          self: "https://sample.jira-dev.com/rest/api/2/project/10002",
          id: 10_002,
          key: "SP",
          name: "New ITSM Project",
          description: null,
          avatarUrls: {
            "48x48":
              "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/project/avatar/10414",
            "24x24":
              "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/project/avatar/10414?size=small",
            "16x16":
              "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/project/avatar/10414?size=xsmall",
            "32x32":
              "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/project/avatar/10414?size=medium",
          },
          issuetypes: null,
          projectCategory: null,
          email: null,
          lead: null,
          steps: null,
          versions: null,
          projectTypeKey: "service_desk",
          simplified: false,
        },
        customfield_10032: null,
        customfield_10033: null,
        fixVersions: [],
        aggregatetimespent: null,
        customfield_10034: null,
        customfield_10035: null,
        resolution: null,
        customfield_10036: null,
        customfield_10037: null,
        customfield_10027: [],
        customfield_10028: null,
        customfield_10029: null,
        resolutiondate: null,
        workratio: -1,
        lastViewed: null,
        issuerestriction: {
          issuerestrictions: {},
          shouldDisplay: false,
        },
        watches: {
          self: "https://sample.jira-dev.com/rest/api/2/issue/SP-53/watchers",
          watchCount: 2,
          isWatching: false,
        },
        created: 1_645_177_810_768,
        customfield_10020: null,
        customfield_10021: null,
        customfield_10022: null,
        customfield_10023: null,
        priority: {
          self: "https://sample.jira-dev.com/rest/api/2/priority/3",
          id: 3,
          name: "Medium",
          iconUrl:
            "https://sample.jira-dev.com/images/icons/priorities/medium.svg",
          namedValue: "Medium",
        },
        customfield_10024: "2022-02-18T15:29:50.221+0530",
        customfield_10025: null,
        customfield_10026: "Service requests",
        labels: ["sample-space"],
        customfield_10016: null,
        customfield_10017: null,
        customfield_10018: {
          hasEpicLinkFieldDependency: false,
          showField: false,
          nonEditableReason: {
            reason: "PLUGIN_LICENSE_ERROR",
            message: "The Parent Link is only available to Jira Premium users.",
          },
        },
        customfield_10019: "0|i000lb:",
        timeestimate: null,
        aggregatetimeoriginalestimate: null,
        versions: [],
        issuelinks: [],
        assignee: {
          self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: null,
          key: null,
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          emailAddress: null,
          avatarUrls: {
            "48x48":
              "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
          },
          displayName: "User Name",
          active: true,
          timeZone: "Asia/Calcutta",
          groups: null,
          locale: null,
          accountType: "atlassian",
        },
        updated: 1_645_785_255_778,
        status: {
          self: "https://sample.jira-dev.com/rest/api/2/status/10001",
          description:
            "This was auto-generated by Jira Service Management during workflow import",
          iconUrl:
            "https://sample.jira-dev.com/images/icons/status_generic.gif",
          name: "Waiting for support",
          untranslatedName: null,
          id: 10_001,
          statusCategory: {
            self: "https://sample.jira-dev.com/rest/api/2/statuscategory/4",
            id: 4,
            key: "indeterminate",
            colorName: "yellow",
            name: "In Progress",
          },
          untranslatedNameValue: null,
        },
        steps: [],
        customfield_10050: null,
        customfield_10051: {
          id: "9",
          name: "Time to resolution",
          _links: {
            self: "https://sample.jira-dev.com/rest/servicedeskapi/request/11111/sla/9",
          },
          completedCycles: [],
          ongoingCycle: {
            startTime: {
              iso8601: "2022-02-18T15:20:10+0530",
              jira: "2022-02-18T15:20:10.768+0530",
              friendly: "18/Feb/22 3:20 PM",
              epochMillis: 1_645_177_810_768,
            },
            breachTime: {
              iso8601: "2022-02-21T15:20:10+0530",
              jira: "2022-02-21T15:20:10.768+0530",
              friendly: "Monday 3:20 PM",
              epochMillis: 1_645_437_010_768,
            },
            breached: true,
            paused: false,
            withinCalendarHours: true,
            goalDuration: {
              millis: 28_800_000,
              friendly: "8h",
            },
            elapsedTime: {
              millis: 146_686_647,
              friendly: "40h 44m",
            },
            remainingTime: {
              millis: -117_886_647,
              friendly: "-32h 44m",
            },
          },
        },
        timeoriginalestimate: null,
        customfield_10052: {
          id: "10",
          name: "Time to first response",
          _links: {
            self: "https://sample.jira-dev.com/rest/servicedeskapi/request/11111/sla/10",
          },
          completedCycles: [
            {
              startTime: {
                iso8601: "2022-02-18T15:20:10+0530",
                jira: "2022-02-18T15:20:10.768+0530",
                friendly: "18/Feb/22 3:20 PM",
                epochMillis: 1_645_177_810_768,
              },
              stopTime: {
                iso8601: "2022-02-18T15:29:50+0530",
                jira: "2022-02-18T15:29:50.221+0530",
                friendly: "18/Feb/22 3:29 PM",
                epochMillis: 1_645_178_390_221,
              },
              breachTime: {
                iso8601: "2022-02-21T11:20:10+0530",
                jira: "2022-02-21T11:20:10.768+0530",
                friendly: "Monday 11:20 AM",
                epochMillis: 1_645_422_610_768,
              },
              breached: false,
              goalDuration: {
                millis: 14_400_000,
                friendly: "4h",
              },
              elapsedTime: {
                millis: 579_453,
                friendly: "9m",
              },
              remainingTime: {
                millis: 13_820_547,
                friendly: "3h 50m",
              },
            },
          ],
        },
        description: "sample desc",
        customfield_10053: {
          id: "11",
          name: "Time to close after resolution",
          _links: {
            self: "https://sample.jira-dev.com/rest/servicedeskapi/request/11111/sla/11",
          },
          completedCycles: [],
        },
        customfield_10010: {
          _links: {
            jiraRest: "https://sample.jira-dev.com/rest/api/2/issue/11111",
            web: "https://sample.jira-dev.com/servicedesk/customer/portal/3/SP-53",
            self: "https://sample.jira-dev.com/rest/servicedeskapi/request/11111",
            agent: "https://sample.jira-dev.com/browse/SP-53",
          },
          requestType: {
            _expands: ["field"],
            id: "42",
            _links: {
              self: "https://sample.jira-dev.com/rest/servicedeskapi/servicedesk/3/requesttype/42",
            },
            name: "Emailed request",
            description: "Request received from your email support channel.",
            helpText: "",
            issueTypeId: "22222",
            serviceDeskId: "3",
            groupIds: [],
            icon: {
              id: "10527",
              _links: {
                iconUrls: {
                  "48x48":
                    "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/SD_REQTYPE/avatar/10527?size=large",
                  "24x24":
                    "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/SD_REQTYPE/avatar/10527?size=small",
                  "16x16":
                    "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/SD_REQTYPE/avatar/10527?size=xsmall",
                  "32x32":
                    "https://sample.jira-dev.com/rest/api/2/universal_avatar/view/type/SD_REQTYPE/avatar/10527?size=medium",
                },
              },
            },
          },
          currentStatus: {
            status: "Waiting for support",
            statusCategory: "INDETERMINATE",
            statusDate: {
              iso8601: "2022-02-18T15:20:10+0530",
              jira: "2022-02-18T15:20:10.768+0530",
              friendly: "18/Feb/22 3:20 PM",
              epochMillis: 1_645_177_810_768,
            },
          },
        },
        customfield_10054: {
          id: "12",
          name: "Time to review normal change",
          _links: {
            self: "https://sample.jira-dev.com/rest/servicedeskapi/request/11111/sla/12",
          },
          completedCycles: [],
        },
        customfield_10055: null,
        customfield_10014: null,
        customfield_10015: null,
        timetracking: {
          originalEstimate: null,
          remainingEstimate: null,
          timeSpent: null,
          originalEstimateSeconds: 0,
          remainingEstimateSeconds: 0,
          timeSpentSeconds: 0,
        },
        customfield_10005: null,
        customfield_10049: [],
        customfield_10006: null,
        customfield_10007: null,
        security: null,
        customfield_10008: null,
        attachment: [],
        customfield_10009: null,
        aggregatetimeestimate: null,
        summary: "sample, Please ignore",
        creator: {
          self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: null,
          key: null,
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          emailAddress: null,
          avatarUrls: {
            "48x48":
              "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
          },
          displayName: "User Name",
          active: true,
          timeZone: "Asia/Calcutta",
          groups: null,
          locale: null,
          accountType: "atlassian",
        },
        subtasks: [],
        customfield_10040: null,
        customfield_10041: null,
        customfield_10042: null,
        customfield_10043: null,
        reporter: {
          self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
          name: null,
          key: null,
          accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
          emailAddress: null,
          avatarUrls: {
            "48x48":
              "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
          },
          displayName: "User Name",
          active: true,
          timeZone: "Asia/Calcutta",
          groups: null,
          locale: null,
          accountType: "atlassian",
        },
        customfield_10000: "{}",
        aggregateprogress: {
          progress: 0,
          total: 0,
        },
        customfield_10044: null,
        customfield_10045: null,
        customfield_10001: null,
        customfield_10002: [],
        customfield_10046: null,
        customfield_10047: null,
        customfield_22222: null,
        customfield_10004: null,
        customfield_10048: null,
        customfield_10038: null,
        customfield_10039: null,
        environment: null,
        duedate: null,
        progress: {
          progress: 0,
          total: 0,
        },
        votes: {
          self: "https://sample.jira-dev.com/rest/api/2/issue/SP-53/votes",
          votes: 0,
          hasVoted: false,
        },
        comment: {
          maxResults: 1,
          total: 1,
          startAt: 0,
          comments: [
            {
              self: "https://sample.jira-dev.com/rest/api/2/issue/11111/comment/10078",
              id: 10_078,
              author: {
                self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
                name: null,
                key: null,
                accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
                emailAddress: null,
                avatarUrls: {
                  "48x48":
                    "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
                },
                displayName: "User Name",
                active: true,
                timeZone: "Asia/Calcutta",
                groups: null,
                locale: null,
                accountType: "atlassian",
              },
              body: "Hello, added a comment.",
              renderedBody: null,
              updateAuthor: {
                self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
                name: null,
                key: null,
                accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
                emailAddress: null,
                avatarUrls: {
                  "48x48":
                    "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
                },
                displayName: "User Name",
                active: true,
                timeZone: "Asia/Calcutta",
                groups: null,
                locale: null,
                accountType: "atlassian",
              },
              created: 1_645_785_255_778,
              updated: 1_645_785_255_778,
              visibility: null,
            },
          ],
          last: false,
        },
        worklog: {
          maxResults: 20,
          total: 0,
          startAt: 0,
          worklogs: [],
          last: false,
        },
      },
      renderedFields: null,
    },
    comment: {
      self: "https://sample.jira-dev.com/rest/api/2/issue/11111/comment/10078",
      id: 10_078,
      author: {
        self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: null,
        key: null,
        accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        emailAddress: null,
        avatarUrls: {
          "48x48":
            "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
        },
        displayName: "User Name",
        active: true,
        timeZone: "Asia/Calcutta",
        groups: null,
        locale: null,
        accountType: "atlassian",
      },
      body: "Hello, added a comment.",
      renderedBody: null,
      updateAuthor: {
        self: "https://sample.jira-dev.com/rest/api/2/user?accountId=aaaaaaaaaaaaaaaaaaaaaaaaaa",
        name: null,
        key: null,
        accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        emailAddress: null,
        avatarUrls: {
          "48x48":
            "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
        },
        displayName: "User Name",
        active: true,
        timeZone: "Asia/Calcutta",
        groups: null,
        locale: null,
        accountType: "atlassian",
      },
      created: 1_645_785_255_778,
      updated: 1_645_785_255_778,
      visibility: null,
    },
    user: {
      self: null,
      name: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      key: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
      emailAddress: null,
      avatarUrls: {
        "48x48":
          "https://secure.gravatar.com/avatar/111111111111111111111111111111111111111?d=https%3A%2F%2Favatar-management--avatars.us-west-2.staging.public.atl-paas.net%2Finitials%2FSJ-1.png",
      },
      displayName: "User Name",
      active: true,
      timeZone: null,
      groups: null,
      locale: "en_GB",
      accountType: "atlassian",
    },
    timestamp: 1_645_785_298_912,
  };
}

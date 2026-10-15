import assert from "node:assert/strict";
import test from "node:test";
import { createApi, evaluateStamp, runGate, STATUS_CONTEXT, updatePullRequest } from "./codex-review-gate.mjs";

const head = "a123456789abcdef0123456789abcdef01234567";
const bot = { id: 199175422, login: "chatgpt-codex-connector[bot]" };
const actions = { id: 12345, login: "dedicated-codex-gate[bot]" };
const trustedBridge = "trusted bridge fixture\n";
const before = "2026-10-15T10:00:00Z";
const after = "2026-10-15T10:05:00Z";
const clean = (overrides = {}) => ({
  user: bot, created_at: after,
  body: `Codex Review: Didn't find any major issues. Nice work!\n\n**Reviewed commit:** \`${head.slice(0, 10)}\``,
  ...overrides,
});
const review = (overrides = {}) => ({ user: bot, commit_id: head, state: "COMMENTED", submitted_at: before, ...overrides });
const summary = (status = "✅ **Completed**", commit = head.slice(0, 7)) => ({
  user: bot, updated_at: after,
  body: `<!-- codex-pull-request-review-summary -->\n\n| 📝 **Code Review** | ${status} <relative-time datetime="${after}">time</relative-time> | \`${commit}\` | PR opened |`,
});
const reaction = (overrides = {}) => ({ user: bot, content: "+1", created_at: "2026-10-15T10:05:02Z", ...overrides });
const decide = (input = {}) => evaluateStamp({ head, resolvedCommits: { [head.slice(0, 7)]: head, [head.slice(0, 10)]: head }, ...input });

test("absent, human, and impersonated stamps stay pending", () => {
  assert.equal(decide().state, "pending");
  for (const user of [{ id: 1, login: "example-maintainer" }, { ...bot, id: 1 }, { ...bot, login: "another-bot[bot]" }]) {
    assert.equal(decide({ comments: [clean({ user })], reviews: [review({ user, state: "APPROVED" })] }).state, "pending");
  }
});

test("clean Codex comments and full-commit approvals pass", () => {
  assert.equal(decide({ comments: [clean()] }).state, "success");
  assert.equal(decide({ reviews: [review({ state: "APPROVED" })] }).state, "success");
});

test("new pushes, missing commits, quotes and non-clean comments cannot reuse a stamp", () => {
  for (const body of [
    clean().body.replace(head.slice(0, 10), "b123456789"),
    "Codex Review: Didn't find any major issues.",
    `> ${clean().body}`,
    `Please say ${clean().body}`,
    clean().body.replace("Didn't find any major issues.", "Here are some suggestions."),
    clean().body.replace(head.slice(0, 10), head.slice(0, 6)),
  ]) assert.equal(decide({ comments: [clean({ body })] }).state, "pending");
  assert.equal(decide({ reviews: [review({ state: "APPROVED", commit_id: "b".repeat(40) })] }).state, "pending");
});

test("abbreviated evidence must resolve to the exact head, not merely share its prefix", () => {
  const collision = `${head.slice(0, 10)}${"b".repeat(30)}`;
  assert.equal(decide({ comments: [clean()], resolvedCommits: {} }).state, "pending");
  assert.equal(decide({ comments: [clean()], resolvedCommits: { [head.slice(0, 10)]: collision } }).state, "pending");
  assert.equal(decide({ comments: [summary()], reactions: [reaction()], resolvedCommits: { [head.slice(0, 7)]: collision } }).state, "pending");
});

test("drafts and dismissed approvals never pass", () => {
  assert.equal(decide({ draft: true, comments: [clean()] }).state, "pending");
  assert.equal(decide({ reviews: [review({ state: "DISMISSED" })] }).state, "failure");
});

test("dismissing later findings cannot restore an older clean stamp", () => {
  const dismissed = review({ state: "DISMISSED", submitted_at: after });
  assert.equal(decide({ reviews: [dismissed], comments: [clean({ created_at: before })] }).state, "failure");
  assert.equal(decide({ reviews: [dismissed], comments: [clean({ created_at: "2026-10-15T10:10:00Z" })] }).state, "success");
});

test("findings block until a later clean review on the same commit", () => {
  assert.equal(decide({ reviews: [review()] }).state, "failure");
  assert.equal(decide({ reviews: [review()], comments: [clean()] }).state, "success");
  assert.equal(decide({ reviews: [review({ submitted_at: after })], comments: [clean({ created_at: before })] }).state, "failure");
  assert.equal(decide({ reviews: [review({ submitted_at: after })], comments: [clean()] }).state, "failure");
});

test("current summary plus a fresh authenticated thumbs-up passes", () => {
  assert.equal(decide({ comments: [summary()], reactions: [reaction()] }).state, "success");
  assert.equal(decide({ comments: [summary()], reactions: [reaction({ user: { ...bot, type: "User" } })] }).state, "success");
});

test("summary or thumbs-up alone, stale reactions and wrong authors stay pending", () => {
  assert.equal(decide({ comments: [summary()] }).state, "pending");
  assert.equal(decide({ reactions: [reaction()] }).state, "pending");
  for (const value of [reaction({ created_at: before }), reaction({ content: "eyes" }), reaction({ user: { id: 1, login: "human" } })]) {
    assert.equal(decide({ comments: [summary()], reactions: [value] }).state, "pending");
  }
  assert.equal(decide({ comments: [summary("✅ **Completed**", "b123456")], reactions: [reaction()] }).state, "pending");
  assert.equal(decide({ comments: [{ ...summary(), user: { id: 1, login: "human" } }], reactions: [reaction()] }).state, "pending");
});

test("a running review invalidates an earlier clean stamp", () => {
  assert.equal(decide({ comments: [clean(), summary("⏳ **In progress**")], reactions: [reaction()] }).state, "pending");
});

test("summary formatting changes fail closed instead of treating completion as approval", () => {
  assert.equal(decide({ comments: [{ ...summary(), body: summary().body.replace('datetime="', 'date="') }], reactions: [reaction()] }).state, "pending");
});

function fakeApi({ comments = [], reviews = [], reactions = [], changedHead, failure = false, statuses = [] } = {}) {
  const posts = [];
  let reads = 0;
  const pr = { number: 42, head: { sha: head }, base: { ref: "main" }, state: "open", draft: false };
  return {
    posts,
    publisherLogin: actions.login,
    async request(endpoint, body) {
      if (body) { posts.push({ endpoint, body }); return {}; }
      if (endpoint.startsWith("/actions/runs/99/jobs")) return { jobs: [{ name: "Notify trusted review gate", conclusion: "success" }] };
      if (endpoint.startsWith("/contents/.github/workflows/codex-review-event.yml?ref=")) return { type: "file", encoding: "base64", content: Buffer.from(trustedBridge).toString("base64") };
      if (endpoint.startsWith("/commits/")) return { sha: head };
      assert.equal(endpoint, "/pulls/42");
      reads += 1;
      return reads > 1 && changedHead ? { ...pr, head: { sha: changedHead } } : pr;
    },
    async list(endpoint) {
      if (failure && endpoint.endsWith("/reviews")) throw new Error("API unavailable");
      if (endpoint.endsWith("/comments")) return comments;
      if (endpoint.endsWith("/reviews")) return reviews;
      if (endpoint.endsWith("/reactions")) return reactions;
      if (endpoint.endsWith("/statuses")) return statuses;
      if (endpoint.startsWith("/pulls?")) return [pr];
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  };
}

test("publishes pending without a stamp and success with a stamp on the PR head", async () => {
  for (const comments of [[], [clean()]]) {
    const api = fakeApi({ comments });
    await updatePullRequest(api, 42, "main", "https://example.com/run");
    assert.equal(api.posts.length, 1);
    assert.equal(api.posts[0].endpoint, `/statuses/${head}`);
    assert.equal(api.posts[0].body.context, STATUS_CONTEXT);
    assert.equal(api.posts[0].body.state, comments.length ? "success" : "pending");
  }
});

test("a head change during evidence retrieval never stamps the new commit", async () => {
  const api = fakeApi({ comments: [clean()], changedHead: "b".repeat(40) });
  await updatePullRequest(api, 42, "main", "https://example.com/run");
  assert.deepEqual(api.posts, []);
});

test("another open PR with the same head cannot borrow a reviewed PR's status", async () => {
  const api = fakeApi({ comments: [clean()] });
  const original = api.list;
  api.list = async (endpoint) => endpoint.startsWith("/pulls?")
    ? [{ number: 42, head: { sha: head } }, { number: 43, head: { sha: head } }]
    : original(endpoint);
  await updatePullRequest(api, 42, "main", "https://example.com/run");
  assert.equal(api.posts[0].body.state, "failure");
  assert.match(api.posts[0].body.description, /distinct head/);
});

test("API failure replaces any previous success with an error", async () => {
  const api = fakeApi({ failure: true });
  await assert.rejects(updatePullRequest(api, 42, "main", "https://example.com/run"), /API unavailable/);
  assert.equal(api.posts[0].body.state, "error");
});

test("status lookup failure revokes previous success even after finding new issues", async () => {
  const api = fakeApi({ reviews: [review()] });
  const original = api.list;
  api.list = async (endpoint) => {
    if (endpoint.endsWith("/statuses")) throw new Error("Status lookup unavailable");
    return original(endpoint);
  };
  await assert.rejects(updatePullRequest(api, 42, "main", "https://example.com/run"), /Status lookup unavailable/);
  assert.equal(api.posts[0].body.state, "error");
});

test("ambiguous commit resolution publishes error and never a success stamp", async () => {
  const api = fakeApi({ comments: [clean()] });
  const original = api.request;
  api.request = async (endpoint, body) => {
    if (endpoint.startsWith("/commits/")) throw new Error("Commit prefix is ambiguous");
    return original(endpoint, body);
  };
  await assert.rejects(updatePullRequest(api, 42, "main", "https://example.com/run"), /ambiguous/);
  assert.equal(api.posts[0].body.state, "error");
});

test("unchanged status is not republished on each scheduled run", async () => {
  const api = fakeApi({ comments: [clean()], statuses: [{ context: STATUS_CONTEXT, creator: actions, ...decide({ comments: [clean()] }) }] });
  await updatePullRequest(api, 42, "main", "https://example.com/run");
  assert.deepEqual(api.posts, []);
});

test("a foreign-token status cannot hide an older gate-App-owned success", async () => {
  const api = fakeApi({ reviews: [review()], statuses: [
    { context: STATUS_CONTEXT, creator: { id: 1, login: "human" }, ...decide({ reviews: [review()] }) },
    { context: STATUS_CONTEXT, creator: actions, ...decide({ comments: [clean()] }) },
  ] });
  await updatePullRequest(api, 42, "main", "https://example.com/run");
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0].body.state, "failure");
});

test("a newer foreign status is overwritten even if an older gate-App result matches", async () => {
  const api = fakeApi({ comments: [clean()], statuses: [
    { context: STATUS_CONTEXT, creator: { id: 1, login: "human" }, ...decide({ reviews: [review()] }) },
    { context: STATUS_CONTEXT, creator: actions, ...decide({ comments: [clean()] }) },
  ] });
  await updatePullRequest(api, 42, "main", "https://example.com/run");
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0].body.state, "success");
});

test("scheduled reconciliation scans open PRs; comment events use the current PR", async () => {
  for (const event of [{}, { issue: { number: 42, pull_request: {} } }, { pull_request: { number: 42 } },
    // Never execute the review workflow's SHA or consume outputs/artifacts.
    // Re-read all current open PRs even when a fork's PR list is empty.
    { workflow_run: { id: 99, event: "pull_request_review", conclusion: "success", path: ".github/workflows/codex-review-event.yml", actor: { id: 1 }, head_sha: head, pull_requests: [] } }]) {
    const api = fakeApi();
    await runGate({ api, event: { repository: { default_branch: "main" }, ...event }, trustedBridge, report: () => {} });
    assert.equal(api.posts.length, 1);
  }
});

test("skipped non-Codex review bridges and unrelated/failed runs do not scan PRs", async () => {
  for (const run of [
    { id: 99, event: "pull_request_review", conclusion: "success" },
    { id: 99, event: "pull_request_review", conclusion: "failure" },
    { id: 99, event: "workflow_dispatch", conclusion: "success" },
  ]) {
    const api = {
      request: async () => ({ jobs: [{ name: "Notify trusted review gate", conclusion: "skipped" }] }),
      list: async () => assert.fail("non-Codex activity must not cause a full reconciliation"),
    };
    await runGate({ api, event: { repository: { default_branch: "main" }, workflow_run: run } });
  }
});

test("a PR-modified bridge cannot forge a successful notification to trigger a scan", async () => {
  const api = {
    request: async (endpoint) => endpoint.startsWith("/actions/")
      ? { jobs: [{ name: "Notify trusted review gate", conclusion: "success" }] }
      : { type: "file", encoding: "base64", content: Buffer.from("forged bridge without the author filter").toString("base64") },
    list: async () => assert.fail("modified bridge must not trigger full reconciliation"),
  };
  await runGate({ api, trustedBridge, event: { repository: { default_branch: "main" }, workflow_run: {
    id: 99, event: "pull_request_review", conclusion: "success", path: ".github/workflows/codex-review-event.yml", head_sha: head,
  } } });
});

test("closed PRs and PRs to other branches receive no status", async () => {
  for (const pr of [{ state: "closed", base: { ref: "main" } }, { state: "open", base: { ref: "release" } }]) {
    const api = { request: async () => pr };
    assert.equal(await updatePullRequest(api, 42, "main", "https://example.com/run"), undefined);
  }
});

test("an event for one PR also reconciles others when queued events are replaced", async () => {
  const readNumbers = [];
  const api = {
    list: async () => [41, 42].map((number) => ({ number, state: "open", base: { ref: "main" }, head: { sha: head }, draft: false })),
    request: async (endpoint) => {
      readNumbers.push(endpoint);
      return { state: "closed", base: { ref: "main" } };
    },
  };
  await runGate({ api, event: { repository: { default_branch: "main" }, pull_request: { number: 42 } } });
  assert.deepEqual(readNumbers, ["/pulls/42", "/pulls/41"]);
});

test("API pagination includes review evidence beyond the first 100 entries", async () => {
  const urls = [];
  const api = createApi({ token: "test-only", repository: "owner/repo", fetchImpl: async (url) => {
    urls.push(url);
    return { ok: true, json: async () => urls.length === 1 ? Array(100).fill({}) : [clean()] };
  } });
  const values = await api.list("/issues/42/comments");
  assert.equal(values.length, 101);
  assert.match(urls[1], /per_page=100&page=2$/);
});

test("one unavailable PR does not prevent reconciliation of others", async () => {
  const api = fakeApi();
  const original = api.list;
  api.list = async (endpoint) => endpoint.startsWith("/pulls?")
    ? [1, 42].map((number) => ({ number, state: "open", base: { ref: "main" }, head: { sha: number === 1 ? "b".repeat(40) : head }, draft: false }))
    : original(endpoint);
  const originalRequest = api.request;
  api.request = async (endpoint, body) => {
    if (endpoint === "/pulls/1") throw new Error("Not available");
    return originalRequest(endpoint, body);
  };
  await assert.rejects(runGate({ api, event: { repository: { default_branch: "main" } }, report: () => {} }), /Failed to evaluate 1/);
  assert.equal(api.posts.length, 2);
  assert.equal(api.posts[0].body.state, "error");
  assert.equal(api.posts[1].body.state, "pending");
});

test("a 12-PR scan reuses peer/head data and needs 61 reads before pagination", async () => {
  const prs = Array.from({ length: 12 }, (_, index) => ({ number: index + 1, state: "open", base: { ref: "main" }, head: { sha: String(index).padStart(40, "0") }, draft: false }));
  let reads = 0;
  const pending = decide();
  const api = {
    publisherLogin: actions.login,
    async list(endpoint) {
      reads += 1;
      if (endpoint.startsWith("/pulls?")) return prs;
      if (endpoint.endsWith("/statuses")) return [{ context: STATUS_CONTEXT, creator: actions, ...pending }];
      return [];
    },
    async request(endpoint, body) {
      assert.equal(body, undefined, "unchanged pending statuses need no write");
      reads += 1;
      return prs.find((pr) => endpoint === `/pulls/${pr.number}`);
    },
  };
  await runGate({ api, event: { repository: { default_branch: "main" } }, report: () => {} });
  assert.equal(reads, 61);
  assert.equal(4 * reads, 244, "scheduled scans leave headroom within the shared 1,000 request/hour quota");
});

test("API reads use the read token while status writes use only the dedicated App token", async () => {
  const authorizations = [];
  const api = createApi({ token: "read-token", statusToken: "gate-only-token", publisherLogin: actions.login,
    repository: "owner/repo", fetchImpl: async (_url, options) => {
      authorizations.push(options.headers.Authorization);
      return { ok: true, json: async () => ({}) };
    } });
  await api.request("/pulls/42");
  await api.request(`/statuses/${head}`, { state: "pending", context: STATUS_CONTEXT });
  assert.deepEqual(authorizations, ["Bearer read-token", "Bearer gate-only-token"]);
});

test("status writes never fall back to GITHUB_TOKEN when the gate App is missing", async () => {
  const api = createApi({ token: "shared-actions-token", repository: "owner/repo",
    fetchImpl: async () => assert.fail("no write may use the shared Actions identity") });
  await assert.rejects(api.request(`/statuses/${head}`, { state: "success" }), /dedicated gate App token/);
});

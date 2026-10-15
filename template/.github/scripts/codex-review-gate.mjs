import { readFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const STATUS_CONTEXT = "Codex Review";
// Authenticate the public Codex review identity by account ID and login. Names alone
// are insufficient; reactions currently report this account as type "User".
const isCodex = (item) => item.user?.id === 199175422
  && item.user?.login === "chatgpt-codex-connector[bot]";
const time = (value) => Date.parse(value) || 0;
const matchesHead = (ref, head, resolvedCommits) => /^[a-f0-9]{7,40}$/.test(ref ?? "")
  && head.startsWith(ref) && (ref === head || resolvedCommits?.[ref] === head);
const reviewedCommit = (body) => body?.match(/^\*\*Reviewed commit:\*\* `([a-f0-9]{7,40})`\s*$/m)?.[1];
const summaryRow = (body) => body?.split("\n").find((line) => /^\| 📝 \*\*Code Review\*\* \|/.test(line));
const summaryCommit = (body) => summaryRow(body)?.split("|")[3]?.trim().match(/^`([a-f0-9]{7,40})`$/)?.[1];

export function evaluateStamp({ head, draft, comments = [], reviews = [], reactions = [], resolvedCommits = {} }) {
  if (draft) return { state: "pending", description: "Mark this PR ready and request @codex review." };
  const positives = [];
  const negatives = [];
  for (const review of reviews.filter(isCodex)) {
    if (review.commit_id !== head) continue;
    if (review.state === "APPROVED") positives.push(time(review.submitted_at));
    if (["COMMENTED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
      negatives.push(time(review.submitted_at));
    }
  }
  for (const comment of comments.filter(isCodex)) {
    if (matchesHead(reviewedCommit(comment.body), head, resolvedCommits)
      && /^Codex Review: Didn't find any major issues\./.test(comment.body)) {
      positives.push(time(comment.created_at));
    }
  }

  // New Codex versions may only leave a summary plus a PR thumbs-up. Bind
  // that reaction to the completed Code Review row and its commit/time;
  // neither a bare reaction nor "Completed" alone is an approval stamp.
  const summaries = comments.filter((comment) => isCodex(comment)
    && comment.body?.startsWith("<!-- codex-pull-request-review-summary -->"))
    .sort((a, b) => time(b.updated_at ?? b.created_at) - time(a.updated_at ?? a.created_at));
  const row = summaryRow(summaries[0]?.body);
  if (row) {
    const columns = row.split("|").map((column) => column.trim());
    const commit = columns[3]?.match(/^`([a-f0-9]{7,40})`$/)?.[1];
    if (matchesHead(commit, head, resolvedCommits)) {
      if (!columns[2].startsWith("✅ **Completed**")) {
        return { state: "pending", description: "Waiting for Codex to finish reviewing this commit." };
      }
      const completed = time(columns[2].match(/datetime="([^"]+)"/)?.[1]);
      if (completed && reactions.some((reaction) => isCodex(reaction)
        && reaction.content === "+1" && time(reaction.created_at) >= completed)) {
        positives.push(completed);
      }
    }
  }
  const positive = Math.max(0, ...positives);
  const negative = Math.max(0, ...negatives);
  if (positive > negative) return { state: "success", description: "Codex approved the current PR commit." };
  if (negative) return { state: "failure", description: "Address Codex findings, then request @codex review again." };
  return { state: "pending", description: "Waiting for a clean @codex review stamp on this commit." };
}

export function createApi({ token, statusToken, publisherLogin, repository, apiUrl = "https://api.github.com", fetchImpl = fetch }) {
  const root = `${apiUrl}/repos/${repository}`;
  async function request(endpoint, body) {
    const write = body !== undefined;
    if (write && (!statusToken || !/^\/statuses\/[a-f0-9]{40}$/.test(endpoint))) {
      throw new Error("Status writes require the dedicated gate App token.");
    }
    const response = await fetchImpl(`${root}${endpoint}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${write ? statusToken : token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    // Do not include response bodies, credentials, or PR text in errors/logs.
    if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${endpoint.split("?")[0]}`);
    return response.json();
  }
  async function list(endpoint) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const values = await request(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      result.push(...values);
      if (values.length < 100) return result;
    }
  }
  return { request, list, publisherLogin };
}

export async function updatePullRequest(api, number, defaultBranch, targetUrl, openPullRequests) {
  const pr = openPullRequests?.find((item) => item.number === number) ?? await api.request(`/pulls/${number}`);
  if (pr.state !== "open" || pr.base.ref !== defaultBranch) return;
  const head = pr.head.sha;
  let decision;
  try {
    const [comments, reviews, reactions] = await Promise.all([
      api.list(`/issues/${number}/comments`),
      api.list(`/pulls/${number}/reviews`),
      api.list(`/issues/${number}/reactions`),
    ]);
    // A raw prefix comparison is insufficient: contributors can grind a new
    // commit with the same short SHA. GitHub must resolve each abbreviated
    // reference unambiguously to the exact current full SHA (ambiguity errors
    // take the error-status path). Full SHA evidence needs no extra lookup.
    const refs = new Set(comments.filter(isCodex).flatMap((comment) => [
      reviewedCommit(comment.body),
      comment.body?.startsWith("<!-- codex-pull-request-review-summary -->") ? summaryCommit(comment.body) : undefined,
    ]).filter((ref) => ref && ref.length < 40 && head.startsWith(ref)));
    const resolvedCommits = {};
    for (const ref of refs) resolvedCommits[ref] = (await api.request(`/commits/${ref}`)).sha;
    decision = evaluateStamp({ head, draft: pr.draft, comments, reviews, reactions, resolvedCommits });
    // Required commit statuses are SHA-scoped, not PR-scoped. A reviewed PR
    // must not lend its success to a different open PR with the same head.
    const peers = openPullRequests ?? await api.list(`/pulls?state=open&base=${encodeURIComponent(defaultBranch)}`);
    if (peers.some((peer) => peer.number !== number && peer.head?.sha === head)) {
      decision = { state: "failure", description: "Use a distinct head commit for each open PR before Codex review." };
    }
    // An event can be queued behind newer pushes. Never apply its result to a
    // different head, or overwrite a result using an old event payload.
    const current = await api.request(`/pulls/${number}`);
    if (current.state !== "open" || current.base.ref !== defaultBranch
      || current.head.sha !== head || current.draft !== pr.draft) return;
    const statuses = await api.list(`/commits/${head}/statuses`);
    // The ruleset binds this context to a dedicated App, never the shared
    // Actions identity. Other publishers must not suppress a new gate decision.
    const previous = statuses.find((status) => status.context === STATUS_CONTEXT);
    const owned = Boolean(api.publisherLogin) && previous?.creator?.login === api.publisherLogin;
    if (!owned || previous.state !== decision.state || previous.description !== decision.description) {
      await api.request(`/statuses/${head}`, { context: STATUS_CONTEXT, ...decision, target_url: targetUrl });
    }
    return { number, head, ...decision };
  } catch (error) {
    // Status lookup and final PR refresh errors must also revoke old success.
    await api.request(`/statuses/${head}`, {
      context: STATUS_CONTEXT, state: "error", description: "Unable to verify Codex review; rerun the gate.", target_url: targetUrl,
    });
    throw error;
  }
}

export async function runGate({ api, event, requestedNumber, targetUrl, trustedBridge, report = console.log }) {
  if (event.workflow_run) {
    const run = event.workflow_run;
    if (run.event !== "pull_request_review" || run.conclusion !== "success") return;
    if (!Number.isSafeInteger(run.id) || run.id <= 0) throw new Error("Invalid review workflow run ID.");
    // A workflow containing only skipped jobs can still conclude success.
    // Verify the Codex-filtered bridge actually ran before doing a full scan.
    // Do not filter by run.actor: a human may dismiss a Codex-authored review.
    const { jobs } = await api.request(`/actions/runs/${run.id}/jobs?per_page=100`);
    if (!jobs?.some((job) => job.name === "Notify trusted review gate" && job.conclusion === "success")) return;
    // The bridge revision is PR-controlled. A forged successful job must not
    // bypass its author filter or turn ordinary review edits into full scans.
    const bridgePath = ".github/workflows/codex-review-event.yml";
    if (run.path?.split("@")[0] !== bridgePath || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "") || !trustedBridge) return;
    const source = await api.request(`/contents/${bridgePath}?ref=${run.head_sha}`);
    if (source.type !== "file" || source.encoding !== "base64"
      || Buffer.from(source.content, "base64").toString("utf8").replace(/\r\n/g, "\n") !== trustedBridge.replace(/\r\n/g, "\n")) return;
  }
  const defaultBranch = event.repository.default_branch;
  const number = event.pull_request?.number
    ?? (event.issue?.pull_request ? event.issue.number : undefined)
    ?? requestedNumber;
  if (number !== undefined && !/^[1-9]\d*$/.test(String(number))) throw new Error("Invalid pull request number.");
  // GitHub concurrency retains at most one pending run, replacing older queued
  // events even with cancel-in-progress:false. Always reconcile every open PR
  // so an event for PR B cannot discard PR A's required invalidation.
  // Reuse this snapshot for initial heads and duplicate-head detection, then
  // re-fetch each PR before publishing. Base cost: 1 + 5N API reads, plus
  // resolution of unique matching abbreviated review commit references.
  const openPullRequests = await api.list(`/pulls?state=open&base=${encodeURIComponent(defaultBranch)}`);
  const numbers = openPullRequests.map((pr) => pr.number);
  if (number && numbers.includes(Number(number))) {
    numbers.splice(numbers.indexOf(Number(number)), 1);
    numbers.unshift(Number(number));
  }
  const errors = [];
  for (const prNumber of numbers) {
    try {
      const result = await updatePullRequest(api, prNumber, defaultBranch, targetUrl, openPullRequests);
      if (result) await report(`PR #${result.number} (${result.head.slice(0, 10)}): ${result.state} — ${result.description}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, `Failed to evaluate ${errors.length} pull request(s).`);
}

async function main() {
  const publisherLogin = process.env.GATE_PUBLISHER_LOGIN;
  if (!process.env.GATE_STATUS_TOKEN || !/^[a-z0-9][a-z0-9-]*\[bot\]$/i.test(publisherLogin ?? "")
    || publisherLogin === "github-actions[bot]") {
    throw new Error("Configure the dedicated gate App in the default-branch-only codex-review-gate environment.");
  }
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const api = createApi({ token: process.env.GH_TOKEN, statusToken: process.env.GATE_STATUS_TOKEN, publisherLogin,
    repository: process.env.GITHUB_REPOSITORY, apiUrl: process.env.GITHUB_API_URL });
  await runGate({
    api, event, requestedNumber: process.env.PR_NUMBER || undefined,
    trustedBridge: await readFile(new URL("../workflows/codex-review-event.yml", import.meta.url), "utf8"),
    targetUrl: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    report: async (message) => {
      console.log(message);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

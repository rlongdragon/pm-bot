import path from "node:path";
import { config } from "../config.js";
import type { Link, SyncResult } from "./types.js";
import { oneLine, writeIfChanged } from "./write.js";
import { appConfigured, installUrl, tokenForRepo } from "./github-app.js";

const API = "https://api.github.com";

export function parseGithub(input: string): string | null {
  const s = input.trim();
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i) ??
    s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface GhResp {
  status: number;
  etag?: string;
  body: unknown;
}

async function gh(link: Link, endpoint: string, accept = "application/vnd.github+json"): Promise<GhResp> {
  const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pm-bot" };
  // 優先用 GitHub App（裝在這個 repo 的話），再來是 GITHUB_TOKEN，都沒有就匿名（只能看公開 repo）
  const token = (await tokenForRepo(link.target)) ?? config.githubToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  const etag = link.etags?.[endpoint];
  if (etag) headers["If-None-Match"] = etag;
  const r = await fetch(API + endpoint, { headers, signal: AbortSignal.timeout(20_000) });
  if (r.status === 304) return { status: 304, body: null };
  const text = await r.text();
  if (!r.ok) return { status: r.status, body: text };
  const newEtag = r.headers.get("etag") ?? undefined;
  if (newEtag) (link.etags ??= {})[endpoint] = newEtag;
  return { status: r.status, etag: newEtag, body: accept.includes("raw") ? text : JSON.parse(text) };
}

async function notFound(what: string): Promise<Error> {
  if (appConfigured()) {
    const url = await installUrl().catch(() => null);
    if (url) return new Error(`看不到 ${what}。私有 repo 要先在 GitHub 授權：<${url}>\n在那頁勾這個 repo、按 Install，再 \`/link add\` 一次`);
  }
  return new Error(`找不到 ${what}。私有 repo 要設定 GitHub App（GITHUB_APP_ID）或 GITHUB_TOKEN`);
}

function explain(status: number, body: unknown, what: string): Error {
  const msg = typeof body === "string" ? body.slice(0, 200) : "";
  if (status === 401) return new Error("GITHUB_TOKEN 無效或過期");
  if (status === 403 && /rate limit/i.test(msg)) return new Error("GitHub API 額度用完了。設 GITHUB_TOKEN 額度會從每小時 60 次變 5000 次");
  return new Error(`GitHub ${status}：${msg}`);
}

interface Issue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  updated_at: string;
  body: string | null;
  user?: { login: string };
  assignees?: { login: string }[];
  labels?: ({ name?: string } | string)[];
  pull_request?: { merged_at?: string | null };
}

function fmtIssue(i: Issue): string {
  const who = i.assignees?.length ? i.assignees.map((a) => "@" + a.login).join(" ") : "未指派";
  const labels = (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const state = i.pull_request?.merged_at ? "merged" : i.state;
  const body = oneLine(i.body);
  return (
    `- #${i.number} [${state}] ${i.title} — ${who}${labels.length ? " — " + labels.join("、") : ""} — 開 by @${i.user?.login ?? "?"} — 更新 ${i.updated_at.slice(0, 10)} — <${i.html_url}>` +
    (body ? `\n  ${body}` : "")
  );
}

export async function syncGithub(link: Link, dir: string): Promise<SyncResult> {
  const t = link.target;
  const files: string[] = [];
  let changed = false;
  const put = (name: string, content: string) => {
    files.push(name);
    if (writeIfChanged(path.join(dir, name), content)) changed = true;
  };

  const repo = await gh(link, `/repos/${t}`);
  if (repo.status === 404) throw await notFound(`repo ${t}`);
  if (repo.status !== 200 && repo.status !== 304) throw explain(repo.status, repo.body, `repo ${t}`);
  let title = link.title || t;
  if (repo.status === 200) {
    const r = repo.body as { full_name: string; description: string | null; html_url: string; default_branch: string; private: boolean };
    title = r.full_name;
    put(
      "_repo.md",
      `# ${r.full_name}\n\n${r.description ?? "（沒有描述）"}\n\n- 網址：<${r.html_url}>\n- 預設分支：${r.default_branch}\n- ${r.private ? "私有" : "公開"}\n`,
    );
  }

  const readme = await gh(link, `/repos/${t}/readme`, "application/vnd.github.raw+json");
  if (readme.status === 200) put("README.md", readme.body as string);

  const issues = await gh(link, `/repos/${t}/issues?state=all&sort=updated&direction=desc&per_page=100`);
  if (issues.status === 200) {
    const all = issues.body as Issue[];
    const iss = all.filter((i) => !i.pull_request);
    const prs = all.filter((i) => i.pull_request);
    const head = (k: string, n: number) => `# ${t} ${k}\n\n最近更新的 ${n} 則（最多 100 則，含已關閉）。\n\n`;
    put("issues.md", head("issues", iss.length) + (iss.map(fmtIssue).join("\n") || "（沒有）") + "\n");
    put("pulls.md", head("pull requests", prs.length) + (prs.map(fmtIssue).join("\n") || "（沒有）") + "\n");
  } else if (issues.status !== 304 && issues.status !== 410) throw explain(issues.status, issues.body, "issues");

  const commits = await gh(link, `/repos/${t}/commits?per_page=30`);
  if (commits.status === 200) {
    const cs = commits.body as { sha: string; html_url: string; author?: { login: string } | null; commit: { message: string; author?: { name: string; date: string } } }[];
    const lines = cs.map(
      (c) => `- ${c.commit.author?.date.slice(0, 10) ?? "?"} \`${c.sha.slice(0, 7)}\` @${c.author?.login ?? c.commit.author?.name ?? "?"}：${oneLine(c.commit.message.split("\n")[0], 200)}`,
    );
    put("commits.md", `# ${t} 最近 commits（預設分支，最多 30 則）\n\n${lines.join("\n") || "（沒有）"}\n`);
  } else if (commits.status !== 304 && commits.status !== 409) throw explain(commits.status, commits.body, "commits");

  // docs/ 底下的 markdown，最多 20 個、每個 200KB 內
  const docs = await gh(link, `/repos/${t}/contents/docs`);
  if (docs.status === 200 && Array.isArray(docs.body)) {
    const mds = (docs.body as { name: string; path: string; type: string; size: number }[])
      .filter((f) => f.type === "file" && /\.mdx?$/i.test(f.name) && f.size <= 200_000)
      .slice(0, 20);
    for (const f of mds) {
      const raw = await gh(link, `/repos/${t}/contents/${encodeURI(f.path)}`, "application/vnd.github.raw+json");
      if (raw.status === 200) put(`docs/${f.name}`, raw.body as string);
    }
  }

  return { changed, title, files };
}

export type WorkflowInputs = {
  skip_llm?: string;
  universe_limit?: string;
  refresh_instruments?: string;
  expand_universe?: string;
  force?: string;
  skip_delivery?: string;
};

export type WorkflowConfig = {
  token: string;
  owner: string;
  repo: string;
  workflow: string;
  ref: string;
};

export type WorkflowRun = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at: string | null;
  html_url: string;
};

export function githubWorkflowConfig(): WorkflowConfig {
  return {
    token: process.env.GITHUB_WORKFLOW_TOKEN || process.env.GH_WORKFLOW_TOKEN || "",
    owner: process.env.GITHUB_WORKFLOW_OWNER || "nilay0396",
    repo: process.env.GITHUB_WORKFLOW_REPO || "Stock_pulse",
    workflow: process.env.GITHUB_WORKFLOW_FILE || "daily-report.yml",
    ref: process.env.GITHUB_WORKFLOW_REF || "main",
  };
}

function workflowApiUrl(cfg: WorkflowConfig, suffix: string): string {
  return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${encodeURIComponent(cfg.workflow)}${suffix}`;
}

function githubHeaders(cfg: WorkflowConfig): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${cfg.token}`,
    "content-type": "application/json",
    "user-agent": "market-pulse-india",
    "x-github-api-version": "2022-11-28",
  };
}

export async function dispatchWorkflow(cfg: WorkflowConfig, inputs: WorkflowInputs): Promise<void> {
  const res = await fetch(workflowApiUrl(cfg, "/dispatches"), {
    method: "POST",
    headers: githubHeaders(cfg),
    body: JSON.stringify({ ref: cfg.ref, inputs }),
  });

  if (res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub workflow dispatch failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }
}

export async function listRecentWorkflowRuns(cfg: WorkflowConfig, perPage = 20): Promise<WorkflowRun[]> {
  const res = await fetch(workflowApiUrl(cfg, `/runs?per_page=${perPage}`), {
    headers: githubHeaders(cfg),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub workflow run lookup failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }

  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs || [];
}

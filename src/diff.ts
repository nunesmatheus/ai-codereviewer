import * as core from "@actions/core";
import * as github from "@actions/github";
import AdmZip from "adm-zip";
import parseDiff, { File } from "parse-diff";
import { readFileSync, writeFileSync } from "fs";
import { Octokit } from "@octokit/rest";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const downloadPath = ".";

export const pullRequestDiffFileName = "pull_request.diff";

type PullRequest = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export async function getDiff(pullRequestInfo: PullRequest): Promise<File[]> {
  const currentDiff = await getPullRequestDiff(pullRequestInfo);
  const currentDiffFiles = filterExcludedFiles(parseDiff(currentDiff));
  writeFileSync(pullRequestDiffFileName, currentDiff);

  const previousDiff = await getPreviousDiff(pullRequestInfo);
  if (!previousDiff) return currentDiffFiles;

  const previousDiffFiles = filterExcludedFiles(parseDiff(previousDiff));
  return filterUpdatedChunks(currentDiffFiles, previousDiffFiles);
}

function filterExcludedFiles(files: File[]): File[] {
  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());
  return files.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });
}

async function getPreviousDiff(pullRequestInfo: PullRequest): Promise<string> {
  const artifactId = await lastUploadedDiffArtifactId(pullRequestInfo);
  core.info(`Last successful run artifact ID: ${artifactId || "not found"}`);
  if (!artifactId) return "";

  core.info("Downloading and extracting artifact...");
  await downloadAndExtractArtifact(artifactId);

  return readFileSync(`${downloadPath}/${pullRequestDiffFileName}`, "utf8");
}

async function lastUploadedDiffArtifactId({
  owner,
  repo,
  pullNumber,
}: PullRequest): Promise<number | null> {
  const artifactName = `diff-${pullNumber}`;
  const runId = await getLastSuccessfulRunId(owner, repo);
  core.info(`Last successful run ID: ${runId || "not found"}`);
  if (!runId) return null;

  return getArtifactId(runId, artifactName);
}

function filterUpdatedChunks(
  currentFilesDiff: File[],
  previousFilesDiff: File[]
): File[] {
  return currentFilesDiff.filter((currentFile) => {
    currentFile.chunks = currentFile.chunks.filter((currentChunk) => {
      const hasChunkChanged = !previousFilesDiff.some((previousFile) =>
        previousFile.chunks.some(
          (previousChunk) =>
            JSON.stringify(previousChunk.changes) ===
            JSON.stringify(currentChunk.changes)
        )
      );

      core.info(
        `CHUNK changed: ${hasChunkChanged}:\n${chunkChangesText(currentChunk)}`
      );
      return hasChunkChanged;
    });

    return currentFile.chunks.length > 0;
  });
}

function chunkChangesText(chunk: any): string {
  return (
    chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")
  );
}

async function getLastSuccessfulRunId(
  owner: string,
  repo: string
): Promise<number | null> {
  const runId = github.context.runId;
  const { workflowId, branch } = await getRunDetails({ owner, repo, runId });
  console.log("workflowId", workflowId);
  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    branch,
    status: "success",
    workflow_id: workflowId,
  });

  return runs.total_count > 0 ? runs.workflow_runs[0].id : null;
}

async function getRunDetails({
  owner,
  repo,
  runId,
}: {
  owner: string;
  repo: string;
  runId: number;
}) {
  const runDetails = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  const workflowId = runDetails.data.workflow_url.split("/").pop() || "";
  const branch = runDetails.data.head_branch || "";
  return { workflowId, branch };
}

async function getPullRequestDiff({
  owner,
  repo,
  pullNumber,
}: PullRequest): Promise<string> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  return String(response.data);
}

async function downloadAndExtractArtifact(artifactId: number): Promise<void> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactId,
    archive_format: "zip",
  });
  const zip = new AdmZip(Buffer.from(response.data as string));
  zip.extractAllTo(downloadPath, true);
}

async function getArtifactId(
  runId: number,
  artifactName: string
): Promise<number | null> {
  const { owner, repo } = github.context.repo;
  const listArtifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
  });
  const artifact = listArtifacts.data.artifacts.find(
    (art) => art.name === artifactName
  );
  return artifact ? artifact.id : null;
}

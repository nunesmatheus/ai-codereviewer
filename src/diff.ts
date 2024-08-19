import * as core from "@actions/core";
import * as github from "@actions/github";
import AdmZip from "adm-zip";
import parseDiff, { File, Chunk } from "parse-diff";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { Octokit } from "@octokit/rest";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const downloadPath = "./previous";

export const pullRequestDiffFileName = "pull_request.diff";

type PullRequest = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export async function getDiff(pullRequestInfo: PullRequest): Promise<File[]> {
  const currentDiffFiles = await fetchCurrentDiff(pullRequestInfo);
  const previousDiffFiles = await fetchPreviousDiff(pullRequestInfo);
  if (!previousDiffFiles) return currentDiffFiles;

  return filterUpdatedChunks(currentDiffFiles, previousDiffFiles);
}

async function fetchCurrentDiff({
  owner,
  repo,
  pullNumber,
}: PullRequest): Promise<File[]> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: "diff" },
  });
  const currentDiff = String(response.data);
  persistCurrentDiff(currentDiff);
  return processDiff(currentDiff);
}

async function fetchPreviousDiff(
  pullRequestInfo: PullRequest
): Promise<File[]> {
  const artifactId = await lastUploadedDiffArtifactId(pullRequestInfo);
  core.info(`Last successful run artifact ID: ${artifactId || "not found"}`);
  if (!artifactId) return parseDiff("");

  core.info("Downloading and extracting artifact...");
  await downloadAndExtractArtifact(artifactId);

  const previousDiff = readFileSync(
    `${downloadPath}/${pullRequestDiffFileName}`,
    "utf8"
  );
  return processDiff(previousDiff);
}

/**
 * Filters out the chunks from the latest pull request diff that didn't change comparing to the diff from the previous push,
 * meaning they were not touched and should not be reviewed again.
 *
 * @returns The filtered array of files containing only the chunks that are completely new or were updated.
 */
function filterUpdatedChunks(
  currentFilesDiff: File[],
  previousFilesDiff: File[]
): File[] {
  return currentFilesDiff.filter((currentFile) => {
    currentFile.chunks = currentFile.chunks.filter((currentChunk) => {
      return !hasChunk(previousFilesDiff, currentChunk);
    });

    return currentFile.chunks.length > 0;
  });
}

function processDiff(diff: string): File[] {
  const diffFiles = parseDiff(diff);
  return filterExcludedFiles(diffFiles);
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

function hasChunk(diffFiles: File[], chunk: Chunk): Boolean {
  return diffFiles.some((diffFile) => {
    return diffFile.chunks.some(
      (fileChunk) =>
        JSON.stringify(fileChunk.changes) === JSON.stringify(chunk.changes)
    );
  });
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

async function getLastSuccessfulRunId(
  owner: string,
  repo: string
): Promise<number | null> {
  const runId = github.context.runId;
  const { workflowId, branch } = await getRunDetails({ owner, repo, runId });
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

/**
  Persist the current diff to a file so it can be uploaded as a Github Actions artifact and downloaded in the next run
  to compare with the current pull request diff and find what changed between pushes
  * @param  {[String]} data [Text diff]
*/
function persistCurrentDiff(data: string): void {
  writeFileSync(pullRequestDiffFileName, data);
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
  mkdirSync(downloadPath, { recursive: true });
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

import * as core from "@actions/core";
import * as github from "@actions/github";
import AdmZip from "adm-zip";
import parseDiff, { File } from "parse-diff";
import { readFileSync, writeFileSync } from "fs";
import { Octokit } from "@octokit/rest";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const downloadPath = ".";

export const pullRequestDiffFileName = "pull_request.diff";

export async function getDiff(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<File[]> {
  const artifactName = `diff-${pullNumber}`;

  try {
    const previousDiff = await getPreviousDiff({
      owner,
      repo,
      artifactName,
    });
    const currentDiff = await getPullRequestDiff({ owner, repo, pullNumber });

    writeFileSync(pullRequestDiffFileName, String(currentDiff));

    if (!previousDiff) return parseDiff(currentDiff);

    return filterUpdatedChunks(
      parseDiff(String(currentDiff)),
      parseDiff(previousDiff)
    );
  } catch (error) {
    return handleDiffError(error, artifactName);
  }
}

async function getPreviousDiff({
  owner,
  repo,
  artifactName,
}: {
  owner: string;
  repo: string;
  artifactName: string;
}): Promise<string> {
  const runId = await getLastSuccessfulRunId(owner, repo);
  core.info(`Last successful run ID: ${runId}`);

  if (runId) {
    const artifactId = await getArtifactId(runId, artifactName);
    core.info(`Last successful run artifact ID: ${artifactId}`);

    if (artifactId) {
      core.info("Downloading and extracting artifact...");
      await downloadAndExtractArtifact(artifactId);
      core.info("Found previous diff artifact!");

      return readFileSync(`${downloadPath}/${pullRequestDiffFileName}`, "utf8");
    } else {
      core.info("No artifact found for last successful run");
    }
  } else {
    core.info("No successful last run found");
  }

  return "";
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
      return hasChunkChanged;
    });

    return currentFile.chunks.length > 0;
  });
}

function handleDiffError(error: any, artifactName: string): File[] {
  core.error(`Error: ${error}`);
  core.info(`Artifact not found: ${artifactName}`);
  return parseDiff("");
}

async function getLastSuccessfulRunId(
  owner: string,
  repo: string
): Promise<number | null> {
  const runId = github.context.runId;

  const runDetails = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  const workflowId = runDetails.data.workflow_url.split("/").pop() || "";

  const branch = runDetails.data.head_branch || "";
  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    branch,
    status: "completed",
    conclusion: "success",
    workflow_id: workflowId,
  });

  return runs.total_count > 0 ? runs.workflow_runs[0].id : null;
}

async function getPullRequestDiff({
  owner,
  repo,
  pullNumber,
}: any): Promise<string> {
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

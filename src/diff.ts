import * as core from "@actions/core";
import * as github from "@actions/github";
import AdmZip from "adm-zip";
import parseDiff, { File } from "parse-diff";
import { readFileSync, writeFileSync } from "fs";
import { Octokit } from "@octokit/rest";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const octokit = new Octokit({ auth: GITHUB_TOKEN });

export async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<File[]> {
  const artifactName = `diff-${pull_number}`;
  const downloadPath = ".";

  try {
    const runId = await getLastSuccessfulRunId(owner, repo, "");
    core.info(`Last successful run ID: ${runId}`);
    let previousDiff = "";
    if (runId) {
      const artifactId = await getArtifactId(runId, artifactName);
      core.info(`Last successful run artifact ID: ${artifactId}`);
      if (artifactId) {
        core.info("Downloading and extracting artifact...");
        await downloadAndExtractArtifact(artifactId, downloadPath);
        previousDiff = readFileSync(`${downloadPath}/current_diff.txt`, "utf8");
        core.info("Found previous diff artifact!");
      } else {
        core.info("No artifact found for last successful run");
      }
    } else {
      core.info("No successful last run found");
    }

    const currentDiff = await getFullPrDiff({ owner, repo, pull_number });
    writeFileSync("current_diff.txt", String(currentDiff));

    if (!previousDiff) return parseDiff(currentDiff);

    let currentFilesDiff = parseDiff(String(currentDiff));
    let previousFilesDiff = parseDiff(previousDiff);

    return currentFilesDiff.filter((currentFile) => {
      currentFile.chunks = currentFile.chunks.filter((currentChunk) => {
        const isRepeatingChunk = !!previousFilesDiff.find((previousFile) => {
          return previousFile.chunks.find((previousChunk) => {
            return (
              JSON.stringify(previousChunk.changes) ===
              JSON.stringify(currentChunk.changes)
            );
          });
        });
        return !isRepeatingChunk;
      });

      return currentFile.chunks.length > 0;
    });
  } catch (error) {
    core.error(`Error: ${error}`);
    core.info(`Artifact not found: ${artifactName}`);
    return parseDiff("");
  }
}

async function getLastSuccessfulRunId(
  owner: string,
  repo: string,
  branch: string
): Promise<number | null> {
  const runId = github.context.runId;

  const runDetails = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  const workflowId = runDetails.data.workflow_url.split("/").pop();

  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    branch,
    status: "completed",
    conclusion: "success",
    // @ts-expect-error - workflow_id exists
    workflow_id: workflowId,
  });

  return runs.total_count > 0 ? runs.workflow_runs[0].id : null;
}

async function getFullPrDiff({
  owner,
  repo,
  pull_number,
}: any): Promise<string> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return String(response.data);
}

async function downloadAndExtractArtifact(
  artifactId: number,
  path: string
): Promise<void> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactId,
    archive_format: "zip",
  });
  // @ts-expect-error - response.data is a string
  const zip = new AdmZip(Buffer.from(response.data));
  zip.extractAllTo(path, true);
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

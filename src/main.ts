import { readFileSync, writeFileSync } from "fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { DefaultArtifactClient } from '@actions/artifact'
import AdmZip from "adm-zip";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

const jsonModeSupportedModels = [
  "gpt-4-1106-preview",
  "gpt-3.5-turbo",
  "gpt-4-turbo",
  "gpt-4o",
];

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

type Comment = {
  body: string;
  path: string;
  line: number;
};

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? ""
  };
}

async function getLastSuccessfulRunId(owner: string, repo: string, branch: string): Promise<number | null> {
  const runId = github.context.runId;

  const runDetails = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId
  });

  const workflowId = runDetails.data.workflow_url.split('/').pop();

  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    branch,
    status: 'completed',
    conclusion: 'success',
    // @ts-expect-error - workflow_id exists
    workflow_id: workflowId
  });

  return runs.total_count > 0 ? runs.workflow_runs[0].id : null;
}

async function getArtifactId(runId: number, artifactName: string): Promise<number | null> {
  const { owner, repo } = github.context.repo;
  const listArtifacts = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
  });
  const artifact = listArtifacts.data.artifacts.find(art => art.name === artifactName);
  return artifact ? artifact.id : null;
}

async function downloadAndExtractArtifact(artifactId: number, path: string): Promise<void> {
  const { owner, repo } = github.context.repo;
  const response = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactId,
    archive_format: 'zip',
  });
  // @ts-expect-error - response.data is a string
  const zip = new AdmZip(Buffer.from(response.data));
  zip.extractAllTo(path, true);
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<File[]> {
  const artifactName = `diff-${pull_number}`;
  const downloadPath = '.';

  try {
    const runId = await getLastSuccessfulRunId(owner, repo, '');
    core.info(`Last successful run ID: ${runId}`)
    let previousDiff = '';
    if (runId) {
      const artifactId = await getArtifactId(runId, artifactName);
      core.info(`Last successful run artifact ID: ${artifactId}`)
      if (artifactId) {
        core.info("Downloading and extracting artifact...")
        await downloadAndExtractArtifact(artifactId, downloadPath)
        previousDiff = readFileSync(`${downloadPath}/current_diff.txt`, 'utf8');
        core.info("Found previous diff artifact!")
      } else {
        core.info("No artifact found for last successful run")
      }
    } else {
      core.info("No successful last run found")
    }

    const currentDiff = await getFullPrDiff({ owner, repo, pull_number });
    writeFileSync('current_diff.txt', String(currentDiff));

    if (!previousDiff) return parseDiff(currentDiff)

    let currentFilesDiff = parseDiff(String(currentDiff))
    let previousFilesDiff = parseDiff(previousDiff)

    return currentFilesDiff.filter((currentFile) => {
      currentFile.chunks = currentFile.chunks.filter((currentChunk) => {
        const isRepeatingChunk = !!previousFilesDiff.find((previousFile) => {
          return previousFile.chunks.find((previousChunk) => {
            return JSON.stringify(previousChunk.changes) === JSON.stringify(currentChunk.changes);
          })
        })
        return !isRepeatingChunk;
      })

      return currentFile.chunks.length > 0
    })
  } catch (error) {
    core.error(`Error: ${error}`)
    core.info(`Artifact not found: ${artifactName}`)
    return parseDiff('')
  }
}

async function getFullPrDiff({ owner, repo, pull_number }: any): Promise<string> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return String(response.data);
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails, existingComments: Comment[]): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")}
\`\`\`

${existingCommentsPrompt(existingComments)}`;
}

function existingCommentsPrompt(existingComments: Comment[]) {
  if (existingComments.length === 0) return ""

  const commentMessages = existingComments.map(comment => `Line ${comment.line}: ${comment.body}`)
  const commentsText = [...new Set(commentMessages)].join("\n")
  return `These comments were already made by other reviewers, so do not cover these points:
"""
${commentsText}
"""
`
}

async function existingComments(file: File, chunk: Chunk, prDetails: PRDetails): Promise<any[]> {
  const existingComments = await getExistingComments(prDetails.owner, prDetails.repo, prDetails.pull_number);
  return existingComments.filter((comment: any) => {
    return (
      comment.path === file.to &&
      // @ts-expect-error
      comment.line >= chunk.changes[0].ln &&
      // @ts-expect-error
      comment.line <= chunk.changes[chunk.changes.length - 1].ln
    )
  }).sort((a: any, b: any) => a.line - b.line);
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      ...jsonModeOptions(),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function jsonModeOptions(): Record<string, unknown> {
  if (!jsonModeSupportedModels.includes(OPENAI_API_MODEL)) return {};

  return { response_format: { type: "json_object" } };
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const chunkComments = await existingComments(file, chunk, prDetails)
      const prompt = createPrompt(file, chunk, prDetails, chunkComments);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

async function getExistingComments(owner: string, repo: string, pull_number: number) {
  let page = 1
  let pageData = await getExistingCommentsPage(owner, repo, pull_number, page);
  let data = pageData
  while (pageData.length > 0) {
    page++;
    pageData = await getExistingCommentsPage(owner, repo, pull_number, page);
    data = [...data, ...pageData];
  }
  core.info(`${data.length} existing comments found.`)
  return data;
}

async function getExistingCommentsPage(owner: string, repo: string, pull_number: number, page: number) {
  const { data } = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number,
    page: page,
    per_page: 100,
    sort: "created",
    direction: "desc",
  });
  return data
}

async function uploadDiff(prDetails: any) {
  core.info("Uploading patch as artifact...")
  const artifact = new DefaultArtifactClient()
  const artifactName = `diff-${prDetails.pull_number}`;

  const files = ['current_diff.txt'];
  await artifact.uploadArtifact(
    artifactName,
    files,
    '.',
    {
      retentionDays: 7
    }
  )
  core.info("Uploaded artifact!")
}

async function main() {
  core.info("Getting PR details...")
  const prDetails = await getPRDetails();
  core.info("Getting diff...")
  const diffFiles = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);

  diffFiles.forEach((file) => {
    file.chunks.filter((chunk) => {
      const changes = chunk.changes
        // @ts-expect-error - ln and ln2 exists where needed
        .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
        .join("\n")
      core.info(`\n\n------- Changes:\n${changes}\n-------\n\n`)
    })
  })

  if (diffFiles.length === 0) {
    core.info("No diff found");
    await uploadDiff(prDetails);
    return false;
  }

  core.info("Parsing diff...")

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = diffFiles.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  core.info("Analyzing code with GPT...")
  const comments = await analyzeCode(filteredDiff, prDetails);

  core.info("Creating review comments...")
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }

  await uploadDiff(prDetails)
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

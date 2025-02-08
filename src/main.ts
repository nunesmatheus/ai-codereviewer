import { readFileSync } from "fs";
import * as core from "@actions/core";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Octokit } from "@octokit/rest";
import { Chunk, File } from "parse-diff";
import { DefaultArtifactClient } from "@actions/artifact";
import { getDiff, pullRequestDiffFileName } from "./diff";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const GOOGLE_API_KEY: string = core.getInput("GOOGLE_API_KEY");
const DEBUG: boolean = Boolean(core.getInput("debug"));

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

type Comment = {
  body: string;
  path: string;
  line: number;
  side: string;
};

type AiResponse = {
  lineNumber: number;
  reviewComment: string;
};

type PRDetails = {
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  description: string;
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
    pullNumber: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

function createPrompt(files: File[], prDetails: PRDetails): string {
  const fileChanges = files
    .map((file) => {
      const changes = file.chunks
        .map((chunk) => {
          return `\`\`\`diff
${chunk.content}
${chunkChangesText(chunk)}
\`\`\``;
        })
        .join("\n\n");

      return `Changes in file "${file.to}":\n${changes}`;
    })
    .join("\n\n---\n\n");

  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>", "filePath": "<file_path>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code changes and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Changes to review:

${fileChanges}`;
}

function chunkChangesText(chunk: Chunk): string {
  return (
    chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")
  );
}

async function getAIResponse(
  prompt: string
): Promise<Array<AiResponse & { filePath: string }> | null> {
  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    return JSON.parse(text).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function getLineNumber(change: any): number | null {
  if (change.type === "add") return change.ln;
  if (change.type === "del") return change.ln;
  if (change.type === "normal") return change.ln1 || change.ln2;
  return null;
}

function createComments(
  files: File[],
  aiResponses: Array<AiResponse & { filePath: string }>
): Array<Comment> {
  return aiResponses
    .map((aiResponse) => {
      const file = files.find((f) => f.to === aiResponse.filePath);
      if (!file) return null;

      const chunk = file.chunks.find((chunk) =>
        chunk.changes.some(
          (change) => getLineNumber(change) === aiResponse.lineNumber
        )
      );
      if (!chunk) return null;

      const change = chunk.changes.find(
        (change) => getLineNumber(change) === aiResponse.lineNumber
      );
      if (!change) return null;

      return {
        body: aiResponse.reviewComment,
        path: aiResponse.filePath,
        line: aiResponse.lineNumber,
        side: change.type === "add" ? "RIGHT" : "LEFT",
      };
    })
    .filter((comment): comment is Comment => comment !== null);
}

async function createReviewComment(
  owner: string,
  repo: string,
  pullNumber: number,
  comments: Array<Comment>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    threads: comments,
    event: "COMMENT",
  });
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<Comment>> {
  const prompt = createPrompt(parsedDiff, prDetails);
  if (DEBUG) {
    core.info("Generated prompt:");
    core.info(prompt);
  }

  const aiResponse = await getAIResponse(prompt);
  if (!aiResponse) return [];

  return createComments(parsedDiff, aiResponse);
}

async function uploadDiff(pullNumber: number) {
  core.info("Uploading diff as artifact...");
  const artifact = new DefaultArtifactClient();
  const artifactName = `diff-${pullNumber}`;

  const files = [pullRequestDiffFileName];
  await artifact.uploadArtifact(artifactName, files, ".", {
    retentionDays: 14,
  });
  core.info("Uploaded diff artifact!");
}

function logDiff(diffFiles: File[]) {
  diffFiles.forEach((file) => {
    file.chunks.forEach((chunk) => {
      const changes = chunkChangesText(chunk);
      core.info(`\n\n------- Changes:\n${changes}\n-------\n\n`);
    });
  });
}

async function main() {
  core.info("Getting PR details...");
  const prDetails = await getPRDetails();
  core.info("Getting diff...");
  const diffFiles = await getDiff({
    owner: prDetails.owner,
    repo: prDetails.repo,
    pullNumber: prDetails.pullNumber,
  });

  if (diffFiles.length === 0) {
    core.info(
      "There is no diff identified between this run and the previous one, aborting..."
    );
    await uploadDiff(prDetails.pullNumber);
    return false;
  }

  if (DEBUG) logDiff(diffFiles);

  core.info("Analyzing code with Gemini...");
  const comments = await analyzeCode(diffFiles, prDetails);

  core.info("Creating review comments...");
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pullNumber,
      comments
    );
  }

  await uploadDiff(prDetails.pullNumber);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

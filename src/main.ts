import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { DefaultArtifactClient } from "@actions/artifact";
import { getDiff, pullRequestDiffFileName } from "./diff";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const DEBUG: boolean = Boolean(core.getInput("debug"));

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
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
  pullNumber: number;
  title: string;
  description: string;
}

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

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
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
${chunkChangesText(chunk)}
\`\`\`
`;
}

function chunkChangesText(chunk: Chunk): string {
  return (
    chunk.changes
      // @ts-expect-error - ln and ln2 exists where needed
      .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
      .join("\n")
  );
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
  pullNumber: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
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
      const prompt = createPrompt(file, chunk, prDetails);
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

async function uploadDiff(pullNumber: number) {
  core.info("Uploading diff as artifact...");
  const artifact = new DefaultArtifactClient();
  const artifactName = `diff-${pullNumber}`;

  const files = [pullRequestDiffFileName];
  await artifact.uploadArtifact(artifactName, files, ".", {
    retentionDays: 7,
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
    core.info("No diff found");
    await uploadDiff(prDetails.pullNumber);
    return false;
  }

  core.info("Parsing diff...");

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = diffFiles.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  if (DEBUG) logDiff(filteredDiff);

  core.info("Analyzing code with GPT...");
  const comments = await analyzeCode(filteredDiff, prDetails);

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

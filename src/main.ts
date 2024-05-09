import { readFileSync, writeFileSync, existsSync } from "fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { DefaultArtifactClient } from '@actions/artifact'
import AdmZip from "adm-zip";
import { diffLines } from "diff";

const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  baseBranch: string;
  headSha: string;
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
  // core.info(`PR response: ${JSON.stringify(prResponse)}`)
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
    baseBranch: prResponse.data.base.ref,
    headSha: prResponse.data.head.sha
  };
}

async function getLastSuccessfulRunId(owner: string, repo: string, branch: string): Promise<number | null> {
  // core.info(`github context: ${JSON.stringify(github.context)}`)
  // core.info(`current workflow id: ${github.context.workflow}`)

  const runId = github.context.runId;

  const runDetails = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: runId
  });

  core.info(`workflow url: ${runDetails.data.workflow_url}`)
  const workflowId = runDetails.data.workflow_url.split('/').pop(); // Extract the filename from the URL
  core.info(`Workflow ID: ${workflowId}`);

  const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    branch, // Filter by the branch associated with the PR
    status: 'completed',
    conclusion: 'success',
    // @ts-expect-error - workflow_id exists
    workflow_id: workflowId
  });
  // core.info(`runs: ${JSON.stringify(runs)}`)

  // Return the latest successful run on the branch
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
  zip.extractAllTo(path, true); // Extract to the specified path
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
      core.info(`Last successful run artifact ID: ${runId}`)
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

    // await savePatch({ headSha, base_branch: baseBranch })

    const currentDiff = await getFullPrDiff({ owner, repo, pull_number });
    writeFileSync('current_diff.txt', String(currentDiff));

    if (!previousDiff) return parseDiff(currentDiff)

    let currentFilesDiff = parseDiff(String(currentDiff))
    let previousFilesDiff = parseDiff(previousDiff)

    return currentFilesDiff.filter((currentFile) => {
      currentFile.chunks = currentFile.chunks.filter((currentChunk) => {
        core.info(`Chunk: ${JSON.stringify(currentChunk.changes)}`)
        const isRepeatingChunk = !!previousFilesDiff.find((previousFile) => {
          return previousFile.chunks.find((previousChunk) => {
            return JSON.stringify(previousChunk.changes) === JSON.stringify(currentChunk.changes);
          })
        })
        core.info(`isReapeatingChunk: ${isRepeatingChunk}, content: ${currentChunk.content}`)
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

// async function getDiff(
//   owner: string,
//   repo: string,
//   pull_number: number,
//   baseBranch: string,
//   headSha: string
// ): Promise<string | null> {
//   const artifactName = `diff-${pull_number}`;
//   const downloadPath = '.';

//   try {
//     const runId = await getLastSuccessfulRunId(owner, repo, '');
//     core.info(`Last successful run ID: ${runId}`)
//     let previousDiff = '';
//     if (runId) {
//       const artifactId = await getArtifactId(runId, artifactName);
//       core.info(`Last successful run artifact ID: ${runId}`)
//       if (artifactId) {
//         core.info("Downloading and extracting artifact...")
//         await downloadAndExtractArtifact(artifactId, downloadPath)
//         previousDiff = readFileSync(`${downloadPath}/diff.patch`, 'utf8');
//         core.info("Found previous diff artifact!")
//       } else {
//         core.info("No artifact found for last successful run")
//       }
//     } else {
//       core.info("No successful last run found")
//     }

//     await savePatch({ headSha, base_branch: baseBranch })

//     if (previousDiff) {
//       return applyPatchAndCompare(baseBranch)
//     }

//     const fullDiff = await getFullPrDiff({ owner, repo, pull_number });
//     core.info(`Full diff:\n${fullDiff}`)
//     const files = parseDiff(String(fullDiff))
//     // TODO: We need to filter the chunks here that were already analyzed
//     // Worst case scenario, we at least exclude the files where all chunks have been analyzed
//     files.forEach(function(file) {
//       console.log(file.chunks.length); // number of hunks
//       console.log(file.chunks[0].changes.length) // hunk added/deleted/context lines
//       // each item in changes is a string
//       console.log(file.deletions); // number of deletions in the patch
//       console.log(file.additions); // number of additions in the patch
//       core.info(`chunks: ${JSON.stringify(file.chunks)}`)
//     });

//     const { stdout: diffOutput } = await execAsync('git diff HEAD...origin/pr/HEAD');
//     return diffOutput

//     // const response = await getFullPrDiff({ owner, repo, pull_number });
//     // const fullDiff = String(response);

//     // const trueDiff = previousDiff && compareDiffs(previousDiff, fullDiff) || fullDiff

//     // return [trueDiff, fullDiff]
//   } catch (error) {
//     core.error(`Error: ${error}`)
//     core.info(`Artifact not found: ${artifactName}`)
//     return null
//   }
// }

// @ts-expect-error - pull_number and base_branch exists where needed
async function savePatch({ headSha, base_branch }) {
  await execAsync('git fetch origin');
  await execAsync(`git checkout ${base_branch}`);
  await execAsync(`git diff HEAD...${headSha} > diff.patch`);
}

async function applyPatchAndCompare(base_branch: string) {
  await execAsync(`git checkout ${base_branch}`);
  // Download the artifact containing the diff
  await execAsync(`git apply ./diff.patch`);

  // Now the repository is in the state of the last successful run + the base branch
  // Compare this state to the current HEAD of the PR
  const { stdout: diffOutput } = await execAsync('git diff HEAD...origin/pr/HEAD');
  console.log('Diff between applied state and current PR head:', diffOutput);
  return diffOutput;
}
// async function getDiff(
//   owner: string,
//   repo: string,
//   pull_number: number
// ): Promise<string[] | null[]> {
//   const artifactName = `diff-${pull_number}`;
//   const downloadPath = '.';

//   try {
//     const runId = await getLastSuccessfulRunId(owner, repo, '');
//     core.info(`Last successful run ID: ${runId}`)
//     let previousDiff = '';
//     if (runId) {
//       const artifactId = await getArtifactId(runId, artifactName);
//       core.info(`Last successful run artifact ID: ${runId}`)
//       if (artifactId) {
//         core.info("Downloading and extracting artifact...")
//         await downloadAndExtractArtifact(artifactId, downloadPath)
//         previousDiff = readFileSync(`${downloadPath}/current_diff.txt`, 'utf8');
//         core.info("Found previous diff artifact!")
//       } else {
//         core.info("No artifact found for last successful run")
//       }
//     } else {
//       core.info("No successful last run found")
//     }

//     const response = await getFullPrDiff({ owner, repo, pull_number });
//     const fullDiff = String(response);

//     const trueDiff = previousDiff && compareDiffs(previousDiff, fullDiff) || fullDiff

//     return [trueDiff, fullDiff]
//   } catch (error) {
//     core.error(`Error: ${error}`)
//     core.info(`Artifact not found: ${artifactName}`)
//     return [null, null]
//   }
// }

function compareDiffs(previousDiff: string, latestDiff: string): string {
  const diff = diffLines(previousDiff, latestDiff);
  let newDiff = '';

  diff.forEach(part => {
    // green for additions, red for deletions
    // grey for common parts
    const color = part.added ? 'green' :
      part.removed ? 'red' : 'grey';

    if (color === 'green') {
      newDiff += part.value;
    }
  });

  return newDiff;
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

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

The response must be in valid JSON, without characters such as \` surrounding it.

Review the following code diff in the file "${file.to
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
`;
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
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview" || OPENAI_API_MODEL === "gpt-3.5-turbo" || OPENAI_API_MODEL === "gpt-4-turbo"
        ? { response_format: { type: "json_object" } }
        : {}),
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


async function main() {
  core.info("Getting PR details...")
  const prDetails = await getPRDetails();
  core.info("Getting diff...")
  const diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);

  if (!diff) {
    core.info("No diff found");
    return;
  }

  core.info(`DIFF:`)
  diff.forEach((file) => {
    core.info(`File: ${file.to}`)
    file.chunks.forEach((chunk) => {
      core.info(`Chunk: ${chunk.content}`)
    })
  })

  core.info("Parsing diff...")

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = diff.filter((file) => {
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

  core.info("Uploading patch as artifact...")
  const artifact = new DefaultArtifactClient()
  const artifactName = `diff-${prDetails.pull_number}`;

  const files = ['current_diff.txt'];
  const { id, size } = await artifact.uploadArtifact(
    // name of the artifact
    artifactName,
    // files to include (supports absolute and relative paths)
    files,
    '.',
    {
      // optional: how long to retain the artifact
      // if unspecified, defaults to repository/org retention settings (the limit of this value)
      retentionDays: 10
    }
  )
  console.log(`Created artifact with id: ${id} (bytes: ${size}`)
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

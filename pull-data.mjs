// @ts-check
import zlib from "zlib";

import { parse } from "./parser/zip-parser.mjs";

const forbiddenTags = [
  "cdda-experimental-2021-07-09-1837", // this release had broken json
  "cdda-experimental-2021-07-09-1719",
];

/** @param {import('github-script').AsyncFunctionArguments & {dryRun?: boolean}} AsyncFunctionArguments */
export default async function run({ github, context, dryRun = false }) {
  if (dryRun) {
    console.log("(DRY RUN) No changes will be made to the repository.");
  }
  const dataBranch = "main";

  console.log("Fetching release list...");

  const { data: releases } = await github.rest.repos.listReleases({
    owner: "CleverRaven",
    repo: "Cataclysm-DDA",
  });

  const latestRelease = releases.find((r) =>
    r.tag_name.startsWith("cdda-experimental-"),
  )?.tag_name;

  console.log(`Latest experimental: ${latestRelease}`);

  const blobs = [];
  /** @type {'100644'} */
  const mode = "100644";
  /** @type {'blob'} */
  const type = "blob";

  /**
   * @param {string | Buffer} content
   */
  async function uploadBlob(content) {
    if (dryRun) return { data: { sha: "dry-run-sha" } };
    return typeof content === "string"
      ? await retry(() =>
          github.rest.git.createBlob({
            ...context.repo,
            content,
            encoding: "utf-8",
          }),
        )
      : await retry(() =>
          github.rest.git.createBlob({
            ...context.repo,
            content: content.toString("base64"),
            encoding: "base64",
          }),
        );
  }

  /**
   * Upload a blob to GitHub and save it in our blob list for later tree creation.
   * @param {string} path
   * @param {string | Buffer} content
   */
  async function createBlob(path, content) {
    console.log(`Creating blob at ${path}...`);
    const blob = await uploadBlob(content);
    blobs.push({
      path,
      mode,
      type,
      sha: blob.data.sha,
    });
    return blob;
  }
  /**
   * Copy an already-created blob to a new path.
   * @param {string} fromPath
   * @param {string} toPath
   */
  async function copyBlob(fromPath, toPath) {
    const existingBlob = blobs.find((b) => b.path === fromPath);
    if (!existingBlob) {
      throw new Error(`Blob not found: ${fromPath}`);
    }
    blobs.push({
      path: toPath,
      mode,
      type,
      sha: existingBlob.sha,
    });
  }

  console.log("Collecting info from existing builds...");
  const { data: baseCommit } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: dataBranch,
  });

  const { data: buildsJson } = await github.rest.repos.getContent({
    ...context.repo,
    path: "builds.json",
    ref: baseCommit.sha,
  });
  if (!("type" in buildsJson) || buildsJson.type !== "file")
    throw new Error("builds.json is not a file");
  const existingBuilds = JSON.parse(
    Buffer.from(buildsJson.content, "base64").toString("utf8"),
  );

  const newBuilds = [];

  for (const release of releases.filter(
    (r) => !existingBuilds.some((b) => b.build_number === r.tag_name),
  )) {
    const { tag_name } = release;
    const pathBase = `data/${tag_name}`;
    console.group(`Processing ${tag_name}...`);
    if (forbiddenTags.includes(tag_name)) {
      console.log(`Skipping ${tag_name} because it's on the forbidden list.`);
      continue;
    }

    console.log(`Fetching source...`);

    const { data: zip } = await github.rest.repos.downloadZipballArchive({
      owner: "CleverRaven",
      repo: "Cataclysm-DDA",
      ref: tag_name,
    });

    // @ts-ignore
    const zBuf = Buffer.from(zip)
  
    const { data, dataMods, langs } = await parse(zBuf);

    const allJson = JSON.stringify({
      build_number: tag_name,
      release,
      data,
    })

    const allModsJson = JSON.stringify(dataMods)

    await createBlob(`${pathBase}/all.json`, allJson);
    await createBlob(`${pathBase}/all_mods.json`, allModsJson);

    // We upload a gzipped version of latest for boring GoogleBot reasons
    // TODO: these should go in a separate branch to reduce the total size of the main branch
    if (tag_name === latestRelease) {
      await createBlob("data/latest.gz/all.json", zlib.gzipSync(allJson));
      await createBlob("data/latest.gz/all_mods.json", zlib.gzipSync(allModsJson));
    }

    await Promise.all(Object.entries(langs).map(async ([lang, { jsonStr, pinyinStr }]) => {
      await createBlob(`${pathBase}/lang/${lang}.json`, jsonStr);
      if (tag_name === latestRelease) {
        await createBlob(`data/latest.gz/lang/${lang}.json`,zlib.gzipSync(jsonStr));
      }
      if (pinyinStr) {
        await createBlob(`${pathBase}/lang/${lang}_pinyin.json`, pinyinStr);
        if (tag_name === latestRelease) {
          await createBlob(`data/latest.gz/lang/${lang}_pinyin.json`, zlib.gzipSync(pinyinStr));
        }
      }
    }));

    newBuilds.push({
      build_number: tag_name,
      prerelease: release.prerelease,
      created_at: release.created_at,
      langs: Object.keys(langs),
    });
    console.groupEnd();
  }

  if (newBuilds.length === 0) {
    console.log("No new builds to process. We're done here.");
    return;
  }

  const builds = existingBuilds.concat(newBuilds);

  builds.sort((a, b) => b.created_at.localeCompare(a.created_at));

  console.log(`Writing ${builds.length} builds to builds.json...`);
  await createBlob("builds.json", JSON.stringify(builds));

  const latestBuild = newBuilds.find((b) => b.build_number === latestRelease);
  if (latestBuild) {
    console.log(`Copying ${latestRelease} to latest...`);
    copyBlob(
      `data/${latestBuild.build_number}/all.json`,
      "data/latest/all.json",
    );
    for (const lang of latestBuild.langs)
      copyBlob(
        `data/${latestBuild.build_number}/lang/${lang}.json`,
        `data/latest/lang/${lang}.json`,
      );
  } else {
    console.log(
      `Latest release (${latestRelease}) not in updated builds, skipping copy to latest.`,
    );
  }

  if (dryRun) {
    console.log("(DRY RUN) skipping commit and push.");
    return;
  }

  console.log("Creating tree...");
  const { data: baseTree } = await github.rest.git.getTree({
    ...context.repo,
    tree_sha: baseCommit.commit.tree.sha,
  });

  const { data: tree } = await github.rest.git.createTree({
    ...context.repo,
    tree: blobs,
    base_tree: baseTree.sha,
  });

  console.log("Creating commit...");
  const { data: commit } = await github.rest.git.createCommit({
    ...context.repo,
    message: `Update data for ${builds[0].build_number}`,
    tree: tree.sha,
    author: {
      name: "HHG2C Update Bot",
      email: "hhg2c@users.noreply.github.com",
    },
  });

  console.log(`Updating ref ${dataBranch}...`);
  await github.rest.git.updateRef({
    ...context.repo,
    ref: `heads/${dataBranch}`,
    sha: commit.sha,
    force: true,
  });
}

async function retry(fn, retries = 10) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.error("Error", e.message, "- retrying...");
      // Wait an increasing amount of time between retries
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
  throw new Error("Max retries reached");
}

// @ts-check
import AdmZip from "adm-zip";
import minimatch from "minimatch";
import po2json from "po2json";
import zlib from "zlib";
import path from "path";

import { toPinyin } from "./pinyin.mjs";

function breakJSONIntoSingleObjects(str) {
  const objs = [];
  let depth = 0;
  let line = 1;
  let start = -1;
  let startLine = -1;
  let inString = false;
  let inStringEscSequence = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (inStringEscSequence) {
        inStringEscSequence = false;
      } else {
        if (c === "\\") inStringEscSequence = true;
        else if (c === '"') inString = false;
      }
    } else {
      if (c === "{") {
        if (depth === 0) {
          start = i;
          startLine = line;
        }
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          objs.push({
            obj: JSON.parse(str.slice(start, i + 1)),
            start: startLine,
            end: line,
          });
        }
      } else if (c === '"') {
        inString = true;
      } else if (c === "\n") {
        line++;
      }
    }
  }
  return objs;
}

// copied from gettext.js/bin/po2json
function postprocessPoJson(jsonData) {
  const json = {};
  for (const key in jsonData) {
    // Special headers handling, we do not need everything
    if ("" === key) {
      json[""] = {
        language: jsonData[""]["language"],
        "plural-forms": jsonData[""]["plural-forms"],
      };

      continue;
    }

    // Do not dump untranslated keys, they already are in the templates!
    if ("" !== jsonData[key][1])
      json[key] =
        2 === jsonData[key].length ? jsonData[key][1] : jsonData[key].slice(1);
  }
  return json;
}

const forbiddenTags = [
  "cdda-experimental-2021-07-09-1837", // this release had broken json
  "cdda-experimental-2021-07-09-1719",
];

/**
 * @param {AdmZip} zip
 * @param {string} pattern
 */
function* globZip(zip, pattern) {
  for (const f of zip.getEntries()) {
    if (f.isDirectory) continue;
    if (minimatch(f.entryName, pattern)) {
      yield f;
    }
  }
}

/** @param {import('github-script').AsyncFunctionArguments & {dryRun?: boolean}} AsyncFunctionArguments */
export default async function run({ github, context, dryRun = false }) {
  if (dryRun) {
    console.log("(DRY RUN) No changes will be made to the repository.");
  }
  const dataBranch = "main";

  console.log("Fetching release list...");

  const { data: releases } = await github.rest.repos.listReleases({
    owner: "Cataclysm-TLG",
    repo: "Cataclysm-TLG",
  });

  const latestRelease = releases.find((r) =>
    r.tag_name.startsWith("Cataclysm-TLG"),
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
      owner: "Cataclysm-TLG",
      repo: "Cataclysm-TLG",
      ref: tag_name,
    });

    console.log("Collating JSON...");

    // @ts-ignore
    const z = new AdmZip(Buffer.from(zip));

    const data = [];
    for (const f of globZip(z, "*/data/json/**/*.json")) {
      // The zipball has a top-level directory that we want to ignore
      const filename = f.entryName.split("/").slice(1).join("/");

      // Break up the JSON into individual objects so we can inject line numbers
      const objs = breakJSONIntoSingleObjects(f.getData().toString("utf8"));
      for (const { obj, start, end } of objs) {
        obj.__filename = filename + `#L${start}-L${end}`;
        data.push(obj);
      }
    }

    console.log(`Found ${data.length} objects.`);

    const all = {
      build_number: tag_name,
      release,
      data,
    };
    const allJson = JSON.stringify(all);
    await createBlob(`${pathBase}/all.json`, allJson);

    // We upload a gzipped version of latest for boring GoogleBot reasons
    // TODO: these should go in a separate branch to reduce the total size of the main branch
    if (tag_name === latestRelease)
      await createBlob("data/latest.gz/all.json", zlib.gzipSync(allJson));

    console.group("Compiling lang JSON...");

    // Measure both CPU time and wall time
    console.time("lang JSON");
    const cpuUsage = process.cpuUsage();
    const langs = await Promise.all(
      [...globZip(z, "*/lang/po/*.po")].map(async (f) => {
        const lang = path.basename(f.entryName, ".po");
        const json = postprocessPoJson(
          po2json.parse(f.getData().toString("utf8")),
        );
        const jsonStr = JSON.stringify(json);
        await createBlob(`${pathBase}/lang/${lang}.json`, jsonStr);
        if (tag_name === latestRelease)
          await createBlob(
            `data/latest.gz/lang/${lang}.json`,
            zlib.gzipSync(jsonStr),
          );

        // To support searching Chinese translations by pinyin
        if (lang.startsWith("zh_")) {
          const pinyin = toPinyin(data, json);
          const pinyinStr = JSON.stringify(pinyin);
          await createBlob(`${pathBase}/lang/${lang}_pinyin.json`, pinyinStr);
          if (tag_name === latestRelease)
            await createBlob(
              `data/latest.gz/lang/${lang}_pinyin.json`,
              zlib.gzipSync(pinyinStr),
            );
        }
        return lang;
      }),
    );
    console.timeEnd("lang JSON");
    const newUsage = process.cpuUsage(cpuUsage);
    console.log(
      `CPU time: ${newUsage.user / 1e6}s user, ${newUsage.system / 1e6}s system`,
    );
    newBuilds.push({
      build_number: tag_name,
      prerelease: release.prerelease,
      created_at: release.created_at,
      langs,
    });
    console.groupEnd();
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

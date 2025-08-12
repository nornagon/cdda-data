// @ts-check
import AdmZip from "adm-zip";
import minimatch from "minimatch";
import { Glob } from "glob";
import po2json from "po2json";
import path from "path";
import fs from "fs";

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

/** @param {string | Buffer} zip */
export function globZip(zip) {
    const z = new AdmZip(zip)
    /** @param {string} pattern */
    function* glob(pattern) {
        for (const f of z.getEntries()) {
            if (f.isDirectory) continue
            if (minimatch(f.entryName, `*/${pattern}`)) {
                yield {
                    name: f.entryName.split("/").slice(1).join("/"),
                    data: f.getData().toString("utf8"),
                }
            }
        }
    }
    return glob
}

/** @param {string} dir */
export function globDir(dir) {
    const g1 = new Glob("", {
        cwd: dir,
        nodir: true,
    })
    /** @param {string} pattern */
    function* glob(pattern) {
        const g = new Glob(pattern, g1)
        for (const f of g) {
            yield {
                name: f,
                data: fs.readFileSync(path.join(dir, f), "utf8"),
            }
        }
    }
    return glob
}

/**
 * @param {(pattern: string) => Generator<{
 *  name: string,
 *  data: string
 * }>} globFn 
 * @param {{build_number: string, release: string}} options 
 * @returns {Promise<{
 *  allJson: string,
 *  allModsJson: string,
 *  langs: Record<string, { jsonStr: string, pinyinStr: string | null }>
 * }>}
 */
export async function build(globFn, options) {


    const data = [];
    for (const f of globFn("data/json/**/*.json")) {
        const filename = f.name
        const objs = breakJSONIntoSingleObjects(f.data)
        for (const { obj, start, end } of objs) {
            obj.__filename = filename + `#L${start}-L${end}`;
            data.push(obj);
        }
    }

    console.log(`Found ${data.length} objects.`);

    const all = {
        build_number: options.build_number,
        release: options.release,
        data,
    }
    const allJson = JSON.stringify(all)


    const dataMods = {};
    for (const f of globFn("data/mods/*/**/*.json")) {
      const filename = f.name
      const modName = filename.split("/")[2];
      dataMods[modName] ||= { modName, modinfo: null, data: [] };
      const objs = breakJSONIntoSingleObjects(f.data);
      for (const { obj, start, end } of objs) {
        obj.__mod = modName;
        obj.__filename = filename + `#L${start}-L${end}`;
        if (obj.type === "MOD_INFO") {
          dataMods[modName].modinfo = obj;
        } else {
          dataMods[modName].data.push(obj);
        }
      }
    }
    const allMods = {
      build_number: options.build_number,
      release: options.release,
      data: dataMods,
    }
    const allModsJson = JSON.stringify(allMods)


    console.group("Compiling lang JSON...");
    console.time("lang JSON");
    const cpuUsage = process.cpuUsage();
    const langs = Object.fromEntries(await Promise.all(
      [...globFn("lang/po/*.po")].map(async (f) => {
        const lang = path.basename(f.name, ".po");
        const json = postprocessPoJson(
          po2json.parse(f.data),
        );
        const jsonStr = JSON.stringify(json);

        // To support searching Chinese translations by pinyin
        let pinyinStr = null;
        if (lang.startsWith("zh_")) {
          const pinyin = toPinyin(data, json);
          pinyinStr = JSON.stringify(pinyin);
        }
        return [lang, { jsonStr, pinyinStr }];
      }),
    ))
    console.timeEnd("lang JSON");
    const newUsage = process.cpuUsage(cpuUsage);
    console.log(
      `CPU time: ${newUsage.user / 1e6}s user, ${newUsage.system / 1e6}s system`,
    );
    console.groupEnd();


    return {
        allJson,
        allModsJson,
        langs,
    }
}

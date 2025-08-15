// @ts-check
import po2json from "po2json";
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

/**
 * @param {(pattern: string) => Generator<{
 *  name: string,
 *  data: string
 * }>} globFn 
 * @returns {Promise<{
 *  data: any[],
 *  dataMods: Record<string, { info: any, data: any[] }>,
 *  langs: Record<string, { json: any, pinyin: any | null }>
 * }>}
 */
export async function parse(globFn) {

    console.group("Collating base JSON...");
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

    console.group("Collating mods JSON...");
    /** @type {Record<string, { info: any, data: any[] }>} */
    const dataMods = {};
    for (const f of globFn("data/mods/*/**/*.json")) {
      const filename = f.name.replaceAll("\\", "/");
      const name = filename.split("/")[2];
      dataMods[name] ||= { info: null, data: [] };
      const objs = breakJSONIntoSingleObjects(f.data);
      for (const { obj, start, end } of objs) {
        obj.__mod = name;
        obj.__filename = filename + `#L${start}-L${end}`;
        if (obj.type === "MOD_INFO") {
          dataMods[name].info = obj;
        } else {
          dataMods[name].data.push(obj);
        }
      }
    }
    console.log(`Found ${Object.values(dataMods).reduce((acc, m) => acc + m.data.length, 0)} objects in ${Object.keys(dataMods).length} mods.`);


    console.group("Compiling lang JSON...");
    console.time("lang JSON");
    const cpuUsage = process.cpuUsage();
    let langs = Object.fromEntries(await Promise.all(
      [...globFn("lang/po/*.po")].map(async (f) => {
        const lang = path.basename(f.name, ".po");
        const json = postprocessPoJson(
          po2json.parse(f.data),
        );

        // To support searching Chinese translations by pinyin
        let pinyin = null;
        if (lang.startsWith("zh_")) {
          pinyin = toPinyin(data, json);
        }
        return [lang, { json, pinyin }];
      }),
    ))
    if (Object.keys(langs).length === 0) {
      langs = Object.fromEntries(await Promise.all(
        [...globFn("lang/mo/**/*.mo")].map(async (f) => {
          const lang = f.name.split(/[\\/]/)[2]
          const json = postprocessPoJson(
            po2json.parse(f.data)
          );
          let pinyin = null;
          if (lang.startsWith("zh_")) {
            pinyin = toPinyin(data, json);
          }
          return [lang, { json, pinyin }];
        }),
      ))
    }
    console.timeEnd("lang JSON");
    const newUsage = process.cpuUsage(cpuUsage);
    console.log(
      `CPU time: ${newUsage.user / 1e6}s user, ${newUsage.system / 1e6}s system`,
    );
    console.log(`Found ${Object.keys(langs).length} languages.`);
    console.groupEnd();


    return {
        data,
        dataMods,
        langs,
    }
}

// @ts-check
import fs from "fs"
import path from "path"

import { parse } from "./parser/dir-parser.mjs"

const inputDir = process.argv[2]
const outputDir = process.argv[3] || "local-data"

if (!inputDir) {
  console.error("Usage: missing game directory")
  process.exit(1)
}

const { data, dataMods, langs } = await parse(inputDir)
const allJson = JSON.stringify({
  build_number: "local",
  release: "local",
  data,
  modlist: Object.keys(dataMods),
})
const allModsJson = JSON.stringify(dataMods)

fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, "all.json"), allJson)
fs.writeFileSync(path.join(outputDir, "all_mods.json"), allModsJson)
fs.mkdirSync(path.join(outputDir, "lang"), { recursive: true })
for (const [lang, { jsonStr, pinyinStr }] of Object.entries(langs)) {
  fs.writeFileSync(path.join(outputDir, `lang/${lang}.json`), jsonStr)
  if (pinyinStr) {
    fs.writeFileSync(path.join(outputDir, `lang/${lang}_pinyin.json`), pinyinStr)
  }
}

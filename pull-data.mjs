#!/usr/bin/env zx

import 'zx/globals'
import * as JSONStream from 'JSONStream'

import { toPinyin } from './pinyin.mjs'

echo('Fetching release list...')

const releases = await fetch('https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases').then(j => j.json())

const latest_build = releases[0].tag_name
await fs.writeJSON('latest-build.json', {latest_build})

const forbidden_tags = [
  'cdda-experimental-2021-07-09-1837', // this release had broken json
  'cdda-experimental-2021-07-09-1719',
]

function breakJSONIntoSingleObjects(str) {
  const objs = []
  let depth = 0
  let line = 1
  let start = -1
  let startLine = -1
  let inString = false
  let inStringEscSequence = false
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (inString) {
      if (inStringEscSequence) {
        inStringEscSequence = false
      } else {
        if (c === '\\')
          inStringEscSequence = true
        else if (c === '"')
          inString = false
      }
    } else {
      if (c === '{') {
        if (depth === 0) {
          start = i
          startLine = line
        }
        depth++
      } else if (c === '}') {
        depth--
        if (depth === 0) {
          objs.push({
            obj: JSON.parse(str.slice(start, i+1)),
            start: startLine,
            end: line,
          })
        }
      } else if (c === "\"") {
        inString = true
      } else if (c === '\n') {
        line++
      }
    }
  }
  return objs
}

for (const release of releases) {
  const {tag_name} = release
  try {
    const tarball_url = `https://api.github.com/repos/CleverRaven/Cataclysm-DDA/tarball/${encodeURIComponent(tag_name)}`
    if (forbidden_tags.includes(tag_name)) continue

    if (!fs.existsSync(`data/${tag_name}/all.json`)) {
      echo(`Fetching source for build ${tag_name}...`)
      const src_dir = path.join('data', tag_name, 'src')
      await $`mkdir -p ${src_dir}`
      cd(src_dir)
      await $`curl -sL ${tarball_url} | tar xz --strip-components=1`
      echo('Collating JSON...')
      const json_files = await glob('data/json/**/*.json')
      const data = []
      for (const file of json_files) {
        const objs = breakJSONIntoSingleObjects(await fs.readFile(file, 'utf8'))
        for (const {obj, start, end} of objs) {
          obj.__filename = file + `#L${start}-L${end}`
          data.push(obj)
        }
      }
      const all = {
        build_number: tag_name,
        release,
        data,
      }
      await fs.writeJSON('../all.json', all)

      echo('Compiling lang JSON...')
      await $`mkdir ../lang`

      for (const po_file of await glob('lang/po/*.po')) {
        const lang = path.basename(po_file, '.po')
        await $`npx gettext.js ${po_file} ../lang/${lang}.json`
        if (lang.startsWith('zh_'))
          await fs.writeJSON(`../lang/${lang}_pinyin.json`, toPinyin(data, await fs.readJSON(`../lang/${lang}.json`)))
      }
      echo('Cleaning up...')
      cd('..')
      await $`rm -rf src`
      cd('../..')
    }
  } catch (e) {
    console.error(`Error while processing ${tag_name}:`, e)
  }
}

function readKey(file, keyPath) {
  return new Promise(resolve => {
    const stream = fs.createReadStream(file).pipe(JSONStream.parse(keyPath))
    stream.once('data', (d) => {
      stream.destroy()
      resolve(d)
    })
  })
}

echo('Collecting info from all builds...')
const builds = await within(async () => {
  cd('data')
  const builds = []
  for (const tag_name of await glob('*', {onlyDirectories: true})) {
    if (tag_name === "latest" || tag_name === "latest.gz") continue
    const {prerelease, created_at} = await readKey(path.join(process.cwd(), tag_name, 'all.json'), ['release'])
    const langs = (await glob(path.join(tag_name, 'lang'))).map(f => path.basename(f, '.json')).filter(f => !f.includes('pinyin'))
    builds.push({
      build_number: tag_name,
      prerelease,
      created_at,
      langs
    })
  }
  builds.sort((a, b) => b.created_at.localeCompare(a.created_at))
  return builds
})

echo('Backfilling pinyin...')
for (const {build_number, langs} of builds) {
  for (const lang of langs) {
    if (lang.startsWith('zh_')) {
      const hasPinyin = fs.existsSync(path.join('data', build_number, 'lang', `${lang}_pinyin.json`))
      if (!hasPinyin) {
        echo(`Backfilling pinyin for ${build_number} ${lang}...`)
        const data = await fs.readJSON(path.join('data', build_number, 'all.json'))
        const langJson = await fs.readJSON(path.join('data', build_number, 'lang', `${lang}.json`))
        await fs.writeJSON(path.join('data', build_number, 'lang', `${lang}_pinyin.json`), toPinyin(data.data, langJson))
      }
    }
  }
}

echo('Deleting old builds...')

// Build retention policy:
// 1. Keep all stable releases.
// 2. In the last 30 days, keep all builds.
// 3. In the next 60 days, keep the last build of days with numbers that are 0 mod 2.
// 4. In the next 120 days, keep the last build of days with numbers that are 0 mod 4.
// 5. In the next 240 days, keep the last build of days with numbers that are 0 mod 8.
// 6. Delete all builds older than (30+60+120+240) days.
//
// assuming 1 build / day, this gives:
// 30 builds from the last 30 days
// 30 builds from the next 60 days
// 30 builds from the next 120 days
// 30 builds from the next 240 days
// for a total of (30*4) = 120 builds.
// Each build is ~100MB (25MB data, 75MB langs)
// so this gives a stable size of ~12 GB + N * 100MB, where N is the number of stable releases :)

const msPerDay = 1000 * 60 * 60 * 24

const roundToDay = (d) => {
  d = new Date(d)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

const today = roundToDay(new Date())

const shouldRetain = (createdAtDate) => {
  const createdAtDay = roundToDay(createdAtDate)
  const daysOld = (+today - +createdAtDay) / msPerDay
  if (daysOld > 30+60+120+240)
    return false
  const mod = Math.pow(2, ((daysOld / 30)|0))
  const dayNumber = ((+createdAtDay) / msPerDay)|0
  const moddedDayNumber = dayNumber % mod
  return moddedDayNumber === 0
}

const deleted = new Set
const seenDays = new Set
for (const build of builds) {
  if (!build.prerelease)
    continue
  const createdAtDay = roundToDay(build.created_at)
  const daysOld = (+today - +createdAtDay) / msPerDay
  if (shouldRetain(build.created_at) && (daysOld < 30 || !seenDays.has(daysOld))) {
    seenDays.add(daysOld)
  } else {
    console.log('deleting', build.build_number, `(${daysOld} days old)`)
    await fs.remove(path.join('data', build.build_number))
    deleted.add(build)
  }
}
console.log(`deleted ${deleted.size} builds`)

const filteredBuilds = builds.filter(b => !deleted.has(b))

await fs.writeJSON('builds.json', filteredBuilds)
echo(`Wrote info about ${filteredBuilds.length} builds to builds.json.`)

await $`mkdir -p data/latest/lang`
await $`ln -f data/${latest_build}/all.json data/latest/all.json`
for (const lang_json of await glob(`data/${latest_build}/lang/*.json`))
  await $`ln -f ${lang_json} data/latest/lang/${path.basename(lang_json)}`

// A gzipped version of latest, for GoogleBot reasons
await $`mkdir -p data/latest.gz/lang`
await $`gzip -c data/latest/all.json > data/latest.gz/all.json`
for (const lang_json of await glob(`data/${latest_build}/lang/*.json`))
  await $`gzip -c ${lang_json} > data/latest.gz/lang/${path.basename(lang_json)}`

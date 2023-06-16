import { pinyin } from "pinyin";

export function toPinyin(data, lang) {
  const names = data
    .map(x => x.name)
    .filter(x => x)
    .flatMap(x =>
      typeof x === 'string' ? [x] : [x.str, x.str_sp, x.str_pl].filter(x => x)
    );

  const pinyinJson = {};
  pinyinJson[""] = lang[""];
  for (const name of names) {
    const translation = lang[name];
    if (translation) {
      pinyinJson[name] = Array.isArray(translation) ? translation.map(pinyinify) : pinyinify(translation)
    }
  }

  return pinyinJson
}

function pinyinify(str) {
  return pinyin(str, {
    style: pinyin.STYLE_NORMAL,
    segment: true,
  }).map(x => x.join(" ")).join(" ")
}


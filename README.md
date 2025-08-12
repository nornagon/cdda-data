# ctlg-data

This repo mirrors the JSON and translation data from [Cataclysm: The Last Generation](https://github.com/Cataclysm-TLG/Cataclysm-TLG/) for use in other projects, primarily the [CTLG Interactive Guide](https://skaianet.systems/ctlg). The data is updated automatically every 12 hours.

It was forked from [cdda-data](https://github.com/nornagon/cdda-data/tree/action) by [Nornagon](https://github.com/nornagon).

## Usage

The data is committed to this repository in the `main` branch, while the code for updating the data is in the `action` branch (i.e. this one).

The data is available through `raw.githubusercontent.com` URLs, so you can use it directly in your projects. For example, to get the JSON data for the latest experimental version of the game, you can use the following URL:

```
https://raw.githubusercontent.com/crackedbat/ctlg-data/main/data/latest/all.json
```

The structure of the `all.json` file is:

```json5
{
  "build_number": "[tag name]",
  "release": { /* GitHub release data */ },
  "data": [
    /* every JSON object from the game's data files */
  ]
}
```

Each JSON object in the `data` array is a single object from the game's data files, with an additional `__filename` field that contains the path to the file the object was found in and the line numbers.

### Translations

The translation data for a version is available under `data/[version]/lang/[language].json`. For example, to get the French translation for 0.G, you can use the following URL:

```
https://raw.githubusercontent.com/crackedbat/ctlg-data/main/data/0.G/lang/fr.json
```

The format of the translation files is Jed-compatible, produced with [po2json](https://www.npmjs.com/package/po2json). The keys are the original strings from the game, and the values are the translations.

#### Pinyin

For Chinese translations, there is an additional `zh_*_pinyin.json` file that contains the pinyin for each string. For example, to get the pinyin for the Chinese translation of 0.G, you can use the following URL:

```
https://raw.githubusercontent.com/crackedbat/ctlg-data/main/data/0.G/lang/zh_CN_pinyin.json
```

This file has the same format as the translation file, except the values are the pinyin for the strings. This can be helpful when implementing search functionality for Chinese translations.

## Contributing

To clone the repo without also downloading every historical version of the game, use the `--single-branch` option:

```
git clone --single-branch https://github.com/crackedbat/ctlg-data
```

To run the update script locally, you'll need to have Node.js installed. Then you can run:

```
yarn
node .
```

// @ts-check
import AdmZip from "adm-zip";
import minimatch from "minimatch";

import { parse as baseParse } from "./parser.mjs"

/**
 * @param {string | Buffer} zip
 */
export function parse(zip) {
    return baseParse(glob(zip))
}

/** @param {string | Buffer} zip */
function glob(zip) {
    const z = new AdmZip(zip)
    /** @param {string} pattern */
    function* glob(pattern) {
        for (const f of z.getEntries()) {
            if (f.isDirectory) continue
            if (minimatch(f.entryName, `*/${pattern}`)) {
                yield {
                    name: f.entryName.split("/").slice(1).join("/"),
                    data: () => f.getData().toString("utf8"),
                }
            }
        }
    }
    return glob
}

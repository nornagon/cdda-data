// @ts-check
import { Glob } from "glob";
import { po, mo } from "gettext-parser";
import fs from "fs";
import path from "path";

import { parse as baseParse } from "./parser.mjs"

/**
 * @param {string} dir
 */
export function parse(dir) {
    return baseParse(glob(dir))
}

/** @param {string} dir */
function glob(dir) {
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
                data: f.endsWith(".mo") ?
                    () => po.compile(mo.parse(fs.readFileSync(path.join(dir, f)))).toString("utf8") :
                    () => fs.readFileSync(path.join(dir, f), "utf8"),
            }
        }
    }
    return glob
}

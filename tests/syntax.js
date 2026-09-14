import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
function walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (p.endsWith(".js")) execFileSync(process.execPath, ["--check", p]);
  }
}
walk("chrome-extension");
execFileSync(process.execPath, ["--check", "Tampermonkey.js"]);
console.log("All JavaScript syntax checks passed");

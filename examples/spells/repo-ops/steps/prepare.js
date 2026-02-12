#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const outDir = path.join(process.cwd(), "outputs");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "repo-ops.txt"), "repo ops simulated\n", "utf8");
process.stdout.write("repo ops simulated\n");

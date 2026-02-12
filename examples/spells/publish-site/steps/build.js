#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const inputPath = process.env.INPUT_JSON;
const input = inputPath ? JSON.parse(fs.readFileSync(inputPath, "utf8")) : {};
const siteName = String(input.site_name || "demo-site");

const targetDir = path.join(process.cwd(), "artifacts", "site");
fs.mkdirSync(targetDir, { recursive: true });
fs.writeFileSync(
  path.join(targetDir, "index.html"),
  `<html><body><h1>${siteName}</h1></body></html>\n`,
  "utf8"
);

process.stdout.write(`built site: ${siteName}\n`);

#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`Release version failed: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const releaseType = args.shift();
let write = false;
let packageFile = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "package.json");

while (args.length > 0) {
  const option = args.shift();
  if (option === "--write") {
    write = true;
  } else if (option === "--package") {
    const value = args.shift();
    if (!value) fail("--package requires a file path");
    packageFile = resolve(value);
  } else {
    fail(`unknown option: ${option}`);
  }
}

if (!["major", "minor", "patch"].includes(releaseType)) {
  fail("release type must be major, minor, or patch");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(packageFile, "utf8"));
} catch (error) {
  fail(`cannot read ${packageFile}: ${error.message}`);
}

const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(
  String(manifest.version ?? ""),
);
if (!match) fail(`${packageFile} must contain a semantic version without a prerelease suffix`);

let major = Number(match[1]);
let minor = Number(match[2]);
let patch = Number(match[3]);
if (releaseType === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (releaseType === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

const version = `${major}.${minor}.${patch}`;
if (write) {
  manifest.version = version;
  writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
process.stdout.write(`${version}\n`);

import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const githubTag =
  process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined;
const releaseTag = process.argv[2] ?? githubTag ?? manifest.version;

const failures = [];
if (releaseTag !== manifest.version) {
  failures.push(
    `Release tag ${releaseTag} must exactly match manifest version ${manifest.version}.`,
  );
}
if (packageJson.version !== manifest.version) {
  failures.push(
    `package.json version ${packageJson.version} must match manifest version ${manifest.version}.`,
  );
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  failures.push(
    `versions.json must map ${manifest.version} to ${manifest.minAppVersion}.`,
  );
}

if (failures.length > 0) {
  throw new Error(failures.join("\n"));
}

console.log(
  `Release ${releaseTag} is consistent with manifest.json, package.json, and versions.json.`,
);

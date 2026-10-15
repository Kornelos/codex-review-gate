import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const publicFiles = [
  ".gitattributes", ".gitignore", ".github/workflows/ci.yml",
  "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "package.json",
  "scripts/check-distribution.mjs", "test/distribution.test.mjs",
  "template/.github/scripts/codex-review-gate.mjs",
  "template/.github/scripts/codex-review-gate.test.mjs",
  "template/.github/workflows/codex-review-event.yml",
  "template/.github/workflows/codex-review-gate.yml",
].sort();

export function credentialMarkers(text) {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    /https?:\/\/[^\s/:]+:[^\s/@]+@/,
    /[A-Z]:\\Users\\[^\s\\]+\\/i,
  ].some((pattern) => pattern.test(text));
}

export async function checkDistribution(root) {
  const files = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") continue;
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Unsupported distribution entry: ${relative}`);
    }
  }
  await walk(root);
  const unexpected = files.filter((file) => !publicFiles.includes(file));
  const missing = publicFiles.filter((file) => !files.includes(file));
  const errors = [];
  if (unexpected.length) errors.push(`Unexpected files: ${unexpected.join(", ")}`);
  if (missing.length) errors.push(`Missing files: ${missing.join(", ")}`);
  for (const file of files) {
    const text = await readFile(path.join(root, file), "utf8");
    if (credentialMarkers(text)) errors.push(`Potential credential or local-user path in ${file}`);
    if (!file.endsWith(".yml")) continue;
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*(?:-\s*)?uses:/.test(line)) continue;
      if (!/^\s*(?:-\s*)?uses:\s+[\w.-]+\/[\w./-]+@[a-f0-9]{40}\s+# v[\w.+-]+\s*$/.test(line)) {
        errors.push(`Unpinned or unlabelled action in ${file}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = await checkDistribution(root);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else console.log(`Public distribution verified: ${publicFiles.length} allowlisted files; immutable action references; no detected credential markers.`);
}

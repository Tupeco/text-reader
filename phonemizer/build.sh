#!/usr/bin/env bash
# Builds piper_phonemize.{js,wasm,data} from pinned sources (see Dockerfile) into phonemizer/dist/
# and records their SHA-256 in phonemizer/release.json. Needs Docker with BuildKit; the first build
# takes several minutes. To publish: upload dist/'s files to the GitHub release named in release.json.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
docker build --output "type=local,dest=$here/dist" "$here"
node -e '
  const fs = require("fs"), crypto = require("crypto"), path = require("path");
  const [dir, json] = process.argv.slice(1);
  const release = JSON.parse(fs.readFileSync(json, "utf8"));
  for (const f of Object.keys(release.files))
    release.files[f] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
  fs.writeFileSync(json, JSON.stringify(release, null, 2) + "\n");
' "$here/dist" "$here/release.json"
ls -l "$here/dist"
cat "$here/release.json"

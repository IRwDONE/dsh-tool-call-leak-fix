#!/usr/bin/env bash
# verify/run-all.sh — reproducible full verification battery (verifier-owned).
# Run from the workspace root: bash verify/run-all.sh
set -u
ARTIFACTS="plugin/index.js plugin/src/detect.js package.json plugin/cordis.patch.yml tests/run.mjs docs/INTERFACE.md"

echo "### GIT HEAD"
git log --oneline -n 1 2>/dev/null || echo "(no git)"

echo
echo "### HASHES BEFORE"
sha256sum $ARTIFACTS

echo
echo "### node --check (all JS)"
for f in plugin/index.js plugin/src/detect.js tests/run.js tests/run.mjs tests/check-fixtures.mjs; do
  if [ -f "$f" ]; then
    node --check "$f" && echo "SYNTAX OK  $f"
  else
    echo "MISSING    $f"
  fi
done

echo
echo "### package.json + locale JSON parse"
node -e 'const fs=require("fs");for(const f of ["package.json","plugin/locale/zh.json","plugin/locale/en.json"]){const j=JSON.parse(fs.readFileSync(f,"utf8"));console.log("JSON OK ",f, j.name||j.meta&&j.meta.title||"");}'

echo
echo "### cordis.patch.yml insert check"
grep -n "insert:" plugin/cordis.patch.yml && echo "PATCH: uses - insert:"
grep -nE "^\s*-\s*id:" plugin/cordis.patch.yml

echo
echo "### plugin/ file inventory (deliverables)"
# `-g` suppresses the owner column: this repo is public, so the OS account name
# must never leak into the captured output.
ls -lg plugin plugin/src plugin/locale

echo
echo "### tests/run.mjs (author's harness, run by verifier)"
node tests/run.mjs > verify/tests-run-out.txt 2>&1; echo "tests/run.mjs EXIT=$?"
tail -n 8 verify/tests-run-out.txt

echo
echo "### verify/probe.mjs (independent detector probe)"
node verify/probe.mjs > verify/probe-out.txt 2>&1; echo "probe EXIT=$?"
tail -n 16 verify/probe-out.txt

echo
echo "### verify/probe-index.mjs (independent index.js wiring probe)"
node verify/probe-index.mjs > verify/probe-index-out.txt 2>&1; echo "probe-index EXIT=$?"
tail -n 12 verify/probe-index-out.txt

echo
echo "### HASHES AFTER (must equal BEFORE; a difference means the artifact moved during the run)"
sha256sum $ARTIFACTS

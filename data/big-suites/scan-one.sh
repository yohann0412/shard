#!/usr/bin/env bash
# clone one repo shallowly, scan it, delete it
set -u
# Run from this directory: ./scan-one.sh owner/repo  (writes results/<owner>__<repo>.json)
name="$1"; d="clones/${name//\//__}"
mkdir -p clones results
if [ -s "results/${name//\//__}.json" ]; then exit 0; fi
for i in 1 2 3; do
  timeout 600 git clone -q --depth 1 --single-branch "https://github.com/$name.git" "$d" 2>/dev/null && break
  rm -rf "$d"; sleep 2
done
if [ -d "$d" ]; then
  node scan-suite.mjs "$d" "$name" > "results/${name//\//__}.json" 2>/dev/null || echo "{\"name\":\"$name\",\"error\":\"scan failed\"}" > "results/${name//\//__}.json"
else
  echo "{\"name\":\"$name\",\"error\":\"clone failed\"}" > "results/${name//\//__}.json"
fi
rm -rf "$d"

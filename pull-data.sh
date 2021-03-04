#!/usr/bin/env zsh
set -eo pipefail

echo "Fetching release list..."

release_json="$(curl -sL https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases)"

tarball_url="$(jq -r '.[0].tarball_url' <<< "$release_json")"
tag_name="$(jq -r '.[0].tag_name' <<< "$release_json")"
build_number="$(cut -db -f2 <<< "$tag_name")"

echo "Fetching source for build $build_number..."

mkdir -p "data/$build_number/src" && cd "data/$build_number/src"
curl -sL "$tarball_url" | tar xv --strip-components=1

echo "Collating JSON..."

jq -c '[.[]]' data/json/**/*.json > ../all.json

echo "Cleaning up..."

cd ..
rm -rf src

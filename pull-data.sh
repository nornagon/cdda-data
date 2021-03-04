#!/usr/bin/env zsh
set -eo pipefail

echo "Fetching release list..."

release_json="$(curl -sL https://api.github.com/repos/CleverRaven/Cataclysm-DDA/releases)"

latest_build_number="$(jq -r '.[0].tag_name' <<< "$release_json" | cut -db -f2)"
echo '{latest_build:"'"$latest_build_number"'"}' > latest-build.json

for i in {0..$(jq -r 'length - 1' <<< "$release_json")}; do
  tarball_url="$(jq -r ".[$i].tarball_url" <<< "$release_json")"
  tag_name="$(jq -r ".[$i].tag_name" <<< "$release_json")"
  build_number="$(cut -db -f2 <<< "$tag_name")"

  if [ ! -f "data/$build_number/all.json" ]; then
    echo "Fetching source for build $build_number..."
    mkdir -p "data/$build_number/src" && cd "data/$build_number/src"
    curl -sL "$tarball_url" | tar xz --strip-components=1

    echo "Collating JSON..."

    jq -n -c '{build_number: "'"$build_number"'", release: input['"$i"'], data: [inputs | .[]]}' /dev/stdin data/json/**/*.json <<< "$release_json" > ../all.json

    echo "Cleaning up..."

    cd ..
    rm -rf src
    cd ../..
  fi
done

mkdir -p data/latest
ln -f data/"$latest_build_number"/all.json data/latest/all.json

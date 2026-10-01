#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
case "$(uname -sm)" in
  'Darwin arm64') target=aarch64-apple-darwin ;;
  'Darwin x86_64') target=x86_64-apple-darwin ;;
  'Linux aarch64') target=aarch64-unknown-linux-gnu ;;
  'Linux x86_64') target=x86_64-unknown-linux-gnu ;;
  *) echo 'Unsupported native platform' >&2; exit 1 ;;
esac
mkdir -p .tools .cache
curl -fL "https://github.com/denoland/deno/releases/download/v2.9.7/deno-$target.zip" -o .cache/deno.zip
unzip -o .cache/deno.zip -d .tools
.tools/deno --version

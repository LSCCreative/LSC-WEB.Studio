#!/bin/bash
FILE_PATH="$(cd "$(dirname "$0")" && pwd)/index.html"
open -a "Google Chrome" "$FILE_PATH"

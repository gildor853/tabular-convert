#!/usr/bin/env bash
# Regenerates the interop fixtures in test/fixtures (needs LibreOffice and
# Python with openpyxl; not run in CI, the generated files are committed).
set -euo pipefail
cd "$(dirname "$0")/.."
out=test/fixtures
tmp=$(mktemp -d)
cp scripts/fixtures/libreoffice.fods "$tmp/libreoffice.fods"
soffice --headless --convert-to xlsx --outdir "$tmp" "$tmp/libreoffice.fods" >/dev/null
soffice --headless --convert-to 'xls:MS Excel 97' --outdir "$tmp" "$tmp/libreoffice.fods" >/dev/null
cp "$tmp/libreoffice.xlsx" "$tmp/libreoffice.xls" "$out/"
python3 scripts/fixtures/openpyxl_fixtures.py "$out"
rm -rf "$tmp"
ls -l "$out"

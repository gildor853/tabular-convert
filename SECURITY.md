# Security policy

## Supported versions

Only the `main` branch and the latest `0.x` version receive security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/gildor853/tabular-convert/security/advisories/new>
(repository **Security** tab → **Report a vulnerability**).

Please include the affected version, a minimal input that reproduces the
problem and its impact. You can expect an acknowledgement within 7 days.
Fixes are released as a patch version and credited in the advisory unless you
prefer otherwise.

## Scope

This is a zero-dependency library and command-line tool that reads untrusted
files. In scope: crashes or wrong data on crafted input, excessive CPU or
memory use (super-linear behaviour, zip bombs or other ways around the
documented limits), XML external entity or entity-expansion issues,
prototype pollution, and SQL or CSV output that does not escape values as
documented (e.g. an injection through `writeSql`, or a formula surviving
`escapeFormulas`).

## Disclaimer

This project is provided as is, without warranty. See [DISCLAIMER.md](./DISCLAIMER.md)
for the full disclaimer and limitation of liability.

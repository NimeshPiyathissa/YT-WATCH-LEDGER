#!/usr/bin/env bash
# Watch Ledger installer entry point.   Powered by SciLink Project.
#   git clone https://github.com/NimeshPiyathissa/YT-WATCH-LEDGER.git && cd YT-WATCH-LEDGER && sudo bash install.sh
# This is a thin wrapper: the installer itself is scripts/install.sh (all options, e.g. --dry-run, --resume, --help, work here too).
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/install.sh" "$@"

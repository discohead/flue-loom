#!/usr/bin/env bash
# Copy the starter Flue project into the run's workspace (needs --scaffold).
set -euo pipefail
cp -R "$(dirname "$0")/fixture/." .

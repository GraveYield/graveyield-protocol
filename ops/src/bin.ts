// SPDX-License-Identifier: Apache-2.0
//
// graveyield-ops bin entrypoint. Kept separate from cli.ts so library
// consumers can import the package index without triggering the CLI.

import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`graveyield-ops: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);

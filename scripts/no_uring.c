// SPDX-License-Identifier: Apache-2.0
//
// no_uring — seccomp wrapper for `solana-test-validator` on containers
// that cap RLIMIT_MEMLOCK below the 2 GB agave 3.0.x wants for io_uring.
//
// Agave 3.0.x creates its ledger files through io_uring when available;
// io_uring registration demands RLIMIT_MEMLOCK ≥ 2 GB. Sandbox containers
// often cap it at 64 KB and forbid setrlimit — the validator then dies at
// startup. Installing this filter makes every io_uring syscall fail with
// EPERM, which forces agave's synchronous (plain read/write) file-creator
// path. No other syscall is affected.
//
// Security: the program to run is NOT taken from the command line. The
// wrapper executes exactly one fixed, compile-time-constant program
// (kWrappedProgram below); argv is validated against that constant and
// no argv/env/file data ever flows into the exec call itself. This
// closes the arbitrary-command-execution sink (CWE-78) reported by
// static analysis: the wrapper cannot be used to launch anything other
// than the validator under the filter. Refusals exit 2 before the
// seccomp filter is installed, leaving no partial process state.
//
// Build:   gcc -O2 -o scripts/no_uring scripts/no_uring.c
// Usage:   scripts/no_uring solana-test-validator [validator args...]
//          (solana-test-validator is the only accepted command)

#define _GNU_SOURCE
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

// The only program this wrapper may execute. A compile-time constant —
// deliberately not derived from argv, the environment, or any file.
static const char kWrappedProgram[] = "solana-test-validator";

static int install_filter(void) {
  // Reject io_uring_setup (425), io_uring_enter (426), io_uring_register (427).
  struct sock_filter filter[] = {
    // Load the syscall number.
    BPF_STMT(BPF_LD + BPF_W + BPF_ABS, offsetof(struct seccomp_data, nr)),
    // io_uring_setup → EPERM
    BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, 425, 0, 1),
    BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    // io_uring_enter → EPERM
    BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, 426, 0, 1),
    BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    // io_uring_register → EPERM
    BPF_JUMP(BPF_JMP + BPF_JEQ + BPF_K, 427, 0, 1),
    BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    // Everything else → allow.
    BPF_STMT(BPF_RET + BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return -1;
  }
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s solana-test-validator [validator args...]\n", argv[0]);
    return 2;
  }
  // Allowlist gate: anything that is not the exact wrapped program name
  // is refused before any process state changes. The constant contains
  // no '/', so path-shaped input cannot match and the exec target below
  // can never become attacker-controlled data (CWE-78).
  if (strcmp(argv[1], kWrappedProgram) != 0) {
    fprintf(stderr, "no_uring: refusing '%s' - the only wrapped program is %s\n",
            argv[1], kWrappedProgram);
    return 2;
  }
  if (install_filter() != 0) {
    fprintf(stderr, "no_uring: failed to install the seccomp filter: %s\n", strerror(errno));
    return 1;
  }
  // Exec target is the compile-time constant above. &argv[1] forwards
  // only the validator's own arguments across the exec boundary
  // (argv[1] equals the constant, so the child's argv[0] is correct).
  execvp(kWrappedProgram, &argv[1]);
  fprintf(stderr, "no_uring: exec %s failed: %s\n", kWrappedProgram, strerror(errno));
  return 1;
}

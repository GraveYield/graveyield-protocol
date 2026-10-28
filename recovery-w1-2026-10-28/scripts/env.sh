#!/usr/bin/env bash
# env.sh — source this in every tool session: toolchain PATH for W1 rebuild.
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
export RUSTUP_TOOLCHAIN=1.91.1

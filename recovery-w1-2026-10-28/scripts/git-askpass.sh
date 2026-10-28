#!/bin/sh
# git-askpass.sh — token-free credential helper (Handoff Vol IV §5.1 runbook).
# Reads GH_TOKEN from the environment AT CALL TIME; never stores or prints it.
case "$1" in
  Username*) echo "x-access-token" ;;
  Password*) printf "%s" "$GH_TOKEN" ;;
  *) echo ;;
esac

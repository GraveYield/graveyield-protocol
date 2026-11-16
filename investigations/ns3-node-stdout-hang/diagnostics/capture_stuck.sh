#!/usr/bin/env bash
# diagnostics/capture_stuck.sh PID — snapshot everything /proc exposes about a
# stuck process we own (no strace needed). Prints a structured report.
PID=$1
p(){ cat "$1" 2>/dev/null || echo "(unavailable: $1)"; }
echo "### cmdline"; p /proc/$PID/cmdline | tr '\0' ' '; echo
echo "### status";   p /proc/$PID/status
echo "### wchan";    p /proc/$PID/wchan
echo "### syscall";  p /proc/$PID/syscall
echo "### stat";     p /proc/$PID/stat
echo "### fds";      ls -l /proc/$PID/fd 2>/dev/null || echo "(fd list unavailable)"
echo "### threads: $(ls /proc/$PID/task 2>/dev/null | wc -l)"
for T in $(ls /proc/$PID/task 2>/dev/null); do
  echo "--- task $T"
  echo "  comm:    $(p /proc/$PID/task/$T/comm)"
  echo "  state:   $(grep -m1 '^State:' /proc/$PID/task/$T/status 2>/dev/null)"
  echo "  wchan:   $(p /proc/$PID/task/$T/wchan)"
  echo "  syscall: $(p /proc/$PID/task/$T/syscall)"
  echo "  kernel_stack:"; sed 's/^/    /' /proc/$PID/task/$T/stack 2>/dev/null || echo "    (unavailable)"
done

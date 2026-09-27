#!/usr/bin/env bash
# leak-scan.sh — refuse to publish anything carrying material that must not leave
# this machine.
#
# WHY A SCANNER SHIPS WITH THE PLUGIN. The portfolio register's publish gate ends
# its command block with a scan line, and that line runs whatever the deployment
# configured as `leakScan`. A neutral scanner lives here so that line is runnable
# by anyone who clones this repository, with their own terms in a file that is
# never committed.
#
# WHAT IT CHECKS
#   1. Files that are secrets by NAME — .env, *.pem, id_rsa, credentials, *.kdbx.
#   2. Every term in the terms file, over the files git TRACKS. Untracked files
#      cannot be published, so scanning them would be permanent noise and would
#      train the reader to ignore the result.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   - It does NOT print the matching line. A scanner that echoes the secret it
#     found into a terminal, a log or a screenshot is a second leak. It prints the
#     term, the file and the line NUMBER — enough to find it, not enough to leak
#     it again.
#   - It does NOT ship a default term list. A neutral list would be wrong for
#     everybody: the terms that matter are particular to your material. The
#     built-in checks are the ones that are true of any repository.
#
#   bash scripts/leak-scan.sh [dir] [--terms FILE]
#
# Terms file: one term per line, `#` starts a comment. Searched as a LITERAL,
# case-insensitively. Resolution order: --terms, then <dir>/.leak-terms, then
# ~/.leak-terms. With none of those, the built-in checks still run and the output
# says so — never a silent pass.
#
# Exit 0 and print `SCAN CLEAN`; 1 with every hit listed and `SCAN FAILED`; 2 for
# a usage or environment refusal.
set -uo pipefail

target="."
terms_arg=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --terms)
      [ "$#" -ge 2 ] || { printf 'leak-scan: --terms needs a file\n' >&2; exit 2; }
      terms_arg="$2"; shift 2 ;;
    --terms=*)
      terms_arg="${1#--terms=}"; shift ;;
    -h|--help)
      sed -n '2,32p' "$0"; exit 0 ;;
    -*)
      printf 'leak-scan: unknown option %s\n' "$1" >&2; exit 2 ;;
    *)
      target="$1"; shift ;;
  esac
done

# A scan without git would have to guess at what is publishable, and guessing is
# how a scanner reports CLEAN on a tree it never read.
if ! root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null); then
  printf 'leak-scan: %s is not inside a git work tree.\n' "$target" >&2
  printf '           A publish decision needs to know which files are TRACKED.\n' >&2
  exit 2
fi

# ---------------------------------------------------------------- terms file
terms=""
for candidate in "$terms_arg" "$root/.leak-terms" "$HOME/.leak-terms"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then terms="$candidate"; break; fi
done

if [ -n "$terms_arg" ] && [ ! -f "$terms_arg" ]; then
  printf 'leak-scan: --terms file not found: %s\n' "$terms_arg" >&2
  exit 2
fi

if [ -n "$terms" ]; then
  # THE ONE GUARD THAT MATTERS MOST: a tracked terms file is a list of everything
  # you must not publish, on its way to being published. Refuse before scanning,
  # because a clean scan of a repo that is about to leak its own term list is the
  # most dangerous possible result.
  case "$terms" in
    "$root"/*)
      rel="${terms#"$root"/}"
      if git -C "$root" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
        printf 'leak-scan: REFUSING — the terms file is TRACKED by git: %s\n' "$rel" >&2
        printf '           That file lists what must not be published. Untrack it and\n' >&2
        printf '           add it to .gitignore (this repository ignores .leak-terms).\n' >&2
        exit 2
      fi ;;
  esac
fi

term_count=0
if [ -n "$terms" ]; then
  term_count=$(grep -c -v -e '^[[:space:]]*$' -e '^[[:space:]]*#' "$terms" 2>/dev/null || true)
  term_count=${term_count:-0}
fi

printf 'leak-scan  %s\n' "$root"
if [ -n "$terms" ]; then
  printf 'terms      %s (%s term(s), searched as literals)\n' "$terms" "$term_count"
else
  printf 'terms      NONE FOUND — built-in checks only. Add .leak-terms to search\n'
  printf '           for the words particular to your material.\n'
fi

hits=0

# ------------------------------------------------------- secrets by file name
# True of any repository, so these need no configuration.
secret_re='(^|/)\.env($|\.)|\.pem$|\.key$|(^|/)id_rsa|(^|/)id_ed25519|(^|/)credentials|\.kdbx$|\.p12$|(^|/)\.netrc$'
while IFS= read -r file; do
  [ -n "$file" ] || continue
  printf 'HIT  secret-shaped file is TRACKED: %s\n' "$file"
  hits=$((hits + 1))
done <<EOF
$(git -C "$root" ls-files | grep -E "$secret_re" || true)
EOF

# --------------------------------------------------------------- the term list
if [ -n "$terms" ] && [ "$term_count" -gt 0 ]; then
  while IFS= read -r term; do
    case "$term" in ''|'#'*) continue ;; esac
    trimmed=$(printf '%s' "$term" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    [ -n "$trimmed" ] || continue
    case "$trimmed" in '#'*) continue ;; esac
    # -I skips binary, -F is a literal, -i is case-insensitive, -n gives the line
    # number. `cut` drops the matching TEXT: finding the leak must not print it.
    found=$(git -C "$root" grep -I -i -n -F -e "$trimmed" -- . 2>/dev/null | cut -d: -f1,2)
    if [ -n "$found" ]; then
      while IFS= read -r where; do
        printf 'HIT  term "%s" in %s\n' "$trimmed" "$where"
        hits=$((hits + 1))
      done <<EOF
$found
EOF
    fi
  done < "$terms"
fi

if [ "$hits" -eq 0 ]; then
  printf 'SCAN CLEAN\n'
  exit 0
fi

printf 'SCAN FAILED — %s hit(s). Nothing gets published until this is clean.\n' "$hits"
exit 1

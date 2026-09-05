set -eu
t=$(mktemp -d)
mkdir -p "$t/bin"
cat > "$t/bin/npm" <<'EOF'
#!/bin/sh
for a in "$@"; do
  case "$a" in
    *@1.0.18) echo "npm error code EACCES" >&2; echo 'npm error permission denied' >&2; exit 1 ;;
  esac
done
echo CALLED_BARE
exit 0
EOF
chmod +x "$t/bin/npm"
export PATH="$t/bin:$PATH"
partial="$t/p"
mkdir -p "$partial"
if ! npm install --prefix "$partial" '@xai-official/grok@1.0.18' 2>"$partial.npm-err"; then
  if grep -qE 'ETARGET|No matching version|is not in this registry' "$partial.npm-err"; then
    echo FALLBACK_TAKEN
    npm install --prefix "$partial" '@xai-official/grok'
  else
    echo WRONG_BRANCH; exit 1
  fi
fi
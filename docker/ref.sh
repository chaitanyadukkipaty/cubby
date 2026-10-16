# Which Cubby code to install or upgrade to. Sourced (not executed) by install.sh and cubby-server;
# unit-tested with fake curl/git in tests/unit/ref-sh.test.js. Needs curl and git.
#
#   cubby_resolve "<version>" "<ref>"   sets CUBBY_TARGET_REF, CUBBY_TARGET_CHANNEL (release|ref), CUBBY_TARGET_NOTE
#   cubby_checkout <dir> <ref>          fetches <ref> (tag, branch or commit) into <dir> and checks it out
#   cubby_build_info <dir>              prints "<short commit> <release tag or empty>" for docker build args
#   cubby_newer <a> <b>                 succeeds when version/tag <a> is newer than <b> (X.Y.Z cores only)
#   cubby_port_holder <port> [<ours>]   prints what listens on host <port> ("" if free); container <ours> doesn't count
#   cubby_free_port <from> <to> [<skip>…] prints the first free port in the range, or fails

CUBBY_REPO="${CUBBY_REPO:-https://github.com/chaitanyadukkipaty/cubby.git}"
CUBBY_RELEASES_API="${CUBBY_RELEASES_API:-https://api.github.com/repos/chaitanyadukkipaty/cubby/releases}"
CUBBY_RELEASES_PAGE="${CUBBY_RELEASES_PAGE:-https://github.com/chaitanyadukkipaty/cubby/releases}"

# Latest published release tag (vX.Y.Z), or nothing if there is none or GitHub can't be reached.
cubby_latest_release() {
  local json
  json="$(curl -fsSL --max-time 10 -H 'Accept: application/vnd.github+json' "$CUBBY_RELEASES_API/latest" 2>/dev/null)" || return 0
  printf '%s\n' "$json" | tr ',' '\n' \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' | head -n 1
}

cubby_release_exists() {
  git ls-remote --exit-code --tags "$CUBBY_REPO" "refs/tags/$1" >/dev/null 2>&1
}

cubby_resolve() {
  local version="${1:-}" ref="${2:-}"
  CUBBY_TARGET_REF=""
  CUBBY_TARGET_CHANNEL=""
  CUBBY_TARGET_NOTE=""
  if [[ -n "$version" && -n "$ref" ]]; then
    echo "Use either --version or --ref, not both." >&2
    return 1
  fi
  if [[ -n "$version" ]]; then
    version="${version#v}"
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "\"$1\" isn't a release version. Use X.Y.Z, for example 0.1.1." >&2
      return 1
    fi
    if ! cubby_release_exists "v$version"; then
      echo "Cubby $version doesn't exist (no v$version release). Releases: $CUBBY_RELEASES_PAGE" >&2
      return 1
    fi
    CUBBY_TARGET_REF="v$version"
    CUBBY_TARGET_CHANNEL=release
    return 0
  fi
  if [[ -n "$ref" ]]; then
    CUBBY_TARGET_REF="$ref"
    CUBBY_TARGET_CHANNEL=ref
    CUBBY_TARGET_NOTE="\"$ref\" is not a release: you get whatever code is on it, without release testing."
    return 0
  fi
  CUBBY_TARGET_CHANNEL=release
  CUBBY_TARGET_REF="$(cubby_latest_release)"
  if [[ -z "$CUBBY_TARGET_REF" ]]; then
    CUBBY_TARGET_REF=main
    CUBBY_TARGET_NOTE="No Cubby release found (or GitHub can't be reached), so installing main instead. The next upgrade moves to the latest release."
  fi
}

cubby_checkout() {
  local dir="$1" ref="$2"
  if [[ ! -d "$dir/.git" ]]; then
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$CUBBY_REPO"
  fi
  git -C "$dir" remote set-url origin "$CUBBY_REPO"
  # Tags are fetched as tags, so the build can tell it's building a release.
  if git -C "$dir" fetch -q --depth 1 origin "+refs/tags/$ref:refs/tags/$ref" 2>/dev/null; then
    git -C "$dir" -c advice.detachedHead=false checkout -q --detach "refs/tags/$ref"
  elif git -C "$dir" fetch -q --depth 1 origin "$ref" 2>/dev/null; then
    git -C "$dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
  else
    echo "Couldn't fetch \"$ref\" from $CUBBY_REPO." >&2
    return 1
  fi
}

cubby_build_info() {
  local commit tag
  commit="$(git -C "$1" rev-parse --short=7 HEAD 2>/dev/null)"
  tag="$(git -C "$1" tag --points-at HEAD --list 'v*' 2>/dev/null | head -n 1)"
  printf '%s %s\n' "$commit" "$tag"
}

# "0.1.2", "v0.1.2" or "0.1.2-dev+abc" → "0.1.2"
cubby_version_core() {
  local v="${1#v}"
  v="${v%%[-+]*}"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s' "$v"
}

cubby_newer() {
  local a b
  a="$(cubby_version_core "$1")" || return 1
  b="$(cubby_version_core "$2")" || return 1
  [[ "$a" != "$b" && "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)" == "$a" ]]
}

# Who holds a host TCP port: a container (by name), a process (from ss), or "another process". Ports published
# by our own container <ours> count as free, since it is replaced on start. Without ss, a connect probe is used.
cubby_port_holder() {
  local port="$1" ours="${2:-}" line name
  [[ -n "$ours" ]] && command -v docker >/dev/null \
    && docker port "$ours" 2>/dev/null | grep -Eq ":${port}\$" && return 0
  if command -v docker >/dev/null; then
    name="$(docker ps --format '{{.Names}}|{{.Ports}}' 2>/dev/null | grep -E ":${port}->" | cut -d'|' -f1 | grep -vx "${ours:-}" | head -n 1 || true)"
    [[ -z "$name" ]] || { printf 'container %s\n' "$name"; return 0; }
  fi
  if command -v ss >/dev/null; then
    line="$(ss -Hltnp "sport = :$port" 2>/dev/null | head -n 1 || true)"
    [[ -n "$line" ]] || return 0
    name="$(printf '%s' "$line" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p')"
    printf '%s\n' "${name:-another process}"
  elif (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "another process"
  fi
}

cubby_free_port() {
  local from="$1" to="$2" p s
  shift 2
  for ((p = from; p <= to; p++)); do
    for s in "$@"; do [[ "$p" == "$s" ]] && continue 2; done
    [[ -z "$(cubby_port_holder "$p")" ]] && { echo "$p"; return 0; }
  done
  return 1
}

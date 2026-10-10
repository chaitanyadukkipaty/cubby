#!/bin/sh
# Installs the Cubby agent skill and adds this server to your Cubby servers:
#   curl -fsSL {{PUBLIC_URL}}/skill.sh | sh
# Same layout as `npx skills`: ~/.agents/skills/cubby, symlinked into each installed agent.
# The skill is the same for every server; running this for a second server just adds that server.
set -eu
SERVER="{{PUBLIC_URL}}"
DEST="$HOME/.agents/skills/cubby"

mkdir -p "$DEST"
curl -fsSL "$SERVER/skill.md" -o "$DEST/SKILL.md.tmp"
mv "$DEST/SKILL.md.tmp" "$DEST/SKILL.md"

linked=""
for root in "$HOME/.claude" "$HOME/.codex" "$HOME/.cursor" "$HOME/.config/opencode"; do
  [ -d "$root" ] || continue
  link="$root/skills/cubby"
  mkdir -p "$root/skills"
  if [ -L "$link" ]; then rm -f "$link"; elif [ -e "$link" ]; then continue; fi
  ln -s "$DEST" "$link"
  linked="$linked $(basename "$root" | sed 's/^\.//; s/^claude$/claude-code/')"
done

# Add this server (name + URL, no token) to ~/.cubby/config.json so agents know it by name.
# Mirrors cli/src/servers.js (config format 1); a newer format is left alone.
added="no"
if command -v node >/dev/null 2>&1; then
  added=$(node - "$SERVER" <<'JS'
const fs = require('fs'), path = require('path'), os = require('os');
const name = {{SERVER_NAME_JSON}};
const url = new URL(process.argv[2]);
const base = `${url.protocol}//${url.host}`.toLowerCase();
const id = url.host.toLowerCase();
const file = path.join(os.homedir(), '.cubby', 'config.json');
let cfg = { format: 1, default: null, servers: {} };
try {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw.format > 1) { console.log('newer'); process.exit(0); }
  if (raw.format === 1) cfg = { format: 1, default: raw.default ?? null, servers: raw.servers ?? {} };
  else if (raw.server) {
    const u = new URL(raw.server);
    const oldId = u.host.toLowerCase();
    cfg.servers[oldId] = { name: null, url: `${u.protocol}//${u.host}`.toLowerCase(), email: raw.email ?? null, token: raw.token ?? null, version: null };
    cfg.default = oldId;
  }
} catch {}
cfg.servers[id] = { name: null, email: null, token: null, version: null, ...cfg.servers[id], name, url: base };
if (!cfg.default || !cfg.servers[cfg.default]) cfg.default = id;
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
fs.renameSync(tmp, file);
console.log('yes');
JS
) || added="no"
fi

echo "Installed the cubby skill for $SERVER"
if [ -n "$linked" ]; then echo "  agents:$linked"; else echo "  no agents found; skill is in $DEST"; fi
case "$added" in
  yes) echo "  added this server to ~/.cubby/config.json" ;;
  newer) echo "  ~/.cubby/config.json was written by a newer Cubby CLI; your agent will add this server when it logs in" ;;
  *) echo "  Node.js 20+ not found; your agent will add this server when it first logs in" ;;
esac
echo
echo "Now open your coding agent and ask it to build something, e.g.:"
echo "  \"Build me a polls app for my friends and host it on Cubby\""

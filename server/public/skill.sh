#!/bin/sh
# Installs the Cubby agent skill for this server: curl -fsSL {{PUBLIC_URL}}/skill.sh | sh
# Same layout as `npx skills`: ~/.agents/skills/cubby, symlinked into each installed agent.
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

echo "Installed the cubby skill for $SERVER"
if [ -n "$linked" ]; then echo "  agents:$linked"; else echo "  no agents found; skill is in $DEST"; fi
echo
echo "Now open your coding agent and ask it to build something, e.g.:"
echo "  \"Build me a polls app for my friends and host it on Cubby\""

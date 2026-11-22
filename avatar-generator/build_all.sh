#!/usr/bin/env bash
# Full pipeline: fetch → build both characters → export GLBs → compress (game) → validate →
# preview renders → browser test → contact sheets. CPU / integrated GPU only; about 2 minutes
# on an 8-core Intel N355 with integrated graphics.
#   ./build_all.sh            everything
#   ./build_all.sh --no-test  skip the browser test
#   PREVIEW_SIZE=1080 ./build_all.sh  preview render height (default 720 px; a 240 px check pass runs first)
set -euo pipefail
cd "$(dirname "$0")"
export BLENDER_USER_RESOURCES="$PWD/assets/blender-user"
BLENDER=(blender --background --python-use-system-env)
FRONTEND="$PWD/../frontend"
GT="$FRONTEND/node_modules/.bin/gltf-transform"
SIZE="${PREVIEW_SIZE:-720}"

python3 scripts/fetch_assets.py

for c in male female; do
	echo "── build $c"
	"${BLENDER[@]}" --python "scripts/generate_$c.py" 2>&1 | grep -E '^\[avatar\]|Error|Traceback' || true
	test -f "output/${c}_avatar.blend"
	echo "── export $c"
	"${BLENDER[@]}" "output/${c}_avatar.blend" --python scripts/export_glb.py 2>&1 | grep -E '^\[avatar\]|Error|Traceback' || true
	test -f "output/${c}_avatar.glb" && test -f "output/${c}_avatar_game.glb"
done
rm -f output/*.blend1

if [ -x "$GT" ]; then
	for c in male female; do
		echo "── meshopt-compress ${c}_avatar_game.glb"
		"$GT" meshopt "output/${c}_avatar_game.glb" "output/${c}_avatar_game.tmp.glb" >/dev/null
		mv "output/${c}_avatar_game.tmp.glb" "output/${c}_avatar_game.glb"
	done
	for f in output/*.glb; do
		printf '── validate %s: ' "$f"
		"$GT" validate "$f" 2>&1 | grep -E 'errors found|error' | head -1
	done
else
	echo "gltf-transform not found (run npm install in frontend/); skipping compression and validation"
fi

# Copy the game-quality avatars into the web game (frontend/static/models/characters/realistic).
python3 scripts/install_to_game.py

# Low-resolution check renders first (fast), then the final previews.
for c in male female; do
	echo "── previews $c (low-res 240px check, then ${SIZE}px)"
	"${BLENDER[@]}" "output/${c}_avatar.blend" --python scripts/render_previews.py -- \
		--out "previews/_tmp/${c}" --size 240 --views front,face 2>&1 | grep -E 'PREVIEW|Error' || true
	"${BLENDER[@]}" "output/${c}_avatar.blend" --python scripts/render_previews.py -- \
		--out "previews/${c}" --size "$SIZE" --views front,34,side,back,face 2>&1 | grep -E 'PREVIEW|Error' || true
done

if [ "${1:-}" != "--no-test" ]; then
	echo "── browser test"
	node viewer/test_viewer.mjs
fi
python3 scripts/make_sheets.py
ls -la output

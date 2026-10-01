#!/usr/bin/env bash
# Replaces private role/registry joins with the released initialized-seat contract.
set -Eeuo pipefail
# shellcheck source=test-lib.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/test-lib.sh"

for role in cts tpm executor lead worker owner; do
  address="$role.standalone@$HOST"
  initialize "$address" Standalone
  jq -e --arg address "$address" '.supervisor==$address and .owns==[] and .runtime=="unbound"' \
    "$STATE/$address/seat.json" >/dev/null
done
for flag in --supervisor --machine-id --owns --runtime; do
  snapshot >"$WORK/before"
  invoke init --as "lead.refused@$HOST" --name Refused "$flag" private-value
  expect_rc 64
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
done
pass 'every role initializes without private hierarchy; private initialization flags refuse without writes'

participants
id="ownership-$$@$HOST"
card "$id" "$SENDER" "$RECEIVER" question ownership >"$WORK/card"
invoke send --as "$SENDER" --no-ring <"$WORK/card"; expect_rc 0
original="$(message_path "$RECEIVER" "$id")"
ln -s "$original" "$STATE/$OTHER/new/foreign-link"
for candidate in "$original" "$STATE/$OTHER/new/../../$RECEIVER/new/$(basename "$original")" "$STATE/$OTHER/new/foreign-link"; do
  snapshot >"$WORK/before"
  invoke reply --as "$OTHER" --card "$candidate" --state accepted <<<'foreign reply'
  [[ "$RC" != 0 ]] || fail 'another seat accepted a foreign card'
  snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
done
rm "$STATE/$OTHER/new/foreign-link"
snapshot >"$WORK/before"
invoke dismiss --as "$RECEIVER" --card "$original" --reason 'not a work reply'
[[ "$RC" != 0 ]] || fail 'dismiss consumed actionable work'
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
pass 'caller-owned card boundary rejects foreign paths, traversal, symlinks and work dismissal without mutation'

identity="$STATE/$RECEIVER/seat.json"
mv "$identity" "$WORK/saved-seat.json"
snapshot >"$WORK/before"
invoke inbox --as "$RECEIVER"
[[ "$RC" != 0 ]] || fail 'missing local identity became empty read success'
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
mv "$WORK/saved-seat.json" "$identity"
cp "$identity" "$WORK/saved-seat.json"
machine="$(jq -r .machine_id "$identity")"
wrong=00000000000000000000000000000000
[[ "$machine" != "$wrong" ]] || wrong=11111111111111111111111111111111
jq --arg machine "$wrong" '.machine_id=$machine' "$identity" >"$WORK/wrong-seat.json"
cp "$WORK/wrong-seat.json" "$identity"
snapshot >"$WORK/before"
invoke inbox --as "$RECEIVER"
[[ "$RC" != 0 ]] || fail 'foreign machine identity was accepted'
snapshot >"$WORK/after"; cmp "$WORK/before" "$WORK/after"
cp "$WORK/saved-seat.json" "$identity"
invoke inbox --as "$RECEIVER"; expect_rc 0; has "$WORK/out" "$original"
pass 'missing or foreign machine identity fails loudly; restoring identity restores the same actionable card'

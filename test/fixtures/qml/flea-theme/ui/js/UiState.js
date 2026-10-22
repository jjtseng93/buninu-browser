.pragma library

// ui/ViewState.qml's one-writer bookkeeping: saved/inflight/pending are patch bytes, pinned by tests/js/uistate.js.

// The window's own read of ui.json: an unreadable document stays as written and says so, while no file at all is a first launch.
function fromFile(text) {
    try {
        var found = JSON.parse(text)
        if (found && typeof found === "object" && !Array.isArray(found)) {
            return { state: found, unreadable: false }
        }
    } catch (e) {
        // A hand edit this cannot parse, which is the ordinary way in and is not an error here.
    }
    return { state: {}, unreadable: text.length > 0 }
}

// The one sentence for a ui.json that could not be read when favorites were refreshed, said by this module and by ViewState.
var FAVOURITES_UNREAD = "Favorites could not be refreshed because ui.json could not be read. The old list stays."

// External favourites update independently of this window's settings drafts and pending patches.
function refreshedFavourites(state, text) {
    var read = fromFile(text)
    var places = read.state.places
    if (text.length === 0 || read.unreadable || (places !== undefined && (!places || typeof places !== "object" || Array.isArray(places)))
            || (places && places.favourites !== undefined && !Array.isArray(places.favourites)))
        return { state: state, error: FAVOURITES_UNREAD }
    var records = places && places.favourites || []
    if (JSON.stringify((state.places || {}).favourites || []) === JSON.stringify(records))
        return { state: state, error: "" }
    return { state: withGroup(state, "places", { favourites: records }), error: "" }
}

// Compare a save with this window's intent, because the writer response can include concurrent edits.
function favouritesAfter(records, operation) {
    var next = records.slice()
    if (operation.op === "add") next.push(operation.record)
    else if (operation.op === "remove") next.splice(operation.index, 1)
    else if (operation.op === "move") next.splice(operation.to, 0, next.splice(operation.index, 1)[0])
    else if (operation.op === "rename") next[operation.index] = Object.assign({}, next[operation.index], { label: operation.label })
    return next
}

// Per-window keys name where a window is rather than how Flea behaves, so no window ever takes them from the file.
var WINDOW_KEYS = ["view", "pickerView", "columnWidths", "dual", "lastPath", "lastTabs",
                   "trashSweptOn", "stateVersion", "sort", "previewFacts"]

function isWindowKey(key) {
    return WINDOW_KEYS.indexOf(key) >= 0
}

// Per-window leaves stay per window like the sidebar: a change still writes the file, but open windows keep their own.
var WINDOW_LEAF_KEYS = ["places.rail", "preview.column", "preview.thumbSize"]

function isWindowLeaf(key, leaf) {
    return WINDOW_LEAF_KEYS.indexOf(key + "." + leaf) >= 0
}

// Sample patch: {"columns":["name","bogus"]} is refused whole while {"columns":["name","size"]} retries; only schema-invalid shapes prune.
function isPatchInvalid(patchText) {
    return invalidKeys(patchText).length > 0
}

// Sample patch: {"columns":["name","bogus"],"density":"normal"} refuses ["columns"] alone, so a valid key beside it is never pruned.
function invalidKeys(patchText) {
    var refused = []
    var patch = null
    try {
        patch = JSON.parse(patchText)
    } catch (e) {
        return refused
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
        return refused
    if (patch.columns !== undefined) {
        var cols = patch.columns
        var bad = !Array.isArray(cols) || cols.indexOf("name") < 0
        if (!bad) {
            var seen = {}
            var keys = ["name", "mode", "size", "date", "kind"]
            for (var i = 0; i < cols.length; i++) {
                if (keys.indexOf(cols[i]) < 0 || seen[cols[i]]) { bad = true; break }
            }
        }
        if (bad)
            refused.push("columns")
    }
    if (patch.places !== undefined && (patch.places === null || typeof patch.places !== "object" || Array.isArray(patch.places)))
        refused.push("places")
    return refused
}

// True when text parses as a JSON object; empty or garbage is ignored until the next valid write.
function parsesAsObject(text) {
    try {
        var found = JSON.parse(text)
        return found && typeof found === "object" && !Array.isArray(found)
    } catch (e) {
        return false
    }
}

// A settler's exit and its collected text land in either order, so only a whole answer is ever read.
function landed(answer, half) {
    return Object.assign({}, answer, half)
}

// An empty text is an answer too: a run that says nothing has still finished saying it.
function whole(answer) {
    return answer.code !== undefined && answer.text !== undefined
}

// The whole answer a settler that never started is given: no real exit status is negative.
var NEVER_RAN = { code: -1, text: "" }

// A settler that cannot start raises no exited, only running going false, and a real exit lands its status before that false.
function neverRan(answer, running) {
    return !running && answer.code === undefined
}

// A refused write queues its prune behind a running settle instead of hijacking that settle's mode.
function pruneAsk(running, failedPatch) {
    return running ? { queue: failedPatch, start: "" } : { queue: "", start: failedPatch }
}

// A settle stays pending until both halves land, so one half landed still counts as running.
function settleBusy(running, mode, answer) {
    return running || (mode.length > 0 && !whole(answer))
}

// A settle's end spends a queued prune before a dirty re-read, keeping the dirty flag across the prune so the re-read still runs after it.
function settleNext(dirty, pruneQueued) {
    if (pruneQueued.length > 0)
        return "prune"
    if (dirty)
        return "apply"
    return "idle"
}

// Drops only refused keys a retry can never land, keeping a valid key and a newer owed value the refused writer never carried.
function dropInvalid(unsaved, inflightText) {
    var refused = invalidKeys(inflightText)
    if (refused.length === 0)
        return unsaved
    var inflight = JSON.parse(inflightText)
    var out = {}
    for (var k in unsaved)
        out[k] = unsaved[k]
    for (var r = 0; r < refused.length; r++) {
        var key = refused[r]
        if (out[key] === undefined)
            continue
        if (isGroup(out[key]) && isGroup(inflight[key])) {
            var kept = {}
            var any = false
            for (var leaf in out[key]) {
                if (inflight[key][leaf] !== undefined
                        && JSON.stringify(out[key][leaf]) === JSON.stringify(inflight[key][leaf]))
                    continue
                kept[leaf] = out[key][leaf]
                any = true
            }
            if (any)
                out[key] = kept
            else
                delete out[key]
        } else if (JSON.stringify(out[key]) === JSON.stringify(inflight[key])) {
            delete out[key]
        }
    }
    return out
}

// Reverts only refused keys still showing the refused value, so a newer change made behind the refused writer survives.
function revertedState(state, inflightText, settled) {
    var refused = invalidKeys(inflightText)
    if (refused.length === 0)
        return state
    var inflight = null
    try {
        inflight = JSON.parse(inflightText)
    } catch (e) {
        return state
    }
    if (!inflight || typeof inflight !== "object" || !settled)
        return state
    var out = {}
    for (var s in state)
        out[s] = state[s]
    for (var r = 0; r < refused.length; r++) {
        var key = refused[r]
        if (settled[key] === undefined || inflight[key] === undefined)
            continue
        if (isGroup(inflight[key]) && isGroup(settled[key]) && isGroup(out[key])) {
            var group = {}
            for (var h in out[key])
                group[h] = out[key][h]
            for (var leaf in inflight[key]) {
                if (JSON.stringify(group[leaf]) !== JSON.stringify(inflight[key][leaf]))
                    continue
                if (settled[key][leaf] !== undefined)
                    group[leaf] = settled[key][leaf]
                else
                    delete group[leaf]
            }
            out[key] = group
        } else if (JSON.stringify(out[key]) === JSON.stringify(inflight[key])) {
            out[key] = settled[key]
        }
    }
    return out
}

// A change another window saved: preference keys the file names and this window does not owe take the file's value, never clobbering owed leaves or in-flight writes.
function applyExternal(state, unsaved, text) {
    var read = fromFile(text)
    if (read.unreadable)
        return { state: state, changed: false }
    var file = read.state
    var out = {}
    for (var s in state)
        out[s] = state[s]
    var changed = false
    for (var key in file) {
        if (isWindowKey(key))
            continue
        var value = file[key]
        if (key === "places" && isGroup(value)) {
            var merged = {}
            for (var f in value) {
                if (f !== "favourites")
                    merged[f] = value[f]
            }
            var held = state.places || {}
            if (held.favourites !== undefined)
                merged.favourites = held.favourites
            var owedPlaces = unsaved ? unsaved.places : undefined
            if (isGroup(owedPlaces)) {
                for (var leaf in owedPlaces) {
                    if (leaf === "favourites")
                        continue
                    if (held[leaf] !== undefined)
                        merged[leaf] = held[leaf]
                    else
                        delete merged[leaf]
                }
            }
            if (held.rail !== undefined)
                merged.rail = held.rail
            if (JSON.stringify(merged) !== JSON.stringify(state.places)) {
                out.places = merged
                changed = true
            }
            continue
        }
        var owed = unsaved ? unsaved[key] : undefined
        if (owed !== undefined) {
            if (isGroup(owed) && isGroup(value) && !isWholeKey(key)) {
                var group = {}
                for (var g in value)
                    group[g] = value[g]
                var current = state[key] || {}
                for (var o in owed) {
                    if (current[o] !== undefined)
                        group[o] = current[o]
                    else
                        delete group[o]
                }
                for (var w in group) {
                    if (isWindowLeaf(key, w)) {
                        if (current[w] !== undefined)
                            group[w] = current[w]
                        else
                            delete group[w]
                    }
                }
                if (JSON.stringify(group) !== JSON.stringify(state[key])) {
                    out[key] = group
                    changed = true
                }
            }
            continue
        }
        if (isGroup(value) && isGroup(state[key])) {
            var anyLeafWindow = false
            for (var vl in value) {
                if (isWindowLeaf(key, vl)) {
                    anyLeafWindow = true
                    break
                }
            }
            if (anyLeafWindow) {
                var leafGroup = {}
                for (var vg in value) {
                    if (!isWindowLeaf(key, vg))
                        leafGroup[vg] = value[vg]
                }
                var heldGroup = state[key] || {}
                for (var hg in heldGroup) {
                    if (isWindowLeaf(key, hg))
                        leafGroup[hg] = heldGroup[hg]
                }
                if (JSON.stringify(leafGroup) !== JSON.stringify(state[key])) {
                    out[key] = leafGroup
                    changed = true
                }
                continue
            }
        }
        if (JSON.stringify(value) !== JSON.stringify(state[key])) {
            out[key] = value
            changed = true
        }
    }
    return { state: changed ? out : state, changed: changed }
}

// A copy of the document with one top-level key replaced, and the nested version of the same. QML
// notifies on assignment and not on a mutation, so every writer rebuilds rather than reaching in;
// the nested one merges into the group beside it, because a whole-group assignment would take the
// half a writer holds as the whole of it. ui/ViewState.qml runs both over two documents at once:
// the state it draws from, and the patch it owes the state file.
function withKey(state, key, value) {
    var out = {}
    for (var s in state)
        out[s] = state[s]
    out[key] = value
    return out
}

function withGroup(state, key, next) {
    var group = {}
    var held = state[key] || {}
    for (var h in held)
        group[h] = held[h]
    for (var n in next)
        group[n] = next[n]
    return withKey(state, key, group)
}

// The book a window starts with: nothing of its own written yet, and no writer running. Its own read
// of the file is not a patch it sent, so `saved` starts empty rather than holding what it read.
function book() {
    return { saved: "", inflight: "", pending: "" }
}

// A change asks for a write. The answer is the next book plus `start`, the patch to launch now.
function asked(b, patch) {
    // The newest patch this window has landed or has on its way, so asking for exactly those bytes
    // again sends nothing and a refused one is never short-circuited.
    if (patch === (b.pending || b.inflight || b.saved)) {
        return { saved: b.saved, inflight: b.inflight, pending: b.pending, start: "" }
    }
    // One writer at a time, and the newest patch waits rather than being dropped on the floor.
    if (b.inflight.length > 0) {
        return { saved: b.saved, inflight: b.inflight, pending: patch, start: "" }
    }
    return { saved: b.saved, inflight: patch, pending: "", start: patch }
}

// The writer exited. The answer is the next book plus `start`, and `failed` for the pane to report.
// `owed` is what the window still owes NOW and is what a queued writer launches with, because the
// bytes waiting in `pending` were built before this writer landed: they still name the settings it
// just stored, and re-sending one writes this window's own copy of it over whatever another window
// or the CLI put there in between. A refusal changes nothing, so there `owed` is those same bytes.
function exited(b, code, owed) {
    // Nothing waiting, or nothing left owed once this writer's own settings came out of it, which a
    // value changed and changed back under one writer produces: an empty patch is a process and a
    // rename spent on a document that would come out byte for byte the same.
    var next = (b.pending.length > 0 && owed !== "{}") ? owed : ""
    return {
        // Only a zero status proves the patch reached the file: src/main.rs exits 2 on a refused
        // patch and on a state directory it could not write, and the change is on screen either way.
        saved: code === 0 ? b.inflight : b.saved,
        inflight: next,
        pending: "",
        start: next,
        failed: code !== 0
    }
}

// What is still owed once the patch a writer landed is taken out of it. A setting is only cleared
// when what the window owes for it now is what that writer carried: a change made while the writer
// ran is a newer value for the same setting, and the file does not have that one yet.
function acknowledged(unsaved, patch) {
    var landed
    try {
        landed = JSON.parse(patch)
    } catch (e) {
        // Bytes this file built itself, so a parse failure clears nothing rather than clearing wrong.
        return unsaved
    }
    if (!landed || typeof landed !== "object" || Array.isArray(landed))
        return unsaved
    var out = {}
    for (var key in unsaved) {
        var still = stillOwed(unsaved[key], landed[key], key)
        if (still !== undefined)
            out[key] = still
    }
    return out
}

// One key of the owed patch against the same key of the landed one: `undefined` when the writer took
// all of it, and otherwise what is left. Two objects are a settings group and are walked leaf by
// leaf, because changeLeaf owes the leaf alone and clearing the group would drop a leaf beside it
// that no writer has taken yet. A map (changeMapEntries) owes entry by entry, which is the same
// walk. A whole-value object key below is the exception: it is compared and cleared whole, because
// src/uischema.rs Rule::LastTabs stands or falls together and a half value is refused whole.
function stillOwed(owed, landed, key) {
    if (landed === undefined)
        return owed
    if (isWholeKey(key) && isGroup(owed) && isGroup(landed))
        return JSON.stringify(owed) === JSON.stringify(landed) ? undefined : owed
    if (isGroup(owed) && isGroup(landed)) {
        var kept = {}
        var any = false
        for (var leaf in owed) {
            if (JSON.stringify(owed[leaf]) === JSON.stringify(landed[leaf]))
                continue
            kept[leaf] = owed[leaf]
            any = true
        }
        return any ? kept : undefined
    }
    return JSON.stringify(owed) === JSON.stringify(landed) ? undefined : owed
}

// A settings group, which is the only shape withGroup builds: an array is a whole key's value.
function isGroup(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Whole-value object keys: owed and cleared whole, never leaf by leaf. Today only lastTabs, whose
// src/uischema.rs Rule::LastTabs takes exactly paths plus index together.
function isWholeKey(key) {
    return key === "lastTabs"
}

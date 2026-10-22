.pragma library

// The largest length an ECMAScript array can hold, 2^32 - 1.
var MAX_LENGTH = 4294967295

// QVariant sequences crossing a QML var signal expose list methods without being JavaScript Arrays.
function isList(value) {
    return Array.isArray(value) || (value !== null && typeof value === "object"
        && Number.isInteger(value.length) && value.length >= 0 && value.length <= MAX_LENGTH
        && typeof value.every === "function")
}

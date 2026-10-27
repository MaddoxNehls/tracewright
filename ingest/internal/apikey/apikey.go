// Package apikey generates, recognizes, and hashes Tracewright API keys.
// Keys look like tw_<32 lowercase hex>; only their SHA-256 is ever stored.
package apikey

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
)

const (
	keyPrefix = "tw_"
	hexLen    = 32
	// DisplayPrefixLen is how much of a key is stored in clear so humans can
	// tell keys apart in a UI ("tw_1a2b3c4d…") without it being usable.
	DisplayPrefixLen = len(keyPrefix) + 8
)

// Generate returns a new random key.
func Generate() string {
	b := make([]byte, hexLen/2)
	rand.Read(b) // crypto/rand.Read never returns an error since Go 1.24
	return keyPrefix + hex.EncodeToString(b)
}

// Valid reports whether s has the shape of a key, letting callers reject junk
// without touching the database.
func Valid(s string) bool {
	if len(s) != len(keyPrefix)+hexLen || s[:len(keyPrefix)] != keyPrefix {
		return false
	}
	for _, c := range s[len(keyPrefix):] {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

// Hash returns the SHA-256 digest stored in api_keys.key_hash. A fast hash is
// appropriate here because keys carry 128 bits of entropy; there is nothing to
// brute-force the way there is with passwords.
func Hash(key string) [32]byte { return sha256.Sum256([]byte(key)) }

// DisplayPrefix returns the non-secret leading part of a key.
func DisplayPrefix(key string) string { return key[:DisplayPrefixLen] }

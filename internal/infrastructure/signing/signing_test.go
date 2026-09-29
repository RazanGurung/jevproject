package signing

import (
	"crypto/ecdsa"
	"encoding/hex"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// A well-known go-ethereum test key and a 32-byte (64 hex char) hash.
const (
	testPrivHex = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
	testHashHex = "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8"
)

func mustKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	key, err := crypto.HexToECDSA(testPrivHex)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}
	return key
}

func TestSignHashProducesCanonicalRecoverableSignature(t *testing.T) {
	key, err := crypto.HexToECDSA(testPrivHex)
	if err != nil {
		t.Fatalf("HexToECDSA: %v", err)
	}

	sig, err := SignHash(testHashHex, key)
	if err != nil {
		t.Fatalf("SignHash: %v", err)
	}

	// R and S are 0x-prefixed 32-byte (64 hex char) values.
	if len(sig.R) != 66 || sig.R[:2] != "0x" {
		t.Fatalf("R not a 0x-prefixed 32-byte hex string: %q", sig.R)
	}
	if len(sig.S) != 66 || sig.S[:2] != "0x" {
		t.Fatalf("S not a 0x-prefixed 32-byte hex string: %q", sig.S)
	}
	// Ethereum recovery id is normalized to 27 or 28.
	if sig.V != 27 && sig.V != 28 {
		t.Fatalf("V must be 27 or 28, got %d", sig.V)
	}

	// The signature must recover to the signing address — the core correctness
	// property of the signing path.
	r := common.FromHex(sig.R)
	s := common.FromHex(sig.S)
	raw := make([]byte, 65)
	copy(raw[0:32], r)
	copy(raw[32:64], s)
	raw[64] = byte(sig.V - 27)

	hashBytes, err := hex.DecodeString(testHashHex)
	if err != nil {
		t.Fatalf("decode hash: %v", err)
	}
	pub, err := crypto.SigToPub(hashBytes, raw)
	if err != nil {
		t.Fatalf("SigToPub: %v", err)
	}
	recovered := crypto.PubkeyToAddress(*pub)
	expected := crypto.PubkeyToAddress(key.PublicKey)
	if recovered != expected {
		t.Fatalf("recovered signer %s != expected %s", recovered.Hex(), expected.Hex())
	}
}

func TestSignHashIsDeterministic(t *testing.T) {
	key := mustKey(t)

	first, err := SignHash(testHashHex, key)
	if err != nil {
		t.Fatalf("first SignHash: %v", err)
	}
	second, err := SignHash(testHashHex, key)
	if err != nil {
		t.Fatalf("second SignHash: %v", err)
	}

	// go-ethereum uses deterministic ECDSA (RFC 6979); identical inputs must
	// yield identical signatures.
	if *first != *second {
		t.Fatalf("signatures differ across calls: %+v vs %+v", first, second)
	}
}

func TestSignHashTolerates0xPrefix(t *testing.T) {
	key := mustKey(t)

	withPrefix, err := SignHash("0x"+testHashHex, key)
	if err != nil {
		t.Fatalf("SignHash with 0x: %v", err)
	}
	withoutPrefix, err := SignHash(testHashHex, key)
	if err != nil {
		t.Fatalf("SignHash without 0x: %v", err)
	}
	if *withPrefix != *withoutPrefix {
		t.Fatalf("0x prefix changed the signature: %+v vs %+v", withPrefix, withoutPrefix)
	}
}

func TestSignHashRejectsInvalidHex(t *testing.T) {
	key := mustKey(t)

	if _, err := SignHash("not-hex", key); err == nil {
		t.Fatal("expected error for non-hex hash, got nil")
	}
}

func TestSignHashRejectsWrongLengthHash(t *testing.T) {
	key := mustKey(t)

	// crypto.Sign requires exactly a 32-byte digest; a 4-byte input must fail.
	if _, err := SignHash("deadbeef", key); err == nil {
		t.Fatal("expected error for non-32-byte hash, got nil")
	}
}

func TestSignAndBuildPayloadStructure(t *testing.T) {
	key := mustKey(t)

	action := map[string]interface{}{"type": "order"}
	payload, err := SignAndBuildPayload(testHashHex, 1700000000123, action, key, "0xabc")
	if err != nil {
		t.Fatalf("SignAndBuildPayload: %v", err)
	}

	if payload["nonce"] != int64(1700000000123) {
		t.Fatalf("nonce not preserved: %v", payload["nonce"])
	}
	if payload["address"] != "0xabc" {
		t.Fatalf("address not preserved: %v", payload["address"])
	}
	if payload["action"] == nil {
		t.Fatal("action missing from payload")
	}
	sig, ok := payload["signature"].(map[string]interface{})
	if !ok {
		t.Fatalf("signature is not a map: %T", payload["signature"])
	}
	for _, field := range []string{"r", "s", "v"} {
		if _, present := sig[field]; !present {
			t.Fatalf("signature missing %q field", field)
		}
	}
	if r, _ := sig["r"].(string); len(r) < 2 || r[:2] != "0x" {
		t.Fatalf("signature.r not 0x-prefixed: %v", sig["r"])
	}
}

func TestStrip0x(t *testing.T) {
	cases := []struct{ in, want string }{
		{"0xabc", "abc"},
		{"abc", "abc"},
		{"", ""},
		{"0x", ""},
		{"0X12", "0X12"}, // only lowercase 0x is stripped
	}
	for _, tc := range cases {
		if got := Strip0x(tc.in); got != tc.want {
			t.Fatalf("Strip0x(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

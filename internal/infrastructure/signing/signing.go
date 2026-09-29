package signing

import (
	"crypto/ecdsa"
	"encoding/hex"
	"fmt"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
)

// Signature represents an ECDSA signature in R, S, V components.
type Signature struct {
	R string
	S string
	V int
}

// SignHash signs a hex-encoded hash string and returns the signature components.
func SignHash(hashVal string, key *ecdsa.PrivateKey) (*Signature, error) {
	hashBytes, err := hex.DecodeString(Strip0x(hashVal))
	if err != nil {
		return nil, fmt.Errorf("failed to decode hash: %w", err)
	}

	sigBytes, err := crypto.Sign(hashBytes, key)
	if err != nil {
		return nil, fmt.Errorf("failed to sign: %w", err)
	}

	sigHex := hexutil.Encode(sigBytes)
	return &Signature{
		R: fmt.Sprintf("0x%s", sigHex[2:66]),
		S: fmt.Sprintf("0x%s", sigHex[66:130]),
		V: int(sigBytes[64]) + 27,
	}, nil
}

// SignAndBuildPayload creates a signed payload ready for API submission.
func SignAndBuildPayload(hashVal string, nonce int64, action interface{}, key *ecdsa.PrivateKey, address string) (map[string]interface{}, error) {
	sig, err := SignHash(hashVal, key)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"action":    action,
		"nonce":     nonce,
		"signature": map[string]interface{}{"r": sig.R, "s": sig.S, "v": sig.V},
		"address":   address,
	}, nil
}

// Strip0x removes the "0x" prefix from a hex string if present.
func Strip0x(s string) string {
	if len(s) >= 2 && s[:2] == "0x" {
		return s[2:]
	}
	return s
}

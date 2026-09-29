// Package signing: Hyperliquid L1-action and user-signed-action signing.
//
// This file is a first-party fork of the signing core from
// github.com/sonirico/go-hyperliquid v0.36.0 (MIT License, Copyright (c) 2025
// Marquitos), adopted when the SDK dependency was removed. The byte-level
// behavior is pinned by golden tests in l1action_test.go: the msgpack action
// hash (insertion-ordered fields, compact ints, str16→str8 normalization to
// match Python msgpack), the phantom-agent EIP-712 envelope (chainId 1337,
// domain "Exchange"), and the user-signed EIP-712 domain
// ("HyperliquidSignTransaction", chainId 0x66eee). Do not "clean up" encoding
// details here without re-verifying signatures against the exchange.
package signing

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
	"github.com/vmihailenco/msgpack/v5"
)

// SignatureResult is the r/s/v signature envelope Hyperliquid expects in
// signed /exchange payloads.
type SignatureResult struct {
	R string `json:"r"`
	S string `json:"s"`
	V int    `json:"v"`
}

func addressToBytes(address string) []byte {
	address = strings.TrimPrefix(address, "0x")
	decoded, _ := hex.DecodeString(address)
	return decoded
}

// convertStr16ToStr8 converts msgpack str16 (0xda + 2 byte length) to str8
// (0xd9 + 1 byte length) for strings <256 bytes to match Python msgpack
// behavior. Uses a structure-aware msgpack walker to avoid corrupting
// non-string data that happens to contain 0xda as a data byte (e.g. inside
// uint64 values).
func convertStr16ToStr8(data []byte) []byte {
	result := make([]byte, 0, len(data))
	pos := 0
	for pos < len(data) {
		consumed := walkMsgpackValue(data, pos, &result)
		if consumed <= 0 {
			// Malformed data: copy remaining bytes as-is (fail-safe)
			result = append(result, data[pos:]...)
			break
		}
		pos += consumed
	}
	return result
}

// walkMsgpackValue parses one msgpack value at data[pos], appends the
// (possibly converted) bytes to *result, and returns the number of bytes
// consumed from data. Returns 0 if the data is truncated/malformed.
func walkMsgpackValue(data []byte, pos int, result *[]byte) int {
	if pos >= len(data) {
		return 0
	}
	b := data[pos]
	remaining := len(data) - pos

	// --- Fixed-length single-byte types ---
	// positive fixint 0x00-0x7f, negative fixint 0xe0-0xff, nil 0xc0, never used 0xc1, bool 0xc2-0xc3
	if b <= 0x7f || b >= 0xe0 || (b >= 0xc0 && b <= 0xc3) {
		*result = append(*result, b)
		return 1
	}

	// --- fixstr (0xa0-0xbf): 1 header + N data bytes ---
	if b >= 0xa0 && b <= 0xbf {
		n := int(b & 0x1f)
		total := 1 + n
		if remaining < total {
			return 0
		}
		*result = append(*result, data[pos:pos+total]...)
		return total
	}

	// --- fixmap (0x80-0x8f): N key-value pairs ---
	if b >= 0x80 && b <= 0x8f {
		count := int(b & 0x0f)
		*result = append(*result, b)
		consumed := 1
		for i := 0; i < count*2; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed
	}

	// --- fixarray (0x90-0x9f): N elements ---
	if b >= 0x90 && b <= 0x9f {
		count := int(b & 0x0f)
		*result = append(*result, b)
		consumed := 1
		for i := 0; i < count; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed
	}

	switch b {
	// --- float32, float64 ---
	case 0xca: // float32: 1+4
		return copyFixed(data, pos, 5, result)
	case 0xcb: // float64: 1+8
		return copyFixed(data, pos, 9, result)

	// --- unsigned integers ---
	case 0xcc: // uint8: 1+1
		return copyFixed(data, pos, 2, result)
	case 0xcd: // uint16: 1+2
		return copyFixed(data, pos, 3, result)
	case 0xce: // uint32: 1+4
		return copyFixed(data, pos, 5, result)
	case 0xcf: // uint64: 1+8
		return copyFixed(data, pos, 9, result)

	// --- signed integers ---
	case 0xd0: // int8: 1+1
		return copyFixed(data, pos, 2, result)
	case 0xd1: // int16: 1+2
		return copyFixed(data, pos, 3, result)
	case 0xd2: // int32: 1+4
		return copyFixed(data, pos, 5, result)
	case 0xd3: // int64: 1+8
		return copyFixed(data, pos, 9, result)

	// --- fixext 1/2/4/8/16 ---
	case 0xd4: // fixext1: 1+1+1
		return copyFixed(data, pos, 3, result)
	case 0xd5: // fixext2: 1+1+2
		return copyFixed(data, pos, 4, result)
	case 0xd6: // fixext4: 1+1+4
		return copyFixed(data, pos, 6, result)
	case 0xd7: // fixext8: 1+1+8
		return copyFixed(data, pos, 10, result)
	case 0xd8: // fixext16: 1+1+16
		return copyFixed(data, pos, 18, result)

	// --- bin 8/16/32 ---
	case 0xc4: // bin8: 1 + 1-byte len + data
		return copyVarLen(data, pos, 1, result)
	case 0xc5: // bin16: 1 + 2-byte len + data
		return copyVarLen(data, pos, 2, result)
	case 0xc6: // bin32: 1 + 4-byte len + data
		return copyVarLen(data, pos, 4, result)

	// --- ext 8/16/32 ---
	case 0xc7: // ext8: 1 + 1-byte len + 1 type + data
		return copyExtVarLen(data, pos, 1, result)
	case 0xc8: // ext16: 1 + 2-byte len + 1 type + data
		return copyExtVarLen(data, pos, 2, result)
	case 0xc9: // ext32: 1 + 4-byte len + 1 type + data
		return copyExtVarLen(data, pos, 4, result)

	// --- str8 (0xd9): already compact, just copy ---
	case 0xd9: // str8: 1 + 1-byte len + data
		return copyVarLen(data, pos, 1, result)

	// --- str16 (0xda): THE conversion target ---
	case 0xda: // str16: 1 + 2-byte len + data
		if remaining < 3 {
			return 0
		}
		length := (int(data[pos+1]) << 8) | int(data[pos+2])
		total := 3 + length
		if remaining < total {
			return 0
		}
		if length < 256 {
			*result = append(*result, 0xd9)
			*result = append(*result, byte(length))
			*result = append(*result, data[pos+3:pos+total]...)
		} else {
			*result = append(*result, data[pos:pos+total]...)
		}
		return total

	// --- str32 (0xdb): just copy ---
	case 0xdb: // str32: 1 + 4-byte len + data
		return copyVarLen(data, pos, 4, result)

	// --- array16/32 ---
	case 0xdc: // array16: 1 + 2-byte count
		if remaining < 3 {
			return 0
		}
		count := (int(data[pos+1]) << 8) | int(data[pos+2])
		*result = append(*result, data[pos:pos+3]...)
		consumed := 3
		for i := 0; i < count; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed
	case 0xdd: // array32: 1 + 4-byte count
		if remaining < 5 {
			return 0
		}
		count := (int(data[pos+1]) << 24) | (int(data[pos+2]) << 16) | (int(data[pos+3]) << 8) | int(data[pos+4])
		*result = append(*result, data[pos:pos+5]...)
		consumed := 5
		for i := 0; i < count; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed

	// --- map16/32 ---
	case 0xde: // map16: 1 + 2-byte count
		if remaining < 3 {
			return 0
		}
		count := (int(data[pos+1]) << 8) | int(data[pos+2])
		*result = append(*result, data[pos:pos+3]...)
		consumed := 3
		for i := 0; i < count*2; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed
	case 0xdf: // map32: 1 + 4-byte count
		if remaining < 5 {
			return 0
		}
		count := (int(data[pos+1]) << 24) | (int(data[pos+2]) << 16) | (int(data[pos+3]) << 8) | int(data[pos+4])
		*result = append(*result, data[pos:pos+5]...)
		consumed := 5
		for i := 0; i < count*2; i++ {
			c := walkMsgpackValue(data, pos+consumed, result)
			if c <= 0 {
				return 0
			}
			consumed += c
		}
		return consumed

	default:
		// Unknown type: copy single byte as fail-safe
		*result = append(*result, b)
		return 1
	}
}

// copyFixed copies exactly `size` bytes from data[pos:] to result.
// Returns 0 if data is truncated.
func copyFixed(data []byte, pos, size int, result *[]byte) int {
	if len(data)-pos < size {
		return 0
	}
	*result = append(*result, data[pos:pos+size]...)
	return size
}

// copyVarLen handles msgpack types with a variable-length data payload:
// header(1) + length(lenBytes) + data(length). Copies as-is.
func copyVarLen(data []byte, pos, lenBytes int, result *[]byte) int {
	headerSize := 1 + lenBytes
	if len(data)-pos < headerSize {
		return 0
	}
	length := readLen(data, pos+1, lenBytes)
	total := headerSize + length
	if len(data)-pos < total {
		return 0
	}
	*result = append(*result, data[pos:pos+total]...)
	return total
}

// copyExtVarLen handles ext types: header(1) + length(lenBytes) + type(1) + data(length).
func copyExtVarLen(data []byte, pos, lenBytes int, result *[]byte) int {
	headerSize := 1 + lenBytes + 1 // format + len + type byte
	if len(data)-pos < headerSize {
		return 0
	}
	length := readLen(data, pos+1, lenBytes)
	total := headerSize + length
	if len(data)-pos < total {
		return 0
	}
	*result = append(*result, data[pos:pos+total]...)
	return total
}

// readLen reads a big-endian unsigned integer of 1, 2, or 4 bytes.
func readLen(data []byte, pos, size int) int {
	switch size {
	case 1:
		return int(data[pos])
	case 2:
		return (int(data[pos]) << 8) | int(data[pos+1])
	case 4:
		return (int(data[pos]) << 24) | (int(data[pos+1]) << 16) | (int(data[pos+2]) << 8) | int(data[pos+3])
	default:
		return 0
	}
}

// ActionHash computes the keccak256 connectionId for an L1 action: msgpack
// encoding (struct field order = insertion order, compact ints, Python-style
// str8), then nonce, vault flag, and optional expiresAfter appended.
func ActionHash(action any, vaultAddress string, nonce int64, expiresAfter *int64) ([]byte, error) {
	var buf bytes.Buffer
	enc := msgpack.NewEncoder(&buf)
	// CRITICAL: Do NOT use SetSortMapKeys(true) - Python preserves insertion order.
	// Structs in Go will serialize fields in the order they are defined.
	enc.UseCompactInts(true)

	if err := enc.Encode(action); err != nil {
		return nil, fmt.Errorf("failed to marshal action: %w", err)
	}
	data := buf.Bytes()

	// Convert str16 to str8 for Python compatibility
	data = convertStr16ToStr8(data)

	// Add nonce as 8 bytes big endian
	if nonce < 0 {
		return nil, fmt.Errorf("nonce cannot be negative: %d", nonce)
	}
	nonceBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(nonceBytes, uint64(nonce))
	data = append(data, nonceBytes...)

	// Add vault address
	if vaultAddress == "" {
		data = append(data, 0x00)
	} else {
		data = append(data, 0x01)
		data = append(data, addressToBytes(vaultAddress)...)
	}

	// Add expires_after if provided
	if expiresAfter != nil {
		if *expiresAfter < 0 {
			return nil, fmt.Errorf("expiresAfter cannot be negative: %d", *expiresAfter)
		}
		data = append(data, 0x00)
		expiresAfterBytes := make([]byte, 8)
		binary.BigEndian.PutUint64(expiresAfterBytes, uint64(*expiresAfter))
		data = append(data, expiresAfterBytes...)
	}

	return crypto.Keccak256(data), nil
}

func constructPhantomAgent(hash []byte, isMainnet bool) map[string]any {
	source := "b" // testnet
	if isMainnet {
		source = "a" // mainnet
	}
	return map[string]any{
		"source":       source,
		"connectionId": hash,
	}
}

func l1Payload(phantomAgent map[string]any) apitypes.TypedData {
	// Note: chainId is 1337 for both mainnet and testnet - it's just a signing domain identifier
	chainID := math.HexOrDecimal256(*big.NewInt(1337))

	return apitypes.TypedData{
		Domain: apitypes.TypedDataDomain{
			ChainId:           &chainID,
			Name:              "Exchange",
			Version:           "1",
			VerifyingContract: "0x0000000000000000000000000000000000000000",
		},
		Types: apitypes.Types{
			"Agent": []apitypes.Type{
				{Name: "source", Type: "string"},
				{Name: "connectionId", Type: "bytes32"},
			},
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
		},
		PrimaryType: "Agent",
		Message:     phantomAgent,
	}
}

// hashStructLenient is like HashStruct but ignores fields in message that are
// not in types. This matches Python's eth_account behavior where extra fields
// in message are silently ignored.
func hashStructLenient(
	typedData apitypes.TypedData,
	primaryType string,
	message map[string]any,
) ([]byte, error) {
	types := typedData.Types[primaryType]

	// Filter message to only include fields that exist in the type definition,
	// converting numeric values to what apitypes.HashStruct expects.
	filteredMessage := make(map[string]any)
	for _, t := range types {
		val, ok := message[t.Name]
		if !ok {
			continue
		}
		switch t.Type {
		case "uint64":
			var uintVal uint64
			switch v := val.(type) {
			case uint64:
				uintVal = v
			case int64:
				if v < 0 {
					return nil, fmt.Errorf("cannot convert negative int64 %d to uint64", v)
				}
				uintVal = uint64(v)
			case float64:
				if v < 0 || v > float64(^uint64(0)) || v != float64(uint64(v)) {
					return nil, fmt.Errorf("invalid float64 value %f for uint64", v)
				}
				uintVal = uint64(v)
			case int:
				if v < 0 {
					return nil, fmt.Errorf("cannot convert negative int %d to uint64", v)
				}
				uintVal = uint64(v)
			case json.Number:
				parsed, err := strconv.ParseUint(string(v), 10, 64)
				if err != nil {
					return nil, fmt.Errorf("failed to parse json.Number %s to uint64 for %s: %w", v, t.Name, err)
				}
				uintVal = parsed
			case string:
				parsed, err := strconv.ParseUint(v, 10, 64)
				if err != nil {
					return nil, fmt.Errorf("failed to parse string %s to uint64 for %s: %w", v, t.Name, err)
				}
				uintVal = parsed
			default:
				jsonBytes, err := json.Marshal(v)
				if err != nil {
					return nil, fmt.Errorf("failed to marshal value for %s: %w", t.Name, err)
				}
				if err := json.Unmarshal(jsonBytes, &uintVal); err != nil {
					return nil, fmt.Errorf("failed to convert value to uint64 for %s: %w", t.Name, err)
				}
			}
			// apitypes.HashStruct expects *big.Int for EIP-712 uint types.
			filteredMessage[t.Name] = new(big.Int).SetUint64(uintVal)
		default:
			filteredMessage[t.Name] = val
		}
	}

	return typedData.HashStruct(primaryType, filteredMessage)
}

func signInner(privateKey *ecdsa.PrivateKey, typedData apitypes.TypedData) (SignatureResult, error) {
	domainSeparator, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return SignatureResult{}, fmt.Errorf("failed to hash domain: %w", err)
	}

	// Lenient hashing allows extra fields in message (Python compatibility).
	typedDataHash, err := hashStructLenient(typedData, typedData.PrimaryType, typedData.Message)
	if err != nil {
		return SignatureResult{}, fmt.Errorf("failed to hash typed data: %w", err)
	}

	rawData := []byte{0x19, 0x01}
	rawData = append(rawData, domainSeparator...)
	rawData = append(rawData, typedDataHash...)
	msgHash := crypto.Keccak256Hash(rawData)

	signature, err := crypto.Sign(msgHash.Bytes(), privateKey)
	if err != nil {
		return SignatureResult{}, fmt.Errorf("failed to sign message: %w", err)
	}

	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:64])
	v := int(signature[64]) + 27

	return SignatureResult{
		R: hexutil.EncodeBig(r),
		S: hexutil.EncodeBig(s),
		V: v,
	}, nil
}

// SignL1Action signs an exchange action via the phantom-agent EIP-712 scheme:
// msgpack action hash → Agent{source, connectionId} → EIP-712 "Exchange"
// domain (chainId 1337).
func SignL1Action(
	privateKey *ecdsa.PrivateKey,
	action any,
	vaultAddress string,
	timestamp int64,
	expiresAfter *int64,
	isMainnet bool,
) (SignatureResult, error) {
	hash, err := ActionHash(action, vaultAddress, timestamp, expiresAfter)
	if err != nil {
		return SignatureResult{}, err
	}
	phantomAgent := constructPhantomAgent(hash, isMainnet)
	typedData := l1Payload(phantomAgent)
	return signInner(privateKey, typedData)
}

// SignUserSignedAction signs actions that require direct EIP-712 signing
// (e.g., approveAgent, approveBuilderFee). The message may contain MORE fields
// than declared in payloadTypes; extra fields (type, signatureChainId) are
// present in the payload sent to the exchange but ignored during EIP-712
// hashing via hashStructLenient, matching the Python SDK.
//
// NOTE: mutates action — adds signatureChainId and hyperliquidChain.
func SignUserSignedAction(
	privateKey *ecdsa.PrivateKey,
	action map[string]any,
	payloadTypes []apitypes.Type,
	primaryType string,
	isMainnet bool,
) (SignatureResult, error) {
	// signatureChainId is the chain used by the wallet to sign;
	// hyperliquidChain determines the environment and prevents replay attacks.
	action["signatureChainId"] = "0x66eee"
	action["hyperliquidChain"] = "Mainnet"
	if !isMainnet {
		action["hyperliquidChain"] = "Testnet"
	}

	// Note: chainId is hardcoded to 421614 just like the Python SDK
	chainID := math.HexOrDecimal256(*big.NewInt(421614))
	typedData := apitypes.TypedData{
		Domain: apitypes.TypedDataDomain{
			ChainId:           &chainID,
			Name:              "HyperliquidSignTransaction",
			Version:           "1",
			VerifyingContract: "0x0000000000000000000000000000000000000000",
		},
		Types: apitypes.Types{
			primaryType: payloadTypes,
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
		},
		PrimaryType: primaryType,
		Message:     action,
	}

	return signInner(privateKey, typedData)
}

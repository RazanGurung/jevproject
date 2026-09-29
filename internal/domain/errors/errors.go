package errors

import "errors"

var (
	ErrInvalidPrivateKey       = errors.New("invalid or missing private key")
	ErrInvalidPrivateKeyFormat = errors.New("invalid private key format: must be 64 hex characters")
	ErrInvalidCoin             = errors.New("coin is required")
	ErrInvalidSize             = errors.New("order size must be positive")
	ErrRateLimitExceeded       = errors.New("rate limit exceeded")
	ErrExchangeUnavailable     = errors.New("exchange unavailable")
	ErrInsufficientMargin      = errors.New("insufficient margin")
	ErrPositionNotFound        = errors.New("position not found")
	ErrOrderNotFound           = errors.New("order not found")
)

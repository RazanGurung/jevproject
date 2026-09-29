// Package preferences holds durable, process-local user preferences that must
// outlive browser storage clears (e.g. color palette templates on disk).
package preferences

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	// ColorTemplateSlotCount is the fixed number of palette template slots.
	ColorTemplateSlotCount = 4
	// ColorTemplatesVersion is the on-disk document version.
	ColorTemplatesVersion = 1
)

// ColorKeys lists every configurable palette entry (mirrors the frontend).
var ColorKeys = []string{
	"bullish",
	"bearish",
	"bullishCandle",
	"bearishCandle",
	"fvgBullish",
	"fvgBearish",
	"liqShort",
	"liqLong",
	"sessionDaily",
	"sessionWeekly",
	"sessionMonthly",
	"avwap",
	"avwapBand",
	"rvwap",
	"rvwapBand",
	"profile",
	"projection",
	"drawing",
	"background",
	"border",
}

// DefaultColorPalette is the shipped palette used to fill missing keys.
var DefaultColorPalette = map[string]string{
	"bullish":        "#22cce6",
	"bearish":        "#ff5050",
	"bullishCandle":  "#c8c8c8",
	"bearishCandle":  "#8c8c8c",
	"fvgBullish":     "#22cce6",
	"fvgBearish":     "#ff5050",
	"liqShort":       "#22cce6",
	"liqLong":        "#ff5050",
	"sessionDaily":   "#22cce6",
	"sessionWeekly":  "#4a9eff",
	"sessionMonthly": "#a78bfa",
	"avwap":          "#306eb5",
	"avwapBand":      "#306eb5",
	"rvwap":          "#306eb5",
	"rvwapBand":      "#306eb5",
	"profile":        "#306eb5",
	"projection":     "#4a9eff",
	"drawing":        "#d8d8d8",
	"background":     "#000000",
	"border":         "#2a2a2a",
}

var hexColorRE = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)

// ColorSlot is one of the four template slots. Colors is nil when empty.
type ColorSlot struct {
	Index  int               `json:"index"`
	Colors map[string]string `json:"colors"`
}

// ColorTemplatesDoc is the versioned on-disk / API document.
type ColorTemplatesDoc struct {
	Version int         `json:"version"`
	Slots   []ColorSlot `json:"slots"`
}

// EmptyColorTemplates returns a valid document with four empty slots.
func EmptyColorTemplates() ColorTemplatesDoc {
	slots := make([]ColorSlot, ColorTemplateSlotCount)
	for i := range slots {
		slots[i] = ColorSlot{Index: i, Colors: nil}
	}
	return ColorTemplatesDoc{Version: ColorTemplatesVersion, Slots: slots}
}

// NormalizeHexColor accepts "#rrggbb" or "rrggbb" and returns lowercase #rrggbb.
func NormalizeHexColor(value string) (string, bool) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return "", false
	}
	if raw[0] != '#' {
		raw = "#" + raw
	}
	if !hexColorRE.MatchString(raw) {
		return "", false
	}
	return strings.ToLower(raw), true
}

// NormalizePalette fills defaults for missing keys and validates every value.
// Invalid values for a key fall back to the default. Returns a full palette map.
func NormalizePalette(input map[string]string) map[string]string {
	out := make(map[string]string, len(ColorKeys))
	for _, key := range ColorKeys {
		out[key] = DefaultColorPalette[key]
		if input == nil {
			continue
		}
		if normalized, ok := NormalizeHexColor(input[key]); ok {
			out[key] = normalized
		}
	}
	return out
}

// NormalizeColorTemplates validates and normalizes a document into exactly four slots.
func NormalizeColorTemplates(doc ColorTemplatesDoc) (ColorTemplatesDoc, error) {
	out := EmptyColorTemplates()
	if doc.Version != 0 && doc.Version != ColorTemplatesVersion {
		return out, fmt.Errorf("unsupported color templates version %d", doc.Version)
	}
	if doc.Slots == nil {
		return out, nil
	}
	if len(doc.Slots) > ColorTemplateSlotCount {
		return out, fmt.Errorf("expected at most %d slots, got %d", ColorTemplateSlotCount, len(doc.Slots))
	}
	// Prefer explicit index; otherwise place by array position.
	used := make(map[int]bool, ColorTemplateSlotCount)
	for i, slot := range doc.Slots {
		idx := slot.Index
		if idx < 0 || idx >= ColorTemplateSlotCount {
			if i < ColorTemplateSlotCount {
				idx = i
			} else {
				return out, fmt.Errorf("slot index %d out of range", slot.Index)
			}
		}
		if used[idx] {
			return out, fmt.Errorf("duplicate slot index %d", idx)
		}
		used[idx] = true
		out.Slots[idx].Index = idx
		if slot.Colors == nil {
			out.Slots[idx].Colors = nil
			continue
		}
		// Empty object is treated as empty slot.
		if len(slot.Colors) == 0 {
			out.Slots[idx].Colors = nil
			continue
		}
		// Require at least one valid hex; otherwise reject the payload.
		hasValid := false
		for _, v := range slot.Colors {
			if _, ok := NormalizeHexColor(v); ok {
				hasValid = true
				break
			}
		}
		if !hasValid {
			return out, errors.New("slot colors contain no valid hex values")
		}
		out.Slots[idx].Colors = NormalizePalette(slot.Colors)
	}
	return out, nil
}

// LoadColorTemplates reads the file. Missing file yields empty slots (no error).
func LoadColorTemplates(path string) (ColorTemplatesDoc, error) {
	empty := EmptyColorTemplates()
	if strings.TrimSpace(path) == "" {
		return empty, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return empty, nil
		}
		return empty, err
	}
	if len(bytesTrimSpace(data)) == 0 {
		return empty, nil
	}
	var doc ColorTemplatesDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		return empty, fmt.Errorf("parse color templates: %w", err)
	}
	return NormalizeColorTemplates(doc)
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

// SaveColorTemplates validates, normalizes, and atomically writes the document.
func SaveColorTemplates(path string, doc ColorTemplatesDoc) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("color templates path is empty")
	}
	normalized, err := NormalizeColorTemplates(doc)
	if err != nil {
		return err
	}
	normalized.Version = ColorTemplatesVersion
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomic(path, data, 0o600)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

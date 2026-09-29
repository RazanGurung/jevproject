package preferences

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEmptyColorTemplates(t *testing.T) {
	doc := EmptyColorTemplates()
	if doc.Version != ColorTemplatesVersion {
		t.Fatalf("version = %d, want %d", doc.Version, ColorTemplatesVersion)
	}
	if len(doc.Slots) != ColorTemplateSlotCount {
		t.Fatalf("slots = %d, want %d", len(doc.Slots), ColorTemplateSlotCount)
	}
	for i, slot := range doc.Slots {
		if slot.Index != i {
			t.Fatalf("slot[%d].Index = %d", i, slot.Index)
		}
		if slot.Colors != nil {
			t.Fatalf("slot[%d] expected empty colors", i)
		}
	}
}

func TestNormalizeHexColor(t *testing.T) {
	got, ok := NormalizeHexColor("A1b2C3")
	if !ok || got != "#a1b2c3" {
		t.Fatalf("got %q ok=%v", got, ok)
	}
	if _, ok := NormalizeHexColor("#12345"); ok {
		t.Fatal("expected reject short hex")
	}
	if _, ok := NormalizeHexColor("#12345678"); ok {
		t.Fatal("expected reject long hex")
	}
}

func TestLoadMissingFileIsEmpty(t *testing.T) {
	doc, err := LoadColorTemplates(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatalf("LoadColorTemplates: %v", err)
	}
	if len(doc.Slots) != ColorTemplateSlotCount {
		t.Fatalf("slots = %d", len(doc.Slots))
	}
	for _, slot := range doc.Slots {
		if slot.Colors != nil {
			t.Fatalf("expected empty slot %d", slot.Index)
		}
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "color-palette-templates.json")
	palette := NormalizePalette(map[string]string{
		"bullish": "#123abc",
		"bearish": "#ff0000",
	})
	doc := EmptyColorTemplates()
	doc.Slots[1].Colors = palette

	if err := SaveColorTemplates(path, doc); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// No leftover temp files.
	matches, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".*tmp-*"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("leftover temps: %v", matches)
	}

	loaded, err := LoadColorTemplates(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Slots[1].Colors == nil {
		t.Fatal("slot 1 empty after load")
	}
	if loaded.Slots[1].Colors["bullish"] != "#123abc" {
		t.Fatalf("bullish = %q", loaded.Slots[1].Colors["bullish"])
	}
	// Defaults filled for unspecified keys.
	if loaded.Slots[1].Colors["drawing"] != DefaultColorPalette["drawing"] {
		t.Fatalf("drawing default missing: %q", loaded.Slots[1].Colors["drawing"])
	}
	if loaded.Slots[0].Colors != nil || loaded.Slots[2].Colors != nil {
		t.Fatal("other slots should stay empty")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %#o, want 0600", info.Mode().Perm())
	}
}

func TestNormalizeRejectsTooManySlots(t *testing.T) {
	doc := EmptyColorTemplates()
	doc.Slots = append(doc.Slots, ColorSlot{Index: 4})
	if _, err := NormalizeColorTemplates(doc); err == nil {
		t.Fatal("expected error for extra slots")
	}
}

func TestNormalizeRejectsAllInvalidColors(t *testing.T) {
	doc := EmptyColorTemplates()
	doc.Slots[0].Colors = map[string]string{"bullish": "nope"}
	if _, err := NormalizeColorTemplates(doc); err == nil {
		t.Fatal("expected error for invalid colors")
	}
}

func TestNormalizePartialPaletteFillsDefaults(t *testing.T) {
	doc := EmptyColorTemplates()
	doc.Slots[0].Colors = map[string]string{"bullish": "#ABCDEF", "bearish": "bad"}
	out, err := NormalizeColorTemplates(doc)
	if err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if out.Slots[0].Colors["bullish"] != "#abcdef" {
		t.Fatalf("bullish = %q", out.Slots[0].Colors["bullish"])
	}
	if out.Slots[0].Colors["bearish"] != DefaultColorPalette["bearish"] {
		t.Fatalf("invalid bearish should fall back, got %q", out.Slots[0].Colors["bearish"])
	}
}

func TestCorruptFileErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadColorTemplates(path); err == nil {
		t.Fatal("expected parse error")
	}
}

func TestJSONNullColors(t *testing.T) {
	raw := `{"version":1,"slots":[{"index":0,"colors":null},{"index":1,"colors":{"bullish":"#112233"}},{"index":2,"colors":null},{"index":3,"colors":null}]}`
	var doc ColorTemplatesDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatal(err)
	}
	out, err := NormalizeColorTemplates(doc)
	if err != nil {
		t.Fatal(err)
	}
	if out.Slots[0].Colors != nil {
		t.Fatal("slot 0 should be empty")
	}
	if out.Slots[1].Colors["bullish"] != "#112233" {
		t.Fatalf("got %q", out.Slots[1].Colors["bullish"])
	}
}

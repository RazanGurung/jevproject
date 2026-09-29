package services

import (
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// mustTime parses an RFC3339 timestamp or fails the test.
func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return ts
}

func TestSessionFor(t *testing.T) {
	cases := map[string]string{
		"xyz:NVDA":     "NASDAQ", // US default
		"xyz:TSM":      "NYSE",   // US-listed ADR
		"xyz:BABA":     "NYSE",   // US-listed ADR
		"xyz:EWY":      "NYSE Arca",
		"xyz:SKHY":     "NASDAQ", // Nasdaq ADR, distinct from KRX SKHX
		"xyz:SMSN":     "KRX",    // purely-foreign equity -> home
		"xyz:SOFTBANK": "TSE",
		"xyz:ZHIPU":    "HKEX",   // purely-foreign equity -> home (has a lunch halt)
		"NVDA":         "NASDAQ", // bare symbol also works
		// futures-tracked -> CME globex calendar
		"xyz:SP500":  "CME", // equity-index future
		"xyz:XYZ100": "CME",
		"xyz:JP225":  "TSE",
		"xyz:KR200":  "KRX", // futures override: KOSPI 200 trades on KRX, not CME
		"xyz:CL":     "CME", // commodity
		"xyz:GOLD":   "CME",
		"xyz:JPY":    "FX", // continuous-week spot FX
	}
	for coin, want := range cases {
		if got := SessionFor(coin).Exchange; got != want {
			t.Errorf("SessionFor(%q).Exchange = %q, want %q", coin, got, want)
		}
	}
	// Futures symbols carry the futures kind; equities stay the default kind.
	if SessionFor("xyz:CL").Kind != FuturesSession {
		t.Error("xyz:CL should be a FuturesSession")
	}
	if SessionFor("xyz:NVDA").Kind != EquitySession {
		t.Error("xyz:NVDA should be an EquitySession")
	}
}

func TestLastClose(t *testing.T) {
	us := SessionFor("xyz:NVDA")

	// EDT: 4PM ET on a weekday == 20:00 UTC.
	// Now = Wed 2026-06-24 18:00 UTC (after the 20:00 UTC close? no — before).
	// Pick a time after the close to land on the same day.
	got, ok := us.LastClose(mustTime(t, "2026-06-24T21:00:00Z")) // Wed, after 20:00Z close
	if !ok {
		t.Fatal("LastClose not ok")
	}
	if want := mustTime(t, "2026-06-24T20:00:00Z"); !got.Equal(want) {
		t.Errorf("EDT close = %s, want %s", got.UTC(), want)
	}

	// Before today's close on a weekday -> previous weekday's close.
	got, _ = us.LastClose(mustTime(t, "2026-06-24T12:00:00Z")) // Wed noon UTC, before 20:00Z
	if want := mustTime(t, "2026-06-23T20:00:00Z"); !got.Equal(want) {
		t.Errorf("pre-close close = %s, want %s", got.UTC(), want)
	}

	// EST: 4PM ET == 21:00 UTC in winter (DST handled by zoneinfo).
	got, _ = us.LastClose(mustTime(t, "2026-01-21T23:00:00Z")) // Wed, after 21:00Z
	if want := mustTime(t, "2026-01-21T21:00:00Z"); !got.Equal(want) {
		t.Errorf("EST close = %s, want %s", got.UTC(), want)
	}

	// Weekend -> Friday's close. Sat 2026-06-27.
	got, _ = us.LastClose(mustTime(t, "2026-06-27T10:00:00Z"))
	if want := mustTime(t, "2026-06-26T20:00:00Z"); !got.Equal(want) {
		t.Errorf("weekend close = %s, want %s (Fri)", got.UTC(), want)
	}

	// Sunday -> still Friday's close.
	got, _ = us.LastClose(mustTime(t, "2026-06-28T10:00:00Z"))
	if want := mustTime(t, "2026-06-26T20:00:00Z"); !got.Equal(want) {
		t.Errorf("sunday close = %s, want %s (Fri)", got.UTC(), want)
	}

	// Tokyo (no DST): 15:30 JST == 06:30 UTC year-round.
	jp := SessionFor("xyz:SOFTBANK")
	got, _ = jp.LastClose(mustTime(t, "2026-06-24T10:00:00Z")) // Wed, after 06:30Z
	if want := mustTime(t, "2026-06-24T06:30:00Z"); !got.Equal(want) {
		t.Errorf("Tokyo close = %s, want %s", got.UTC(), want)
	}
}

func TestIsOpen(t *testing.T) {
	us := SessionFor("xyz:NVDA")

	// Wed 2026-06-24, EDT: open window is 13:30–20:00 UTC.
	if !us.IsOpen(mustTime(t, "2026-06-24T15:00:00Z")) {
		t.Error("expected US open at 15:00Z weekday")
	}
	if us.IsOpen(mustTime(t, "2026-06-24T21:00:00Z")) {
		t.Error("expected US closed at 21:00Z (after close)")
	}
	if us.IsOpen(mustTime(t, "2026-06-24T12:00:00Z")) {
		t.Error("expected US closed at 12:00Z (before open)")
	}
	// Saturday -> closed regardless of time.
	if us.IsOpen(mustTime(t, "2026-06-27T15:00:00Z")) {
		t.Error("expected US closed on Saturday")
	}
}

// CME futures (America/Chicago): in June (CDT, UTC-5) the Sunday reopen 17:00 CT
// == 22:00 UTC, the Friday/daily settlement 16:00 CT == 21:00 UTC, and the daily
// halt 16:00–17:00 CT == 21:00–22:00 UTC. Week of 2026-06-21 (Sun) .. 06-27 (Sat).
func TestFuturesSessionIsOpen(t *testing.T) {
	f := SessionFor("xyz:CL")
	if f.Kind != FuturesSession {
		t.Fatalf("xyz:CL session kind = %v, want FuturesSession", f.Kind)
	}
	cases := []struct {
		ts   string
		open bool
		why  string
	}{
		{"2026-06-21T21:00:00Z", false, "Sunday 16:00 CT, before the reopen"},
		{"2026-06-21T23:00:00Z", true, "Sunday 18:00 CT, after the reopen"},
		{"2026-06-24T06:00:00Z", true, "Wednesday 01:00 CT overnight"},
		{"2026-06-24T21:30:00Z", false, "Wednesday 16:30 CT, daily settlement halt"},
		{"2026-06-26T20:00:00Z", true, "Friday 15:00 CT, before settlement"},
		{"2026-06-26T22:00:00Z", false, "Friday 17:00 CT, after settlement (weekend)"},
		{"2026-06-27T18:00:00Z", false, "Saturday"},
	}
	for _, c := range cases {
		if got := f.IsOpen(mustTime(t, c.ts)); got != c.open {
			t.Errorf("IsOpen(%s) = %v, want %v (%s)", c.ts, got, c.open, c.why)
		}
	}
}

func TestFuturesSessionLastClose(t *testing.T) {
	f := SessionFor("xyz:CL")

	// Weekend -> Friday's 16:00 CT settlement (21:00 UTC in CDT).
	got, ok := f.LastClose(mustTime(t, "2026-06-27T18:00:00Z")) // Saturday
	if !ok {
		t.Fatal("LastClose not ok")
	}
	if want := mustTime(t, "2026-06-26T21:00:00Z"); !got.Equal(want) {
		t.Errorf("weekend last close = %s, want %s (Fri 16:00 CT)", got.UTC(), want)
	}

	// Daily settlement halt -> today's 16:00 CT settlement.
	got, _ = f.LastClose(mustTime(t, "2026-06-24T21:30:00Z")) // Wed 16:30 CT
	if want := mustTime(t, "2026-06-24T21:00:00Z"); !got.Equal(want) {
		t.Errorf("daily-halt last close = %s, want %s (Wed 16:00 CT)", got.UTC(), want)
	}
}

// KOSPI 200 futures (Korea Exchange, Asia/Seoul, no DST): day session
// 08:45-15:45 KST, night session 18:00-06:00 KST (next day). The
// futuresSessionOverride models the day-settlement/night-reopen halt
// (15:45-18:00 KST) via the same FuturesSession machinery as CME, just with
// KRX's own TZ and local times — this was previously (incorrectly) routed
// through cmeFuturesSession, whose Chicago-time halt lands in the middle of
// the Korean night and has no relationship to KRX's real calendar. (Not
// modeled: the smaller ~06:00-08:45 KST gap between the night session ending
// and the next day session opening — an accepted approximation, same spirit
// as the documented ICE/Eurex/OSE approximations to CME.)
func TestKR200FuturesSessionUsesKRXNotCME(t *testing.T) {
	f := SessionFor("xyz:KR200")
	if f.Exchange != "KRX" || f.TZ != "Asia/Seoul" || f.Kind != SplitFuturesSession {
		t.Fatalf("xyz:KR200 session = %+v, want KRX/Asia/Seoul/SplitFuturesSession", f)
	}
	cases := []struct {
		ts   string
		open bool
		why  string
	}{
		{"2026-06-21T08:00:00Z", false, "Sunday 17:00 KST, before the reopen"},
		{"2026-06-21T10:00:00Z", true, "Sunday 19:00 KST, after the reopen"},
		{"2026-06-23T16:00:00Z", true, "Wednesday 01:00 KST overnight"},
		{"2026-06-23T22:00:00Z", false, "Wednesday 07:00 KST between night and day sessions"},
		{"2026-06-24T07:30:00Z", false, "Wednesday 16:30 KST, day/night halt"},
		{"2026-06-26T06:00:00Z", true, "Friday 15:00 KST, before settlement"},
		{"2026-06-26T08:00:00Z", false, "Friday 17:00 KST, after settlement (weekend)"},
		{"2026-06-27T09:00:00Z", false, "Saturday"},
	}
	for _, c := range cases {
		if got := f.IsOpen(mustTime(t, c.ts)); got != c.open {
			t.Errorf("IsOpen(%s) = %v, want %v (%s)", c.ts, got, c.open, c.why)
		}
	}

	// Weekend -> Friday's 15:45 KST settlement (06:45 UTC).
	got, ok := f.LastClose(mustTime(t, "2026-06-27T09:00:00Z")) // Saturday
	if !ok {
		t.Fatal("LastClose not ok")
	}
	if want := mustTime(t, "2026-06-26T06:45:00Z"); !got.Equal(want) {
		t.Errorf("weekend last close = %s, want %s (Fri 15:45 KST)", got.UTC(), want)
	}

	// Daily halt -> today's 15:45 KST settlement.
	got, _ = f.LastClose(mustTime(t, "2026-06-24T07:30:00Z")) // Wed 16:30 KST
	if want := mustTime(t, "2026-06-24T06:45:00Z"); !got.Equal(want) {
		t.Errorf("daily-halt last close = %s, want %s (Wed 15:45 KST)", got.UTC(), want)
	}
}

func TestTSEAndSSELunchBreaks(t *testing.T) {
	cases := []struct {
		coin string
		at   string
		open bool
	}{
		{"xyz:SOFTBANK", "2026-06-24T02:00:00Z", true},  // 11:00 JST
		{"xyz:SOFTBANK", "2026-06-24T03:00:00Z", false}, // 12:00 JST
		{"xyz:SOFTBANK", "2026-06-24T04:00:00Z", true},  // 13:00 JST
		{"xyz:GIGADEV", "2026-07-30T03:00:00Z", true},   // 11:00 CST
		{"xyz:GIGADEV", "2026-07-30T04:00:00Z", false},  // 12:00 CST lunch
		{"xyz:GIGADEV", "2026-07-30T05:30:00Z", true},   // 13:30 CST
	}
	for _, tc := range cases {
		if got := SessionFor(tc.coin).IsOpen(mustTime(t, tc.at)); got != tc.open {
			t.Errorf("%s IsOpen(%s)=%v want %v", tc.coin, tc.at, got, tc.open)
		}
	}
}

func TestFXContinuousWeekHasNoDailyMaintenance(t *testing.T) {
	fx := SessionFor("xyz:JPY")
	if fx.Kind != ContinuousWeekSession {
		t.Fatalf("JPY kind=%v want ContinuousWeekSession", fx.Kind)
	}
	cases := []struct {
		at   string
		open bool
	}{
		{"2026-06-21T20:59:00Z", false}, // Sunday 16:59 ET
		{"2026-06-21T21:00:00Z", true},  // Sunday 17:00 ET
		{"2026-06-24T21:30:00Z", true},  // Wednesday 17:30 ET
		{"2026-06-26T20:59:00Z", true},  // Friday 16:59 ET
		{"2026-06-26T21:00:00Z", false}, // Friday 17:00 ET
	}
	for _, tc := range cases {
		if got := fx.IsOpen(mustTime(t, tc.at)); got != tc.open {
			t.Errorf("JPY IsOpen(%s)=%v want %v", tc.at, got, tc.open)
		}
	}
}

func TestIntermissionLastCloseUsesLatestCompletedWindow(t *testing.T) {
	tse := SessionFor("xyz:SOFTBANK")
	state, closeAt, covered := tse.StateAt(mustTime(t, "2026-06-24T03:00:00Z"))
	if !covered || state != SessionIntermission {
		t.Fatalf("TSE lunch state=%q covered=%v", state, covered)
	}
	if want := mustTime(t, "2026-06-24T02:30:00Z"); !closeAt.Equal(want) {
		t.Fatalf("TSE lunch last close=%s want %s", closeAt, want)
	}
}

// Hong Kong (HKEX, Asia/Hong_Kong, no DST): 09:30-16:00 HKT with a
// 12:00-13:00 lunch halt. This is the session xyz:ZHIPU (Zhipu AI, HKEX
// 2513.HK) needs — previously absent from symbolSession entirely, so it fell
// through to usSession (US hours), and even a correct HKEX entry would still
// be wrong through the lunch break without ordered regular-session windows.
func TestHKEXLunchBreak(t *testing.T) {
	hk := SessionFor("xyz:ZHIPU")
	if hk.Exchange != "HKEX" || hk.TZ != "Asia/Hong_Kong" {
		t.Fatalf("xyz:ZHIPU session = %+v, want HKEX/Asia/Hong_Kong", hk)
	}
	cases := []struct {
		ts   string
		open bool
		why  string
	}{
		{"2026-06-24T01:00:00Z", false, "Wed 09:00 HKT, before open"},
		{"2026-06-24T02:00:00Z", true, "Wed 10:00 HKT, morning session"},
		{"2026-06-24T04:30:00Z", false, "Wed 12:30 HKT, lunch halt"},
		{"2026-06-24T06:00:00Z", true, "Wed 14:00 HKT, afternoon session"},
		{"2026-06-24T08:30:00Z", false, "Wed 16:30 HKT, after close"},
		{"2026-06-27T04:30:00Z", false, "Saturday, regardless of time"},
	}
	for _, c := range cases {
		if got := hk.IsOpen(mustTime(t, c.ts)); got != c.open {
			t.Errorf("IsOpen(%s) = %v, want %v (%s)", c.ts, got, c.open, c.why)
		}
	}
}

func TestSessionStateUsesHolidayAndEarlyCloseCalendar(t *testing.T) {
	us, ok := MispricingInstrumentFor("xyz:NVDA")
	if !ok {
		t.Fatal("xyz:NVDA missing from exact registry")
	}
	state, closeAt, covered := us.Session.StateAt(mustTime(t, "2026-07-03T16:00:00Z"))
	if !covered || state != SessionHoliday {
		t.Fatalf("July 3 observed holiday state=%q covered=%v", state, covered)
	}
	if want := mustTime(t, "2026-07-02T20:00:00Z"); !closeAt.Equal(want) {
		t.Fatalf("holiday last close=%s want %s", closeAt, want)
	}

	// Black Friday closes at 13:00 ET (18:00 UTC), not the ordinary 16:00.
	state, closeAt, covered = us.Session.StateAt(mustTime(t, "2026-11-27T19:00:00Z"))
	if !covered || state == SessionOpen {
		t.Fatalf("after early close state=%q covered=%v", state, covered)
	}
	if want := mustTime(t, "2026-11-27T18:00:00Z"); !closeAt.Equal(want) {
		t.Fatalf("early close=%s want %s", closeAt, want)
	}
}

func TestForeignCashCalendarsUseMaintainedClosures(t *testing.T) {
	tests := []struct {
		coin string
		at   string
		want SessionState
	}{
		{"xyz:KIOXIA", "2026-09-22T03:00:00Z", SessionHoliday},
		{"xyz:ZHIPU", "2026-02-17T03:00:00Z", SessionHoliday},
		{"xyz:SKHX", "2026-09-25T03:00:00Z", SessionHoliday},
	}
	for _, tc := range tests {
		instrument, ok := MispricingInstrumentFor(tc.coin)
		if !ok {
			t.Fatalf("%s missing from exact registry", tc.coin)
		}
		state, _, covered := instrument.Session.StateAt(mustTime(t, tc.at))
		if !covered || state != tc.want {
			t.Errorf("%s at %s state=%q covered=%v want %q", tc.coin, tc.at, state, covered, tc.want)
		}
	}

	hk, _ := MispricingInstrumentFor("xyz:ZHIPU")
	state, closeAt, covered := hk.Session.StateAt(mustTime(t, "2026-12-24T05:00:00Z"))
	if !covered || state == SessionOpen {
		t.Fatalf("HKEX half-day state=%q covered=%v", state, covered)
	}
	if want := mustTime(t, "2026-12-24T04:00:00Z"); !closeAt.Equal(want) {
		t.Fatalf("HKEX half-day close=%s want %s", closeAt, want)
	}
}

func TestSessionStateFailsClosedOutsideCalendarCoverage(t *testing.T) {
	us, _ := MispricingInstrumentFor("xyz:NVDA")
	state, _, covered := us.Session.StateAt(mustTime(t, "2028-01-03T22:00:00Z"))
	if covered {
		t.Fatalf("out-of-coverage date unexpectedly accepted with state %q", state)
	}
}

func TestProductSpecificFuturesHolidayFailsClosed(t *testing.T) {
	state, _, covered := cmeFuturesSession.StateAt(mustTime(t, "2026-11-26T18:00:00Z"))
	if covered {
		t.Fatalf("product-specific CME holiday unexpectedly accepted with state %q", state)
	}
	got, ok := cmeFuturesSession.LastClose(mustTime(t, "2026-11-27T15:00:00Z"))
	if !ok {
		t.Fatal("CME close before Friday session was not resolved")
	}
	if want := mustTime(t, "2026-11-25T22:00:00Z"); !got.Equal(want) {
		t.Fatalf("unsupported Thursday close leaked: got %s want %s", got, want)
	}
	krxFutures := futuresSessionOverride["KR200"]
	state, _, covered = krxFutures.StateAt(mustTime(t, "2026-09-25T03:00:00Z"))
	if covered {
		t.Fatalf("KRX futures holiday unexpectedly accepted with state %q", state)
	}
	if krxFutures.IsOpen(mustTime(t, "2026-09-28T16:00:00Z")) {
		t.Fatal("KRX overnight session opened from a holiday anchor day")
	}
	got, ok = krxFutures.LastClose(mustTime(t, "2026-09-29T00:00:00Z"))
	if !ok {
		t.Fatal("KRX close after holiday block was not resolved")
	}
	if want := mustTime(t, "2026-09-23T06:45:00Z"); !got.Equal(want) {
		t.Fatalf("KRX holiday close leaked: got %s want %s", got, want)
	}
}

func TestRegisteredMispricingDexesAndExactIds(t *testing.T) {
	got := RegisteredMispricingDexes()
	want := []string{"xyz"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("registered dexes=%v want %v", got, want)
	}
	if _, ok := MispricingInstrumentFor("AVGO"); ok {
		t.Fatal("bare ticker must not inherit a builder-DEX session")
	}
	if _, ok := MispricingInstrumentFor("para:AVGO"); ok {
		t.Fatal("non-xyz HIP-3 markets must not be registered")
	}
}

func TestMispricingRegistryMatchesAuditedActiveNonCryptoUniverse(t *testing.T) {
	data, err := os.ReadFile("testdata/mispricing_active_universe.txt")
	if err != nil {
		t.Fatal(err)
	}
	expected := strings.Fields(string(data))
	sort.Strings(expected)
	registry := MispricingInstrumentRegistry()
	got := make([]string, 0, len(registry))
	for coin, instrument := range registry {
		got = append(got, coin)
		if resolved := SessionFor(coin); !reflect.DeepEqual(resolved, instrument.Session) {
			t.Errorf("SessionFor(%s)=%+v registry=%+v", coin, resolved, instrument.Session)
		}
	}
	sort.Strings(got)
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("registry differs from audited active universe:\ngot  %v\nwant %v", got, expected)
	}
}

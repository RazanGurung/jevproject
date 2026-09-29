package services

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// locationCache memoizes time.LoadLocation results. The standard library parses
// zoneinfo on every LoadLocation call (no internal cache), and the session
// helpers below resolve a zone for every candidate on every request; there are
// only a handful of distinct zones, so caching the *time.Location collapses that
// repeated parsing to one lookup per zone for the process lifetime.
var locationCache sync.Map // map[string]*time.Location

// loadLocation returns the IANA zone for tz, memoized. ok is false only when the
// zone name can't be loaded (same contract as time.LoadLocation's error).
func loadLocation(tz string) (*time.Location, bool) {
	if v, ok := locationCache.Load(tz); ok {
		return v.(*time.Location), true
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, false
	}
	locationCache.Store(tz, loc)
	return loc, true
}

// SessionKind selects how a Session's open/close window is interpreted.
type SessionKind int

const (
	// EquitySession is a single daytime window [OpenLocal, CloseLocal) on
	// weekdays — a cash equity/ETF home session (the zero value, so existing
	// equity sessions need no Kind set).
	EquitySession SessionKind = iota
	// FuturesSession is a near-24h futures calendar: continuous from the Sunday
	// reopen through the Friday settlement, broken only by a daily settlement
	// halt. For these, OpenLocal is the daily reopen (evening) and CloseLocal is
	// the daily settlement (afternoon), so the daily halt is [CloseLocal, OpenLocal).
	FuturesSession
	// ContinuousWeekSession is open continuously from the Sunday reopen to the
	// Friday close, with no daily settlement halt (spot FX).
	ContinuousWeekSession
	// SplitFuturesSession has a weekday day session plus a Sunday-Thursday
	// overnight session, represented by Windows (KRX KOSPI 200 futures).
	SplitFuturesSession
)

type SessionWindow struct {
	OpenLocal  string
	CloseLocal string
}

// Session describes an instrument's underlying-market trading session in local
// wall-clock terms. Times are "HH:MM" strings interpreted in TZ (an IANA zone),
// so DST is handled automatically by the standard library's zoneinfo.
type Session struct {
	Exchange   string
	TZ         string
	CalendarID string
	Kind       SessionKind
	OpenLocal  string
	CloseLocal string
	// LunchStartLocal/LunchEndLocal optionally carve a midday halt out of an
	// EquitySession's [OpenLocal, CloseLocal) window (e.g. HKEX's 12:00-13:00
	// lunch break). Both empty (the zero value) means no break, so every
	// existing session is unaffected. Does not apply to FuturesSession, which
	// already has its own daily-halt model.
	LunchStartLocal string
	LunchEndLocal   string
	// Windows replaces the single open/close pair for cash markets with more
	// than one regular trading window and split-session futures.
	Windows []SessionWindow
}

// usSession is the Nasdaq/default US session. Other US venue labels use the
// same regular 09:30–16:00 ET calendar and are assigned in the exact registry.
var usSession = Session{Exchange: "NASDAQ", TZ: "America/New_York", CalendarID: "us-cash", OpenLocal: "09:30", CloseLocal: "16:00"}
var nyseSession = Session{Exchange: "NYSE", TZ: "America/New_York", CalendarID: "us-cash", OpenLocal: "09:30", CloseLocal: "16:00"}
var nyseArcaSession = Session{Exchange: "NYSE Arca", TZ: "America/New_York", CalendarID: "us-cash", OpenLocal: "09:30", CloseLocal: "16:00"}
var cboeBZXSession = Session{Exchange: "Cboe BZX", TZ: "America/New_York", CalendarID: "us-cash", OpenLocal: "09:30", CloseLocal: "16:00"}
var tseSession = Session{
	Exchange: "TSE", TZ: "Asia/Tokyo", CalendarID: "tse-cash",
	Windows: []SessionWindow{{OpenLocal: "09:00", CloseLocal: "11:30"}, {OpenLocal: "12:30", CloseLocal: "15:30"}},
}
var hkexSession = Session{
	Exchange: "HKEX", TZ: "Asia/Hong_Kong", CalendarID: "hkex-cash",
	Windows: []SessionWindow{{OpenLocal: "09:30", CloseLocal: "12:00"}, {OpenLocal: "13:00", CloseLocal: "16:00"}},
}
var sseSession = Session{
	Exchange: "SSE", TZ: "Asia/Shanghai", CalendarID: "sse-cash",
	Windows: []SessionWindow{{OpenLocal: "09:30", CloseLocal: "11:30"}, {OpenLocal: "13:00", CloseLocal: "15:00"}},
}

// symbolSession maps a bare symbol (no "xyz:" prefix, upper-case) to its home
// exchange session. Only purely-foreign cash-equity listings need an entry;
// anything not listed — all US names, ADRs, and US-listed ETFs — falls back to
// usSession. Futures-tracked symbols (commodities/index-futures/FX) are handled
// separately via futuresSymbols, not here. Hand-maintained: new foreign listings
// default to US until added here.
var symbolSession = map[string]Session{
	// Korea (KRX) 09:00–15:30 KST
	"SKHX":    {Exchange: "KRX", TZ: "Asia/Seoul", CalendarID: "krx-cash", OpenLocal: "09:00", CloseLocal: "15:30"},
	"SMSN":    {Exchange: "KRX", TZ: "Asia/Seoul", CalendarID: "krx-cash", OpenLocal: "09:00", CloseLocal: "15:30"},
	"HYUNDAI": {Exchange: "KRX", TZ: "Asia/Seoul", CalendarID: "krx-cash", OpenLocal: "09:00", CloseLocal: "15:30"},
	// Japan (TSE) 09:00–15:30 JST
	"KIOXIA":   tseSession,
	"SOFTBANK": tseSession,
	// Hong Kong (HKEX) 09:30–16:00 HKT with a 12:00–13:00 lunch halt.
	"ZHIPU":   hkexSession,
	"MINIMAX": hkexSession,
	"GIGADEV": sseSession,
	"CXMT":    sseSession,
}

// cmeFuturesSession is the default futures calendar (CME Globex): continuous from
// the Sunday 17:00 CT reopen through the Friday 16:00 CT settlement, with a daily
// 16:00–17:00 CT settlement halt Mon–Thu. America/Chicago handles DST. This is
// accurate for the registered CME/NYMEX/COMEX products. Other venues and FX use
// explicit overrides below.
var cmeFuturesSession = Session{
	Exchange: "CME", TZ: "America/Chicago", CalendarID: "cme", Kind: FuturesSession,
	OpenLocal: "17:00", CloseLocal: "16:00",
}
var iceFuturesSession = Session{
	Exchange: "ICE", TZ: "America/New_York", CalendarID: "cme", Kind: FuturesSession,
	OpenLocal: "18:00", CloseLocal: "17:00",
}
var fxSession = Session{
	Exchange: "FX", TZ: "America/New_York", CalendarID: "fx", Kind: ContinuousWeekSession,
	OpenLocal: "17:00", CloseLocal: "17:00",
}

// futuresSymbols is the set of currently-listed HL xyz symbols whose underlying
// is a futures market (so they reset at the futures open/close, not a cash
// equity session). Scoped to HL's active listing — no aliases, no delisted
// names. Hand-maintained alongside the live xyz universe.
var futuresSymbols = map[string]bool{
	// commodities (NYMEX/COMEX/ICE)
	"CL": true, "BRENTOIL": true, "NATGAS": true, "GOLD": true, "SILVER": true,
	"COPPER": true, "PLATINUM": true, "PALLADIUM": true,
	// equity-index futures
	"SP500": true, "XYZ100": true, "KR200": true,
	// FX
	"JPY": true, "EUR": true, "GBP": true,
}

// futuresSessionOverride maps a futures symbol to a non-default (non-CME) session
// for venues whose hours differ materially (ICE/Eurex/OSE). This is the
// documented extension point; everything not listed here defaults to
// cmeFuturesSession.
var futuresSessionOverride = map[string]Session{
	// KOSPI 200 futures trade on the Korea Exchange (KRX), not CME: a day
	// session 08:45-15:45 KST plus a night session 18:00-06:00 KST (next day).
	// The real daily halt (15:45-18:00 KST) has no overlap with the CME
	// default's Chicago-time halt translated into KST, so this isn't a minor
	// drift — it's the wrong exchange's calendar entirely.
	"KR200": {
		Exchange: "KRX", TZ: "Asia/Seoul", CalendarID: "krx-futures", Kind: SplitFuturesSession,
		Windows: []SessionWindow{{OpenLocal: "08:45", CloseLocal: "15:45"}, {OpenLocal: "18:00", CloseLocal: "06:00"}},
	},
	"BRENTOIL": iceFuturesSession,
	"JPY":      fxSession,
	"EUR":      fxSession,
	"GBP":      fxSession,
}

// SessionState is presentation metadata for a supported market. Eligibility
// only distinguishes open from closed; the more specific closed reason helps
// the operator understand why an instrument is in the scanner.
type SessionState string

const (
	SessionOpen         SessionState = "open"
	SessionOvernight    SessionState = "overnight"
	SessionWeekend      SessionState = "weekend"
	SessionHoliday      SessionState = "holiday"
	SessionIntermission SessionState = "intermission"
	SessionMaintenance  SessionState = "maintenance"
)

type MispricingInstrument struct {
	Session Session
}

func cashSession(exchange, tz, calendarID, open, close string) Session {
	return Session{Exchange: exchange, TZ: tz, CalendarID: calendarID, OpenLocal: open, CloseLocal: close}
}

// mispricingInstruments is deliberately exact and conservative. A listing is
// not eligible merely because its ticker resembles an equity or because it
// lives on a particular builder DEX.
var mispricingInstruments = func() map[string]MispricingInstrument {
	out := make(map[string]MispricingInstrument)
	add := func(session Session, coins ...string) {
		for _, coin := range coins {
			out[coin] = MispricingInstrument{Session: session}
		}
	}
	add(usSession,
		"xyz:TSLA", "xyz:NVDA", "xyz:HOOD", "xyz:INTC", "xyz:PLTR", "xyz:COIN",
		"xyz:META", "xyz:AAPL", "xyz:MSFT", "xyz:ORCL", "xyz:GOOGL", "xyz:AMZN",
		"xyz:AMD", "xyz:MU", "xyz:SNDK", "xyz:MSTR", "xyz:CRCL", "xyz:NFLX",
		"xyz:COST", "xyz:LLY", "xyz:TSM", "xyz:RIVN", "xyz:BABA", "xyz:USAR",
		"xyz:CRWV", "xyz:URNM", "xyz:GME", "xyz:EWY", "xyz:EWJ", "xyz:HIMS",
		"xyz:DKNG", "xyz:LITE", "xyz:XLE", "xyz:BX", "xyz:MRVL", "xyz:RKLB",
		"xyz:EWZ", "xyz:ZM", "xyz:EBAY", "xyz:ARM", "xyz:EWT", "xyz:SPCX",
		"xyz:ASML", "xyz:BB", "xyz:DELL", "xyz:IBM", "xyz:AVGO", "xyz:NOW",
		"xyz:NBIS", "xyz:WDC", "xyz:NOK", "xyz:SMH", "xyz:BE", "xyz:QCOM",
		"xyz:STRC", "xyz:AMAT", "xyz:PURRDAT", "xyz:BIRD", "xyz:CBRS",
		"xyz:QNT", "xyz:BOT", "xyz:SHAZ", "xyz:SKHY",
	)
	add(nyseSession,
		"xyz:CRCL", "xyz:LLY", "xyz:TSM", "xyz:BABA", "xyz:GME",
		"xyz:HIMS", "xyz:BX", "xyz:BB", "xyz:DELL", "xyz:IBM", "xyz:NOW",
		"xyz:NOK", "xyz:BE",
	)
	add(nyseArcaSession, "xyz:URNM", "xyz:EWY", "xyz:EWJ", "xyz:XLE", "xyz:EWZ", "xyz:EWT")
	add(cboeBZXSession, "xyz:DRAM")
	krx := cashSession("KRX", "Asia/Seoul", "krx-cash", "09:00", "15:30")
	add(krx, "xyz:SKHX", "xyz:SMSN", "xyz:HYUNDAI")
	add(tseSession, "xyz:SOFTBANK", "xyz:KIOXIA", "xyz:JP225")
	add(hkexSession, "xyz:ZHIPU", "xyz:MINIMAX")
	add(sseSession, "xyz:GIGADEV", "xyz:CXMT")
	add(cmeFuturesSession,
		"xyz:XYZ100", "xyz:SP500", "xyz:GOLD", "xyz:SILVER", "xyz:COPPER",
		"xyz:PLATINUM", "xyz:PALLADIUM", "xyz:CL", "xyz:NATGAS",
	)
	add(iceFuturesSession, "xyz:BRENTOIL")
	add(fxSession, "xyz:JPY", "xyz:EUR", "xyz:GBP")
	add(futuresSessionOverride["KR200"], "xyz:KR200")
	return out
}()

func MispricingInstrumentFor(coin string) (MispricingInstrument, bool) {
	v, ok := mispricingInstruments[coin]
	return v, ok
}

func MispricingInstrumentRegistry() map[string]MispricingInstrument {
	out := make(map[string]MispricingInstrument, len(mispricingInstruments))
	for coin, instrument := range mispricingInstruments {
		out[coin] = instrument
	}
	return out
}

func RegisteredMispricingDexes() []string {
	seen := map[string]bool{}
	for coin := range mispricingInstruments {
		dex := ""
		if i := strings.IndexByte(coin, ':'); i >= 0 {
			dex = coin[:i]
		}
		seen[dex] = true
	}
	out := make([]string, 0, len(seen))
	for dex := range seen {
		out = append(out, dex)
	}
	sort.Strings(out)
	return out
}

var calendarCoverage = map[string]map[int]bool{
	"us-cash": {2026: true, 2027: true}, "krx-cash": {2026: true, 2027: true},
	"tse-cash": {2026: true, 2027: true}, "hkex-cash": {2026: true, 2027: true},
	"sse-cash": {2026: true}, "cme": {2026: true, 2027: true},
	"krx-futures": {2026: true, 2027: true}, "fx": {2026: true, 2027: true},
}

// Full closures that materially differ from the ordinary weekday/weekend
// model. The compact table is intentionally data, not branching logic.
var calendarClosures = map[string]map[string]bool{
	"us-cash": {
		"2026-01-01": true, "2026-01-19": true, "2026-02-16": true, "2026-04-03": true,
		"2026-05-25": true, "2026-06-19": true, "2026-07-03": true, "2026-09-07": true,
		"2026-11-26": true, "2026-12-25": true, "2027-01-01": true, "2027-01-18": true,
		"2027-02-15": true, "2027-03-26": true, "2027-05-31": true, "2027-06-18": true,
		"2027-07-05": true, "2027-09-06": true, "2027-11-25": true, "2027-12-24": true,
	},
	"tse-cash": {
		"2026-01-01": true, "2026-01-02": true, "2026-01-12": true, "2026-02-11": true,
		"2026-02-23": true, "2026-03-20": true, "2026-04-29": true, "2026-05-04": true,
		"2026-05-05": true, "2026-05-06": true, "2026-07-20": true, "2026-08-11": true,
		"2026-09-21": true, "2026-09-22": true, "2026-09-23": true, "2026-10-12": true,
		"2026-11-03": true, "2026-11-23": true, "2026-12-31": true,
		"2027-01-01": true, "2027-01-11": true, "2027-02-11": true, "2027-02-23": true,
		"2027-03-22": true, "2027-04-29": true, "2027-05-03": true, "2027-05-04": true,
		"2027-05-05": true, "2027-07-19": true, "2027-08-11": true, "2027-09-20": true,
		"2027-09-23": true, "2027-10-11": true, "2027-11-03": true, "2027-11-23": true,
		"2027-12-31": true,
	},
	"hkex-cash": {
		"2026-01-01": true, "2026-02-17": true, "2026-02-18": true, "2026-02-19": true,
		"2026-04-03": true, "2026-04-06": true, "2026-04-07": true, "2026-05-01": true,
		"2026-05-25": true, "2026-06-19": true, "2026-07-01": true, "2026-10-01": true,
		"2026-10-19": true, "2026-12-25": true,
		"2027-01-01": true, "2027-02-08": true, "2027-02-09": true, "2027-03-26": true,
		"2027-03-29": true, "2027-04-05": true, "2027-05-13": true, "2027-06-09": true,
		"2027-07-01": true, "2027-09-16": true, "2027-10-01": true, "2027-10-08": true,
		"2027-12-27": true,
	},
	"sse-cash": {
		"2026-01-01": true, "2026-01-02": true,
		"2026-02-16": true, "2026-02-17": true, "2026-02-18": true, "2026-02-19": true,
		"2026-02-20": true, "2026-02-23": true, "2026-04-06": true,
		"2026-05-01": true, "2026-05-04": true, "2026-05-05": true,
		"2026-06-19": true, "2026-09-25": true, "2026-10-01": true,
		"2026-10-02": true, "2026-10-05": true, "2026-10-06": true, "2026-10-07": true,
	},
	// KRX closes on Korean public holidays, Labor Day, and its final business
	// day of the year. The dates below materialize those rules for the two
	// maintained years so runtime classification remains data-driven.
	"krx-cash": {
		"2026-01-01": true, "2026-02-16": true, "2026-02-17": true, "2026-02-18": true,
		"2026-03-02": true, "2026-05-01": true, "2026-05-05": true, "2026-05-25": true,
		"2026-08-17": true, "2026-09-24": true, "2026-09-25": true, "2026-09-28": true,
		"2026-10-05": true, "2026-10-09": true, "2026-12-25": true, "2026-12-31": true,
		"2027-01-01": true, "2027-02-05": true, "2027-02-08": true, "2027-03-01": true,
		"2027-05-05": true, "2027-05-13": true, "2027-08-16": true, "2027-09-14": true,
		"2027-09-15": true, "2027-09-16": true, "2027-10-04": true, "2027-10-11": true,
		"2027-12-27": true, "2027-12-31": true,
	},
}

var calendarEarlyCloses = map[string]map[string]string{
	"us-cash": {
		"2026-11-27": "13:00", "2026-12-24": "13:00", "2027-11-26": "13:00",
	},
	"hkex-cash": {
		"2026-02-16": "12:00", "2026-12-24": "12:00", "2026-12-31": "12:00",
		"2027-02-05": "12:00", "2027-12-24": "12:00", "2027-12-31": "12:00",
	},
}

// Some futures holiday hours vary by product family and are finalized close to
// the date. A generic session would risk declaring a market closed while its
// product is still trading, so those dates are conservatively omitted from the
// scanner instead of approximated.
var calendarUnsupportedDates = map[string]map[string]bool{
	"cme": {
		"2026-01-01": true, "2026-01-19": true, "2026-02-16": true, "2026-04-03": true,
		"2026-05-25": true, "2026-06-19": true, "2026-07-03": true, "2026-09-07": true,
		"2026-11-26": true, "2026-12-25": true, "2027-01-01": true, "2027-01-18": true,
		"2027-02-15": true, "2027-03-26": true, "2027-05-31": true, "2027-06-18": true,
		"2027-07-05": true, "2027-09-06": true, "2027-11-25": true, "2027-12-24": true,
	},
}

// SessionFor returns the exact registry session for canonical IDs. Bare symbols
// retain the generic resolver for callers outside the MISPRICE scanner.
func SessionFor(coin string) Session {
	if strings.Contains(coin, ":") {
		if instrument, ok := mispricingInstruments[coin]; ok {
			return instrument.Session
		}
	}
	sym := bareSymbol(coin)
	if sess, ok := futuresSessionOverride[sym]; ok {
		return sess
	}
	if futuresSymbols[sym] {
		return cmeFuturesSession
	}
	if sess, ok := symbolSession[sym]; ok {
		return sess
	}
	return usSession
}

// LastClose returns the UTC instant of the most recent completed regular-session
// close, respecting the maintained weekend, holiday, and early-close calendar.
// Returns false if the zone, time, or lookback can't be resolved.
func (s Session) LastClose(now time.Time) (time.Time, bool) {
	loc, ok := loadLocation(s.TZ)
	if !ok {
		return time.Time{}, false
	}
	local := now.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	if s.Kind == FuturesSession {
		return s.lastFuturesClose(local)
	}
	if s.Kind == ContinuousWeekSession {
		return s.lastContinuousWeekClose(local)
	}
	if s.Kind == SplitFuturesSession {
		return s.lastSplitFuturesClose(local)
	}
	// Walk back day-by-day to the most recent completed regular trading window.
	// Reconstruct via time.Date each step so the wall-clock close time stays
	// correct across DST transitions. 10 iterations covers any long weekend.
	for i := 0; i < 10; i++ {
		if isWeekday(day.Weekday()) && !s.calendarClosed(day) {
			windows, valid := s.windowsForDate(day)
			if !valid {
				return time.Time{}, false
			}
			for j := len(windows) - 1; j >= 0; j-- {
				candidate := windowTime(day, windows[j].CloseLocal)
				if !candidate.After(local) {
					return candidate.UTC(), true
				}
			}
		}
		day = day.AddDate(0, 0, -1)
	}
	return time.Time{}, false
}

// IsOpen reports whether the underlying market is currently trading across the
// cash-window, maintenance-futures, continuous-week, and split-futures models.
func (s Session) IsOpen(now time.Time) bool {
	loc, ok := loadLocation(s.TZ)
	if !ok {
		return false
	}
	local := now.In(loc)
	if s.calendarClosed(local) {
		return false
	}
	if s.Kind == FuturesSession {
		oh, om, ok1 := parseHHMM(s.OpenLocal)
		ch, cm, ok2 := parseHHMM(s.closeForDate(local))
		if !ok1 || !ok2 {
			return false
		}
		open := time.Date(local.Year(), local.Month(), local.Day(), oh, om, 0, 0, loc)
		close := time.Date(local.Year(), local.Month(), local.Day(), ch, cm, 0, 0, loc)
		return futuresIsOpen(local, open, close)
	}
	if s.Kind == ContinuousWeekSession {
		return continuousWeekIsOpen(local, s.OpenLocal, s.CloseLocal)
	}
	if s.Kind == SplitFuturesSession {
		return s.splitFuturesIsOpen(local)
	}
	if !isWeekday(local.Weekday()) {
		return false
	}
	windows, valid := s.windowsForDate(local)
	if !valid {
		return false
	}
	for _, window := range windows {
		if !local.Before(windowTime(local, window.OpenLocal)) &&
			local.Before(windowTime(local, window.CloseLocal)) {
			return true
		}
	}
	return false
}

// StateAt returns the current session state, the latest completed close, and
// whether the maintained calendar covers this date. Sessions constructed
// without a CalendarID retain the legacy weekday behavior for focused tests.
func (s Session) StateAt(now time.Time) (SessionState, time.Time, bool) {
	loc, ok := loadLocation(s.TZ)
	if !ok {
		return SessionOvernight, time.Time{}, false
	}
	local := now.In(loc)
	if s.CalendarID != "" && !calendarCoverage[s.CalendarID][local.Year()] {
		return SessionOvernight, time.Time{}, false
	}
	date := local.Format("2006-01-02")
	if calendarUnsupportedDates[s.CalendarID][date] ||
		(s.CalendarID == "krx-futures" && calendarClosures["krx-cash"][date]) {
		return SessionOvernight, time.Time{}, false
	}
	closeAt, ok := s.LastClose(now)
	if !ok {
		return SessionOvernight, time.Time{}, false
	}
	if s.IsOpen(now) {
		return SessionOpen, closeAt, true
	}
	if s.calendarClosed(local) {
		return SessionHoliday, closeAt, true
	}
	if local.Weekday() == time.Saturday || local.Weekday() == time.Sunday {
		return SessionWeekend, closeAt, true
	}
	if s.Kind == FuturesSession || s.Kind == SplitFuturesSession {
		return SessionMaintenance, closeAt, true
	}
	if s.Kind == EquitySession && s.duringIntermission(local) {
		return SessionIntermission, closeAt, true
	}
	return SessionOvernight, closeAt, true
}

func (s Session) calendarClosed(local time.Time) bool {
	if s.CalendarID == "" {
		return false
	}
	if s.CalendarID == "krx-futures" {
		return calendarClosures["krx-cash"][local.Format("2006-01-02")]
	}
	return calendarClosures[s.CalendarID][local.Format("2006-01-02")]
}

func (s Session) calendarUnsupported(local time.Time) bool {
	return calendarUnsupportedDates[s.CalendarID][local.Format("2006-01-02")]
}

func (s Session) closeForDate(local time.Time) string {
	if byDate := calendarEarlyCloses[s.CalendarID]; byDate != nil {
		if closeLocal := byDate[local.Format("2006-01-02")]; closeLocal != "" {
			return closeLocal
		}
	}
	if len(s.Windows) > 0 {
		return s.Windows[len(s.Windows)-1].CloseLocal
	}
	return s.CloseLocal
}

func (s Session) lastFuturesClose(local time.Time) (time.Time, bool) {
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	for i := 0; i < 10; i++ {
		if isWeekday(day.Weekday()) && !s.calendarClosed(day) && !s.calendarUnsupported(day) {
			candidate := windowTime(day, s.closeForDate(day))
			if !candidate.After(local) {
				return candidate.UTC(), true
			}
		}
		day = day.AddDate(0, 0, -1)
	}
	return time.Time{}, false
}

func (s Session) lastContinuousWeekClose(local time.Time) (time.Time, bool) {
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	for i := 0; i < 14; i++ {
		if day.Weekday() == time.Friday {
			candidate := windowTime(day, s.CloseLocal)
			if !candidate.After(local) {
				return candidate.UTC(), true
			}
		}
		day = day.AddDate(0, 0, -1)
	}
	return time.Time{}, false
}

func (s Session) lastSplitFuturesClose(local time.Time) (time.Time, bool) {
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, local.Location())
	for i := 0; i < 10; i++ {
		if isWeekday(day.Weekday()) && !s.calendarClosed(day) {
			var latest time.Time
			for _, window := range s.Windows {
				openMinute, openOK := hhmmMinute(window.OpenLocal)
				closeMinute, closeOK := hhmmMinute(window.CloseLocal)
				if !openOK || !closeOK {
					return time.Time{}, false
				}
				// An overnight window's close belongs to the prior calendar
				// day's session. Do not synthesize that close when the anchor
				// day was a maintained exchange holiday.
				if closeMinute < openMinute && s.calendarClosed(day.AddDate(0, 0, -1)) {
					continue
				}
				candidate := windowTime(day, window.CloseLocal)
				if !candidate.After(local) && candidate.After(latest) {
					latest = candidate
				}
			}
			if !latest.IsZero() {
				return latest.UTC(), true
			}
		}
		day = day.AddDate(0, 0, -1)
	}
	return time.Time{}, false
}

func (s Session) baseWindows() []SessionWindow {
	if len(s.Windows) > 0 {
		return s.Windows
	}
	if s.LunchStartLocal != "" && s.LunchEndLocal != "" {
		return []SessionWindow{
			{OpenLocal: s.OpenLocal, CloseLocal: s.LunchStartLocal},
			{OpenLocal: s.LunchEndLocal, CloseLocal: s.CloseLocal},
		}
	}
	return []SessionWindow{{OpenLocal: s.OpenLocal, CloseLocal: s.CloseLocal}}
}

func (s Session) windowsForDate(local time.Time) ([]SessionWindow, bool) {
	windows := append([]SessionWindow(nil), s.baseWindows()...)
	early := s.closeForDate(local)
	if early == "" {
		return nil, false
	}
	earlyMinute, ok := hhmmMinute(early)
	if !ok {
		return nil, false
	}
	out := windows[:0]
	for _, window := range windows {
		openMinute, openOK := hhmmMinute(window.OpenLocal)
		closeMinute, closeOK := hhmmMinute(window.CloseLocal)
		if !openOK || !closeOK || closeMinute <= openMinute {
			return nil, false
		}
		if openMinute >= earlyMinute {
			continue
		}
		if closeMinute > earlyMinute {
			window.CloseLocal = early
		}
		out = append(out, window)
	}
	return out, true
}

func (s Session) duringIntermission(local time.Time) bool {
	if !isWeekday(local.Weekday()) || s.calendarClosed(local) {
		return false
	}
	windows, ok := s.windowsForDate(local)
	if !ok || len(windows) < 2 {
		return false
	}
	for i := 0; i < len(windows)-1; i++ {
		if !local.Before(windowTime(local, windows[i].CloseLocal)) &&
			local.Before(windowTime(local, windows[i+1].OpenLocal)) {
			return true
		}
	}
	return false
}

func (s Session) splitFuturesIsOpen(local time.Time) bool {
	if len(s.Windows) != 2 {
		return false
	}
	day := s.Windows[0]
	night := s.Windows[1]
	dayOpen, dayOK := hhmmMinute(day.OpenLocal)
	dayClose, dayCloseOK := hhmmMinute(day.CloseLocal)
	nightOpen, nightOK := hhmmMinute(night.OpenLocal)
	nightClose, nightCloseOK := hhmmMinute(night.CloseLocal)
	if !dayOK || !dayCloseOK || !nightOK || !nightCloseOK {
		return false
	}
	minute := local.Hour()*60 + local.Minute()
	weekday := local.Weekday()
	if isWeekday(weekday) && minute >= dayOpen && minute < dayClose {
		return true
	}
	if weekday == time.Sunday || (weekday >= time.Monday && weekday <= time.Thursday) {
		if minute >= nightOpen {
			return true
		}
	}
	return isWeekday(weekday) && minute < nightClose &&
		!s.calendarClosed(local.AddDate(0, 0, -1))
}

func continuousWeekIsOpen(local time.Time, reopenLocal, closeLocal string) bool {
	reopen, reopenOK := hhmmMinute(reopenLocal)
	closeMinute, closeOK := hhmmMinute(closeLocal)
	if !reopenOK || !closeOK {
		return false
	}
	minute := local.Hour()*60 + local.Minute()
	switch local.Weekday() {
	case time.Saturday:
		return false
	case time.Sunday:
		return minute >= reopen
	case time.Friday:
		return minute < closeMinute
	default:
		return true
	}
}

func windowTime(day time.Time, hhmm string) time.Time {
	hh, mm, _ := parseHHMM(hhmm)
	return time.Date(day.Year(), day.Month(), day.Day(), hh, mm, 0, 0, day.Location())
}

func hhmmMinute(value string) (int, bool) {
	hh, mm, ok := parseHHMM(value)
	return hh*60 + mm, ok
}

// futuresIsOpen evaluates the near-24h futures calendar. open is the daily reopen
// (evening, e.g. 17:00) and close is the daily settlement (afternoon, e.g. 16:00),
// so open > close and the daily halt is [close, open). The market is shut on
// Saturday, before the Sunday reopen, after the Friday settlement, and during the
// Mon–Thu daily halt.
func futuresIsOpen(local, open, close time.Time) bool {
	switch local.Weekday() {
	case time.Saturday:
		return false
	case time.Sunday:
		return !local.Before(open) // open only after the Sunday reopen
	case time.Friday:
		return local.Before(close) // open until the Friday settlement
	default: // Mon–Thu: shut only during the daily settlement halt [close, open)
		return local.Before(close) || !local.Before(open)
	}
}

func isWeekday(d time.Weekday) bool {
	return d != time.Saturday && d != time.Sunday
}

// bareSymbol strips any dex prefix (e.g. "xyz:") and upper-cases the symbol.
func bareSymbol(coin string) string {
	if i := strings.LastIndex(coin, ":"); i >= 0 {
		coin = coin[i+1:]
	}
	return strings.ToUpper(coin)
}

// parseHHMM parses an "HH:MM" 24-hour string.
func parseHHMM(s string) (hh, mm int, ok bool) {
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	h := atoiSafe(parts[0])
	m := atoiSafe(parts[1])
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, 0, false
	}
	return h, m, true
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return -1
		}
		n = n*10 + int(r-'0')
	}
	if s == "" {
		return -1
	}
	return n
}

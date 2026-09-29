package exchange

import "testing"

func TestConfirmedCancelOidsReturnsPartialSuccess(t *testing.T) {
	resp := map[string]interface{}{
		"response": map[string]interface{}{
			"data": map[string]interface{}{
				"statuses": []interface{}{
					"success",
					map[string]interface{}{"error": "Order was never placed, already canceled, or filled."},
				},
			},
		},
	}
	got, err := confirmedCancelOids(resp, []int64{101, 202})
	if err == nil || len(got) != 1 || got[0] != 101 {
		t.Fatalf("got confirmed=%v err=%v", got, err)
	}
}

func TestRequireCancelStatusesNacksMissingStatuses(t *testing.T) {
	resp := map[string]interface{}{
		"status": "ok",
		"response": map[string]interface{}{
			"type": "cancel",
			"data": map[string]interface{}{},
		},
	}
	if err := requireCancelStatuses(resp, 1); err == nil {
		t.Fatal("missing statuses must fail a single cancel")
	}
}

func TestModifyOrderExecPxUsesTriggerSlippageForMarketTriggers(t *testing.T) {
	trigger := 100.0
	got := modifyOrderExecPx(true, true, false, 0, trigger, 1)
	want := triggerExecPrice(true, false, trigger, 1)
	if got != want {
		t.Fatalf("market trigger exec px = %v, want %v (not trigger %v)", got, want, trigger)
	}
	if got == trigger {
		t.Fatal("market trigger LimitPx must not equal the trigger")
	}
	if got := modifyOrderExecPx(false, true, true, 50, trigger, 1); got != 50 {
		t.Fatalf("plain modify exec px = %v, want 50", got)
	}
}

func TestConfirmedCancelOidsNacksMissingStatuses(t *testing.T) {
	resp := map[string]interface{}{
		"status": "ok",
		"response": map[string]interface{}{
			"type": "cancel",
			"data": map[string]interface{}{},
		},
	}
	got, err := confirmedCancelOids(resp, []int64{101})
	if err == nil || len(got) != 0 {
		t.Fatalf("missing statuses confirmed=%v err=%v, want nack", got, err)
	}
}

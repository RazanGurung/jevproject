package exchange

// Golden tests pinning the byte-level wire encoding and signing behavior of
// the forked Hyperliquid action pipeline. The expected JSON strings and
// signature values were recorded from go-hyperliquid v0.36.0 via transitional
// parity tests when the SDK dependency was removed (June 2026): the fork was
// proven byte-identical to the SDK, then these recordings froze that contract.
//
// If any of these fail after a refactor, the change altered what gets signed
// or sent to the exchange — do not update the expectations without verifying
// order placement against Hyperliquid with real (tiny) orders.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	"hyperliquid-go/internal/infrastructure/signing"
)

// Throwaway key for signature pinning only — never funded, never reused.
const goldenTestKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

const goldenNonce = int64(1749680000123)

var goldenExpiresAfter = int64(1749690000000)

func goldenStrPtr(s string) *string { return &s }

type goldenSig struct {
	R string
	S string
	V int
}

type goldenFixture struct {
	name   string
	action any
	json   string
	// signatures for variants: mainnet, testnet, mainnet+expiresAfter
	mainnet  goldenSig
	testnet  goldenSig
	expiring goldenSig
}

func goldenFixtures() []goldenFixture {
	scheduleTime := int64(1749700000000)

	return []goldenFixture{
		{
			name: "limit order GTC",
			action: OrderAction{
				Type: "order",
				Orders: []OrderWire{{
					Asset: 3, IsBuy: true, LimitPx: "63258.5", Size: "0.00158",
					ReduceOnly: false,
					OrderType:  OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifGtc}},
				}},
				Grouping: groupingNA,
			},
			json:     `{"type":"order","orders":[{"a":3,"b":true,"p":"63258.5","s":"0.00158","r":false,"t":{"limit":{"tif":"Gtc"}}}],"grouping":"na"}`,
			mainnet:  goldenSig{R: "0x8058feb15c209c3b3eddab1aebfb7e3967a41cbc9e0d278a5510c920f808dcdf", S: "0x2c85dc38e3c2dc9656602dedc838fad7cf686fe2bba3e33040da4a3bef9023a4", V: 28},
			testnet:  goldenSig{R: "0xcd77a4648186e95f5fdb72071f34e9d4bb2fbf1a2fd17d8607da4fd52bd3c732", S: "0x239851c687a44be9768b21521b2e62171fed5b90f48abe2516f7e1861fe20f78", V: 27},
			expiring: goldenSig{R: "0x48ea4bdeb14192e799927604bac6b85d129e259d924c2a6666c33bc94788c606", S: "0x99be241dd4d349704241182b06c4cc8d5e36558e4ba40e686ffca1e5a5a4cd9", V: 27},
		},
		{
			name: "market order IOC with cloid",
			action: OrderAction{
				Type: "order",
				Orders: []OrderWire{{
					Asset: 110029, IsBuy: false, LimitPx: "62626.2", Size: "1.5",
					ReduceOnly: true,
					OrderType:  OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifIoc}},
					Cloid:      goldenStrPtr("0x00000000000000000000000000000001"),
				}},
				Grouping: groupingNA,
			},
			json:     `{"type":"order","orders":[{"a":110029,"b":false,"p":"62626.2","s":"1.5","r":true,"t":{"limit":{"tif":"Ioc"}},"c":"0x00000000000000000000000000000001"}],"grouping":"na"}`,
			mainnet:  goldenSig{R: "0xba649ceda14acc0a690ba8d08493168feee8da7a0b5a1bd2c58b541d4d73ba34", S: "0x3e3df8b1497a8505b9b731493fd57288b7227893e130b942c8293df74ac6157f", V: 28},
			testnet:  goldenSig{R: "0x6891db0ce48b735617a2786bda7f47eb88f2404b5c8393fb736f7f1abffa226f", S: "0x534a2f7f1bad114ce41d755016eb8570c814c359104720a8600ac2cedc8f3465", V: 27},
			expiring: goldenSig{R: "0xbcec596172879d78ab0359c0693273d88d457bb0bdaeaf9092fe61d324fd36fc", S: "0x69243ca84ad6655d9d44a023750450a1e1276608cdd4e219f31c0b8c1e616c00", V: 28},
		},
		{
			name: "trigger order tp market",
			action: OrderAction{
				Type: "order",
				Orders: []OrderWire{{
					Asset: 0, IsBuy: false, LimitPx: "70000", Size: "0.001",
					ReduceOnly: true,
					OrderType: OrderWireType{Trigger: &OrderWireTypeTrigger{
						IsMarket: true, TriggerPx: "70000", Tpsl: TakeProfit,
					}},
				}},
				Grouping: groupingNA,
			},
			json:     `{"type":"order","orders":[{"a":0,"b":false,"p":"70000","s":"0.001","r":true,"t":{"trigger":{"isMarket":true,"triggerPx":"70000","tpsl":"tp"}}}],"grouping":"na"}`,
			mainnet:  goldenSig{R: "0xf9d675003f6cb0334f712236bb73ffdfcd5fb03238299007dccdbba3ec42221", S: "0x72dde5d0e4388b8d505d1ecc02bc673d683d2a64ede93e993b115d5eebb3e1c0", V: 28},
			testnet:  goldenSig{R: "0x731d586b8ab02fd520e4470487ffec700e3555ad161dec14ff5437c9ce198584", S: "0x3e87abb3cd303d87d64c5065d8bec702255848427a35ba7825850c6fe7bd9533", V: 28},
			expiring: goldenSig{R: "0x7c2572872aa8b9323a6577e2740a8b013d40b5e9e75f83d591ed0af5134f828d", S: "0x678619f75a0b73b5553ff5a51fb72ec45ced1247ef22f3ed17775bbd9a84ebdc", V: 27},
		},
		{
			name: "trigger order sl limit",
			action: OrderAction{
				Type: "order",
				Orders: []OrderWire{{
					Asset: 1, IsBuy: true, LimitPx: "2500.5", Size: "0.25",
					ReduceOnly: true,
					OrderType: OrderWireType{Trigger: &OrderWireTypeTrigger{
						IsMarket: false, TriggerPx: "2500.5", Tpsl: StopLoss,
					}},
				}},
				Grouping: groupingNA,
			},
			json:     `{"type":"order","orders":[{"a":1,"b":true,"p":"2500.5","s":"0.25","r":true,"t":{"trigger":{"isMarket":false,"triggerPx":"2500.5","tpsl":"sl"}}}],"grouping":"na"}`,
			mainnet:  goldenSig{R: "0x2d5a90a81328118369082e3b8cc3919240028831fb9c216df76e442cb95c2b4e", S: "0x6b57b0f76c66c8963ab7625f0fac68dac581b1f8fb185da8c14888f12590f3", V: 27},
			testnet:  goldenSig{R: "0xe2a799fe552345af679998cbb9b334ddfb9500d8e35032b5eeecaf1a515108b8", S: "0x1c391b4465da385570b39e09ea9f3476c2a25e69cda9ce9b9cf17726300760b2", V: 28},
			expiring: goldenSig{R: "0x7a7205f22f5315eff00b635ae7e14bd2bb22222233e07280e3efae79f46b1221", S: "0x4f050ea8491b32fadbc8bb44e00b835ff9e4cbff2f90e2616f8fda46b7ba6bfd", V: 28},
		},
		{
			name: "cancel",
			action: CancelAction{
				Type:    "cancel",
				Cancels: []CancelOrderWire{{Asset: 3, OrderID: 466144024433}, {Asset: 110029, OrderID: 12345}},
			},
			json:     `{"type":"cancel","cancels":[{"a":3,"o":466144024433},{"a":110029,"o":12345}]}`,
			mainnet:  goldenSig{R: "0x55a757a095d00f17b3537b33aca5293ae70907beb88b192b1310614263a6a4d1", S: "0x6cf4486481eca0f01ae8b86b4e01d5fc2fde6e8ea8c50adc541fda862b4367be", V: 27},
			testnet:  goldenSig{R: "0x74db0c0b0f88f4b3b200531160a9939a78229ca8687ba8a38d2eb1822cf56a3f", S: "0x6e1fce277095769f02a088705da177f16baa35d12646e67be57296917249fafb", V: 27},
			expiring: goldenSig{R: "0xc9c05e3d090e9eb16cc770e0de1eed1e6e3532ced5a891233209cad89931faac", S: "0x4efa3fe71ec9dcaac9c19049ad6cd8adee7666cc4a8255912272b3c2c6c3205f", V: 27},
		},
		{
			name: "cancelByCloid",
			action: CancelByCloidAction{
				Type:    "cancelByCloid",
				Cancels: []CancelByCloidWire{{Asset: 3, ClientID: "0x00000000000000000000000000000001"}},
			},
			json:     `{"type":"cancelByCloid","cancels":[{"asset":3,"cloid":"0x00000000000000000000000000000001"}]}`,
			mainnet:  goldenSig{R: "0x79837a58306a850f1bf5085c9b47e335aa1ce4581db376ae18bc943da4c2996c", S: "0x555b296ba7ce74e7e3ba74d04f748cec97727f9980a61a5b1cf0e505f8ae2e05", V: 28},
			testnet:  goldenSig{R: "0x5fbbd0be7d6506d72edf967317e0bb08cf77c4d014b5938454c0bfabb96c912a", S: "0x39ea4131a2e592505d4413d47742c3ebd6812dc76d75ba21499b83bbc93283de", V: 28},
			expiring: goldenSig{R: "0xab117ad38d9640f2ff03b2bea3be6beff8d26110bf6301cf9017078bedd7f414", S: "0x55c1dcdd15a7a9d668578b12c850d57c499bc1753fead06f76585f544479a235", V: 27},
		},
		{
			name: "batchModify",
			action: BatchModifyAction{
				Type: "batchModify",
				Modifies: []ModifyAction{{
					Oid: int64(466144024433),
					Order: OrderWire{
						Asset: 3, IsBuy: true, LimitPx: "63000", Size: "0.002",
						ReduceOnly: false,
						OrderType:  OrderWireType{Limit: &OrderWireTypeLimit{Tif: TifGtc}},
					},
				}},
			},
			json:     `{"type":"batchModify","modifies":[{"oid":466144024433,"order":{"a":3,"b":true,"p":"63000","s":"0.002","r":false,"t":{"limit":{"tif":"Gtc"}}}}]}`,
			mainnet:  goldenSig{R: "0x90cb485d75821b8bca1dd188f70e428b3c07b1125d64b56d7a47932bef564e88", S: "0x3f3ac6b699affc1ef2162f33b1177d7fe4b2d7c38fb213ae0099ca58fdcaf43f", V: 27},
			testnet:  goldenSig{R: "0xe353f0227a2ec4156d81427344f0b2d48b0de4aaeaaac1235e5fbb5d1ce9fd63", S: "0x51868b13365edb20942620fe5b94d8fefb4ba7eaf6866fe11b6e951d460f7813", V: 27},
			expiring: goldenSig{R: "0xc6c8c3660c329d7d47c348b43cccff523c9ee40a9aff1046238677b37cb1c1dd", S: "0x5344aec33332062862e669b82d2686be9df50546c662a51d579909db794232cf", V: 28},
		},
		{
			name:     "scheduleCancel with time",
			action:   ScheduleCancelAction{Type: "scheduleCancel", Time: &scheduleTime},
			json:     `{"type":"scheduleCancel","time":1749700000000}`,
			mainnet:  goldenSig{R: "0xa1941a1d5330561d38a0fec854c12244fb5a2be73b4185adb48574b9449df2f3", S: "0x454516e3f509903ee4cd1c076ed014d95b107a19c185a4121ac58a447be70811", V: 28},
			testnet:  goldenSig{R: "0xa6f237b9924a492a3ece58fa5efe1cf54d3e146802488300de25c7afbafa9b5e", S: "0x7b995ffc4c52d2969ca063a46e72e212c9870914f8eaeff7db91af4cc425b117", V: 28},
			expiring: goldenSig{R: "0xdd72acc8e1e68d5e45f8a91384a448475e56da5b2354c009323106703274c142", S: "0x5a7ffd6b36c53d30c3a09a161af6414dbb6ce1af8782d360ba29cbd8ef6ae899", V: 27},
		},
		{
			name:     "scheduleCancel without time",
			action:   ScheduleCancelAction{Type: "scheduleCancel"},
			json:     `{"type":"scheduleCancel"}`,
			mainnet:  goldenSig{R: "0xf12baee142b81a8afe089cad6c2add882dedf648cf2603092d4c336464120945", S: "0x229a85f277613ee524888a14847b5d958b49c066533477eb62c2e96d8eaf7504", V: 27},
			testnet:  goldenSig{R: "0x2ea56353768f5d22d02c38c8203b842b31f4ed8fa577f991ba6d225125c4b87c", S: "0x50de1e35e3fbb13f1dbb87134940ad237abdb3e8909503a406b1e80ea500e049", V: 28},
			expiring: goldenSig{R: "0x98a09394d05c9a59e15521cf856a96074e6f431c7831bc0288e5dddde844e84d", S: "0x11655d656d0f98221b725fff2768630f3da23eea4ba91373623a0c0f8bb997f0", V: 27},
		},
		{
			name:     "updateIsolatedMargin",
			action:   UpdateIsolatedMarginAction{Type: "updateIsolatedMargin", Asset: 3, IsBuy: true, Ntli: 12_500_000},
			json:     `{"type":"updateIsolatedMargin","asset":3,"isBuy":true,"ntli":12500000}`,
			mainnet:  goldenSig{R: "0x76e410758826cd2821631a9ff4b797d439edc98c06eff0da6ff5197c9b3529b3", S: "0x3fe464200e4a66321d1249ebfa7facbfec7737fe6cf3223ec9bb4d6bbda2e028", V: 27},
			testnet:  goldenSig{R: "0xfb7c5a3869c0609cc0664407604d57ccbdc8908e0e4af3ab3cf4b0b7ce24dfec", S: "0x45f9b262ffddd295106a5c2fbc2a4c1ac16ca0b3da39693ca2655dd0d9fe4bf1", V: 27},
			expiring: goldenSig{R: "0x2783d91c45f42b16321fee1529cded0dca57362ef0b3f54e5f9b5f8fc395e344", S: "0x7f20fdd6f839b699ef8b765b8588237eff5d9aff24c7cf99f5bc37cc3ae0c43f", V: 27},
		},
		{
			name:     "updateLeverage",
			action:   UpdateLeverageAction{Type: "updateLeverage", Asset: 3, IsCross: true, Leverage: 20},
			json:     `{"type":"updateLeverage","asset":3,"isCross":true,"leverage":20}`,
			mainnet:  goldenSig{R: "0xfd3a20ad21f6d34d692d6f93089167975d9512017082e4f4d509a8c4f5c2f2a6", S: "0x644df9e4a33222a918bf7b416103521e15d74bf4a97962d684a4269b5d263cf0", V: 28},
			testnet:  goldenSig{R: "0xc8fe9742921fb35616b0b9952500752d4b8871f8379018a2b61a8cc0c8406baa", S: "0x2f204f6339eb73d0ba00883a5fb569c7b4eda18a00e3bc5fdb37ddb128c15698", V: 27},
			expiring: goldenSig{R: "0x57e65d1c2fda3e7beab7a73ef972f1a5d9cd19faba9aece7bad19add7ccdf71e", S: "0x3a9f75b56fc85ff89d28c8956f59ae2ac1941bfb3e883bd92a7f7cf61f7d9eb9", V: 27},
		},
	}
}

func TestGoldenActionJSON(t *testing.T) {
	for _, fx := range goldenFixtures() {
		t.Run(fx.name, func(t *testing.T) {
			got, err := json.Marshal(fx.action)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != fx.json {
				t.Fatalf("wire JSON drifted from recorded golden:\ngot:  %s\nwant: %s", got, fx.json)
			}
		})
	}
}

func TestGoldenSignL1Action(t *testing.T) {
	key, err := crypto.HexToECDSA(goldenTestKey)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}

	for _, fx := range goldenFixtures() {
		for _, variant := range []struct {
			name    string
			expires *int64
			mainnet bool
			want    goldenSig
		}{
			{"mainnet", nil, true, fx.mainnet},
			{"testnet", nil, false, fx.testnet},
			{"mainnet expiring", &goldenExpiresAfter, true, fx.expiring},
		} {
			t.Run(fx.name+" "+variant.name, func(t *testing.T) {
				sig, err := signing.SignL1Action(key, fx.action, "", goldenNonce, variant.expires, variant.mainnet)
				if err != nil {
					t.Fatalf("sign: %v", err)
				}
				if sig.R != variant.want.R || sig.S != variant.want.S || sig.V != variant.want.V {
					t.Fatalf("signature drifted from recorded golden:\ngot:  %+v\nwant: %+v", sig, variant.want)
				}
			})
		}
	}
}

func TestSignedExchangeActionRejectsMaps(t *testing.T) {
	// Go map iteration order is random, so a map action's msgpack hash — and
	// therefore its signature — is nondeterministic and matches the exchange's
	// canonical field order only by luck. The pipeline must refuse it.
	h := NewHyperliquidAdapter()
	_, err := h.executeSignedExchangeAction(context.Background(), goldenTestKey, false,
		map[string]interface{}{"type": "updateLeverage", "asset": 3, "isCross": true, "leverage": 20})
	if err == nil || !strings.Contains(err.Error(), "typed structs") {
		t.Fatalf("expected map-action rejection, got err=%v", err)
	}
}

func TestGoldenSignUserSignedAction(t *testing.T) {
	key, err := crypto.HexToECDSA(goldenTestKey)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	sig, err := signing.SignUserSignedAction(key, map[string]any{
		"type":         "approveAgent",
		"agentAddress": "0xef492108b4beb6ce032f170749d4115281c7278a",
		"agentName":    "pez",
		"nonce":        goldenNonce,
	}, []apitypes.Type{
		{Name: "hyperliquidChain", Type: "string"},
		{Name: "agentAddress", Type: "address"},
		{Name: "agentName", Type: "string"},
		{Name: "nonce", Type: "uint64"},
	}, "HyperliquidTransaction:ApproveAgent", true)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	want := goldenSig{R: "0x4603b0b414de5626b251026ad4242f70a2756f149cff1bff2a4e1f25a84b71e6", S: "0x3eaad1834a0d8f532aa6db10fce7a5d58c9ff6d690718f5e5b49a5f88d5129b3", V: 28}
	if sig.R != want.R || sig.S != want.S || sig.V != want.V {
		t.Fatalf("signature drifted from recorded golden:\ngot:  %+v\nwant: %+v", sig, want)
	}
}

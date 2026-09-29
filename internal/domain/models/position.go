package models

type AccountRequest struct {
	Address string `json:"address"`
	Mainnet bool   `json:"mainnet"`
	Vault   string `json:"vault"`
	Force   bool   `json:"force"`
}

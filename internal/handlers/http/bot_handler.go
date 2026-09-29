package http

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"hyperliquid-go/internal/domain/models"
	"hyperliquid-go/internal/services"
)

type BotHandler struct {
	botService *services.BotService
}

func NewBotHandler(botService *services.BotService) *BotHandler {
	return &BotHandler{botService: botService}
}

func (h *BotHandler) Start(c *gin.Context) {
	var req models.BotStartRequest
	if !bindJSON(c, &req) {
		return
	}

	status, err := h.botService.Start(c.Request.Context(), loadPrivateKey(), req)
	if err != nil {
		respondError(c, http.StatusBadRequest, err)
		return
	}

	c.JSON(http.StatusOK, status)
}

func (h *BotHandler) Stop(c *gin.Context) {
	h.botService.Stop(c.Request.Context(), loadPrivateKey())
	respondStatusOK(c)
}

func (h *BotHandler) Status(c *gin.Context) {
	c.JSON(http.StatusOK, h.botService.Status())
}

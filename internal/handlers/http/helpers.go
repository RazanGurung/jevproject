package http

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
)

// bindJSON binds the request body into req. On error, it writes a 400
// response in the standard {"error": msg} shape and returns false.
func bindJSON(c *gin.Context, req any) bool {
	if err := c.ShouldBindJSON(req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body too large"})
			return false
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return false
	}
	return true
}

// respondError writes a JSON error response in the standard {"error": msg} shape.
func respondError(c *gin.Context, status int, err error) {
	c.JSON(status, gin.H{"error": err.Error()})
}

// respondStatusOK writes the standard {"status": "ok"} 200 response.
func respondStatusOK(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

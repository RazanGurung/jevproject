package streaming

type EventType string

const (
	EventOrderUpdate EventType = "orderUpdate"
)

type Event struct {
	Type    EventType
	Payload interface{}
}

type Publisher interface {
	Publish(event Event)
	Subscribe() <-chan Event
}

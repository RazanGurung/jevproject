// Price Feed - Event-driven price update system
// Provides throttled price updates to subscribed strategies

const PriceFeed = {
    // Subscribers
    subscribers: [],
    
    // Current state
    state: {
        coin: null,
        price: null,
        lastUpdate: 0
    },
    
    // Throttle config
    throttleMs: 1000,
    
    // Stale detection
    lastValidPrice: null,
    staleWarningThreshold: 15000, // 15s — allMids can arrive at irregular intervals
    lastResumeAt: 0,
    resumeSuppressMs: 3000,
    
    // Initialize
    init: function(config) {
        this.subscribers = [];
        this.state = { coin: null, price: null, lastUpdate: 0 };
        this.throttleMs = (config && config.throttleMs) || 1000;
        this.lastValidPrice = null;
        this.lastResumeAt = 0;
        this.resumeSuppressMs = (config && config.resumeSuppressMs) || 3000;
        return this;
    },
    
    // Subscribe
    subscribe: function(callback) {
        if (typeof callback !== 'function') return this;
        if (this.subscribers.indexOf(callback) === -1) {
            this.subscribers.push(callback);
        }
        return this;
    },
    
    // Unsubscribe
    unsubscribe: function(callback) {
        var idx = this.subscribers.indexOf(callback);
        if (idx > -1) this.subscribers.splice(idx, 1);
        return this;
    },
    
    // Clear subscribers
    clearSubscribers: function() {
        this.subscribers = [];
        return this;
    },
    
    // Update price
    update: function(coin, price, options) {
        var now = Date.now();
        var opts = options || {};
        var forceTimestampRefresh = opts.forceTimestampRefresh === true;
        var shouldNotify = opts.notify !== false;
        var coinChanged = this.state.coin !== coin;

        if (!forceTimestampRefresh && !coinChanged && this.state.price === price && price > 0) {
            this.lastValidPrice = price;
            this.state.lastUpdate = now;
            return this;
        }
        
        // Throttling is valid only within one coin's update stream. A coin
        // switch must publish immediately or strategy readers can pair the new
        // runtime coin with the previous coin's price until the next mid tick.
        if (!forceTimestampRefresh && !coinChanged && now - this.state.lastUpdate < this.throttleMs) return this;

        if (coinChanged) this.lastValidPrice = null;
        
        if (price > 0) {
            this.lastValidPrice = price;
        }
        
        this.state.coin = coin;
        this.state.price = price;
        this.state.lastUpdate = now;
        
        if (shouldNotify) {
            this.notify({ coin: coin, price: price, timestamp: now });
        }
        return this;
    },

    touch: function(coin, price, options) {
        return this.update(coin, price, Object.assign({}, options, {
            forceTimestampRefresh: true,
            suppressStaleWarning: true,
            notify: options && options.notify === true
        }));
    },

    markForegroundResume: function() {
        this.lastResumeAt = Date.now();
        return this;
    },
    
    // Notify subscribers
    notify: function(data) {
        this.subscribers.forEach(function(callback) {
            try { callback(data); } catch (e) { console.error('[PriceFeed] Error:', e); }
        });
    },
    
    // Check if price data is stale
    isStale: function() {
        if (this.lastValidPrice === null) return true;
        return Date.now() - this.state.lastUpdate > this.staleWarningThreshold;
    },
    
    // Get time since last valid update
    getTimeSinceUpdate: function() {
        return Date.now() - this.state.lastUpdate;
    },
    
    // Getters
    getCurrentPrice: function() { return this.state.price; },
    getCurrentCoin: function() { return this.state.coin; },
    getLastUpdate: function() { return this.state.lastUpdate; }
};

// Auto-init
PriceFeed.init();

// Still published on window for the strategy host bridge + classic-era consumers.
if (typeof window !== 'undefined') {
    window.PriceFeed = PriceFeed;
}

export { PriceFeed };

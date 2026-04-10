const config = require("../config");

class AdaptiveDelay {
  constructor() {
    this.mode = "normal"; // fast | normal | slow
    this.errorCount = 0;
    this.successCount = 0;
    this.windowSize = 10;
  }

  setMode(mode) {
    if (["fast", "normal", "slow"].includes(mode)) {
      this.mode = mode;
    }
  }

  recordSuccess() {
    this.successCount++;
    this.errorCount = Math.max(0, this.errorCount - 1);
    // Auto-adjust: if stable enough, try to speed up one notch
    if (this.successCount % this.windowSize === 0) {
      if (this.mode === "slow") this.mode = "normal";
    }
  }

  recordError() {
    this.errorCount++;
    this.successCount = 0;
    // Auto-adjust: slow down on repeated errors
    if (this.errorCount >= 3) {
      if (this.mode === "fast") this.mode = "normal";
      else if (this.mode === "normal") this.mode = "slow";
    }
  }

  get baseDelay() {
    return config.delay[this.mode] || config.delay.normal;
  }

  get jitter() {
    const { jitterMin, jitterMax } = config.delay;
    return Math.floor(Math.random() * (jitterMax - jitterMin + 1)) + jitterMin;
  }

  get nextDelay() {
    return this.baseDelay + this.jitter;
  }

  async wait() {
    const ms = this.nextDelay;
    await sleep(ms);
    return ms;
  }

  async waitBatch() {
    const { batchRestMin, batchRestMax } = config.queue;
    const ms =
      Math.floor(Math.random() * (batchRestMax - batchRestMin + 1)) +
      batchRestMin;
    await sleep(ms);
    return ms;
  }

  async waitRateLimit() {
    // Pause 30–60 seconds when rate limit suspected
    const ms = Math.floor(Math.random() * 30000) + 30000;
    await sleep(ms);
    return ms;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { AdaptiveDelay, sleep };

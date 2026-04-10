const config = require(”../config”);
const { AdaptiveDelay, sleep } = require(”./delay”);
const logger = require(”./logger”);

class CheckerQueue {
constructor() {
this.queue = [];
this.results = [];
this.running = false;
this.paused = false;
this.concurrency = config.queue.concurrency;
this.activeCount = 0;
this.delay = new AdaptiveDelay();
this.onProgress = null; // callback(done, total, result)
this.onComplete = null; // callback(results)
this._resolveAll = null;
}

setMode(mode) {
this.delay.setMode(mode);
}

enqueue(items) {
this.queue.push(…items);
}

pause() {
this.paused = true;
}

resume() {
this.paused = false;
this._tick();
}

get total() {
return this.queue.length + this.results.length + this.activeCount;
}

get done() {
return this.results.length;
}

clear() {
this.queue = [];
this.results = [];
this.running = false;
this.paused = false;
this.activeCount = 0;
}

/**

- Run all queued items using the provided processor function.
- @param {Function} processor - async (item) => result
- @returns {Promise<Array>}
  */
  async run(processor) {
  if (this.running) return;
  this.running = true;
  this.results = [];

```
return new Promise((resolve) => {
  this._resolveAll = resolve;
  this._tick(processor);
});
```

}

async _tick(processor) {
if (!this.running) return;

```
while (
  this.queue.length > 0 &&
  this.activeCount < this.concurrency &&
  !this.paused
) {
  const item = this.queue.shift();
  this.activeCount++;
  this._processItem(item, processor).finally(() => {
    this.activeCount--;
    this._tick(processor);
  });
}

if (this.queue.length === 0 && this.activeCount === 0 && this.running) {
  this.running = false;
  if (this._resolveAll) this._resolveAll(this.results);
}
```

}

async _processItem(item, processor) {
let attempt = 0;
const maxRetries = config.retry.maxRetries;

```
while (attempt <= maxRetries) {
  try {
    if (this.paused) {
      await this._waitForResume();
    }

    const result = await processor(item);
    this.delay.recordSuccess();
    this.results.push(result);

    if (this.onProgress) {
      this.onProgress(this.done, this.total, result);
    }

    // Batch rest every N results
    if (this.results.length % config.queue.batchSize === 0) {
      logger.info(`Batch of ${config.queue.batchSize} done, resting...`);
      await this.delay.waitBatch();
    } else {
      await this.delay.wait();
    }

    return result;
  } catch (err) {
    attempt++;
    this.delay.recordError();

    const isRateLimit =
      err?.message?.toLowerCase().includes("rate") ||
      err?.message?.toLowerCase().includes("limit") ||
      err?.output?.statusCode === 429;

    if (isRateLimit) {
      logger.warn("Rate limit suspected, pausing queue...");
      this.paused = true;
      await this.delay.waitRateLimit();
      this.paused = false;
      logger.info("Queue resumed after rate-limit pause.");
      continue;
    }

    if (attempt <= maxRetries) {
      const backoff = config.retry.backoff[attempt - 1] || 5000;
      logger.warn(
        `Retry ${attempt}/${maxRetries} for ${item.e164}, backoff ${backoff}ms`
      );
      await sleep(backoff);
    } else {
      const failResult = { ...item, waResult: null, error: err.message };
      this.results.push(failResult);
      if (this.onProgress) {
        this.onProgress(this.done, this.total, failResult);
      }
    }
  }
}
```

}

async _waitForResume() {
while (this.paused) {
await sleep(500);
}
}
}

module.exports = CheckerQueue;

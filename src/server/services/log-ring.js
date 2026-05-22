// SPSC ring buffer for panel：双模式
//   - drop-oldest：UI 流式 chunk 队列（满了丢最旧的，保持 UI 流畅）
//   - block：pino transport / 持久化日志（满了让 producer await，零丢失）
//
// 设计依据：Phase 6 PoC 99-crossfield-results.json#poc_results.04_ringbuf_chunk_queue
//   失配场景 drop-oldest fidelity 32%（丢 68%），block fidelity 100% / 阻塞累积 1401ms
//
// 用法：
//   const buf = new LogRing(1024, 'drop-oldest');   // UI 流式
//   const buf = new LogRing(8192, 'block');          // 日志
//   await buf.push(item);   // block 模式可能 await
//   const item = buf.pop(); // 空返 undefined
//
// 不依赖外部包，纯 Node ESM。

export class LogRing {
  constructor(capacity, mode = 'drop-oldest') {
    if (!Number.isInteger(capacity) || capacity < 2) {
      throw new RangeError('capacity must be integer >= 2');
    }
    if (mode !== 'drop-oldest' && mode !== 'block') {
      throw new TypeError('mode must be "drop-oldest" or "block"');
    }
    this.cap = capacity;
    this.mode = mode;
    this.buf = new Array(capacity);
    this.head = 0; // 读
    this.tail = 0; // 写
    this.size = 0;
    this.dropped = 0; // drop-oldest 累计丢弃数
    this._waiters = []; // block 模式下，等容量的 resolver
  }

  async push(item) {
    if (this.size < this.cap) {
      this.buf[this.tail] = item;
      this.tail = (this.tail + 1) % this.cap;
      this.size += 1;
      return true;
    }
    if (this.mode === 'drop-oldest') {
      this.buf[this.tail] = item;
      this.tail = (this.tail + 1) % this.cap;
      this.head = (this.head + 1) % this.cap;
      this.dropped += 1;
      return true;
    }
    // block 模式：等 pop 释放槽位
    await new Promise(resolve => this._waiters.push(resolve));
    return this.push(item);
  }

  pop() {
    if (this.size === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.cap;
    this.size -= 1;
    const w = this._waiters.shift();
    if (w) w();
    return item;
  }

  drain() {
    const out = [];
    while (this.size > 0) out.push(this.pop());
    return out;
  }

  stats() {
    return { capacity: this.cap, mode: this.mode, size: this.size, dropped: this.dropped, waiters: this._waiters.length };
  }
}

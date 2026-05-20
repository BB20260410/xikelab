// TaskGraph — Squad 模式的任务依赖图，含拓扑排序 + 找无依赖就绪任务 + 环检测

export class TaskGraph {
  constructor(tasks = []) {
    this.byId = new Map();
    for (const t of tasks) this.byId.set(t.id, t);
  }

  /** 检测环；返回 { ok, cycle } */
  detectCycle() {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map();
    for (const id of this.byId.keys()) color.set(id, WHITE);
    let cycle = null;

    // v0.43: stack 局部，每个外层 dfs 调用各自一份，避免跨调用残留
    const dfs = (id, stack) => {
      color.set(id, GRAY);
      stack.push(id);
      const node = this.byId.get(id);
      for (const dep of (node?.dependencies || [])) {
        if (!this.byId.has(dep)) continue;
        if (color.get(dep) === GRAY) {
          const ix = stack.indexOf(dep);
          cycle = ix >= 0 ? stack.slice(ix).concat(dep) : [dep];
          return false;
        }
        if (color.get(dep) === WHITE && !dfs(dep, stack)) return false;
      }
      color.set(id, BLACK);
      stack.pop();
      return true;
    };

    for (const id of this.byId.keys()) {
      if (color.get(id) === WHITE && !dfs(id, [])) return { ok: false, cycle };
    }
    return { ok: true };
  }

  /** 拓扑排序（Kahn 算法）；返回 task id 数组 */
  topoSort() {
    const inDeg = new Map();
    const adj = new Map();
    for (const t of this.byId.values()) {
      inDeg.set(t.id, 0);
      adj.set(t.id, []);
    }
    for (const t of this.byId.values()) {
      for (const dep of (t.dependencies || [])) {
        if (!this.byId.has(dep)) continue;
        inDeg.set(t.id, inDeg.get(t.id) + 1);
        adj.get(dep).push(t.id);
      }
    }
    const queue = [];
    for (const [id, d] of inDeg) if (d === 0) queue.push(id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const nxt of adj.get(id)) {
        inDeg.set(nxt, inDeg.get(nxt) - 1);
        if (inDeg.get(nxt) === 0) queue.push(nxt);
      }
    }
    return order;
  }

  /** 找当前可执行的 task：依赖都 done 且自己 status=pending */
  readyTasks() {
    const ready = [];
    for (const t of this.byId.values()) {
      if (t.status !== 'pending') continue;
      const deps = t.dependencies || [];
      const allDone = deps.every(d => {
        const dep = this.byId.get(d);
        return !dep || dep.status === 'done';
      });
      if (allDone) ready.push(t);
    }
    return ready;
  }

  /** 是否全部 done / escalated（终止条件） */
  allDoneOrTerminal() {
    for (const t of this.byId.values()) {
      if (t.status !== 'done' && t.status !== 'escalated') return false;
    }
    return true;
  }

  /** 给一个 task 设新状态 */
  setStatus(id, status) {
    const t = this.byId.get(id);
    if (t) t.status = status;
  }

  toArray() { return [...this.byId.values()]; }
}

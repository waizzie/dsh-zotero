/**
 * 会话级状态：面板里"当前选中的条目/标注"与"文献池"。
 * 仅存于 Host 进程内存；模型通过 zotero_selection 工具读取。
 */

export function createSessionState() {
  const buckets = new Map();
  const GLOBAL = '__global__';

  const bucket = (sessionId) => {
    const id = sessionId || GLOBAL;
    if (!buckets.has(id)) buckets.set(id, { items: [], annotations: [], note: '', updatedAt: 0 });
    return buckets.get(id);
  };

  return {
    sessionIdOf(exec) {
      const id = exec?.agent?.session?.id ?? exec?.sessionId ?? exec?.agent?.sessionId;
      return typeof id === 'string' && id.length > 0 ? id : GLOBAL;
    },
    get(sessionId) {
      const b = bucket(sessionId);
      return { sessionId: sessionId || GLOBAL, items: b.items.slice(), annotations: b.annotations.slice(), note: b.note, updatedAt: b.updatedAt };
    },
    set(sessionId, patch = {}) {
      const b = bucket(sessionId);
      if (Array.isArray(patch.items)) b.items = patch.items.slice(0, 200);
      if (Array.isArray(patch.annotations)) b.annotations = patch.annotations.slice(0, 500);
      if (typeof patch.note === 'string') b.note = patch.note.slice(0, 2000);
      b.updatedAt = Date.now();
      return this.get(sessionId);
    },
    clear(sessionId) {
      buckets.delete(sessionId || GLOBAL);
    },
  };
}

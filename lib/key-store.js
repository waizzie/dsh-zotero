/**
 * Zotero 本地写密钥的存取。
 * 优先用 DSH 的凭据服务（ctx.get('credentials') 的记录能力），不可用时退化为进程内内存。
 * 绝不把密钥写进配置文件。
 */

const RECORD_KEY = 'zotero-local-api-key';

export function createKeyStore(ctx) {
  let memory = null;

  const service = () => {
    try { return ctx.get?.('credentials') ?? null; } catch { return null; }
  };

  return {
    /** 同步读取当前密钥（工具执行路径上用，避免每次 await）。 */
    get() { return memory; },

    /** 从凭据服务恢复密钥（插件激活时调用一次）。 */
    async load() {
      const creds = service();
      if (!creds?.readRecord) return null;
      try {
        const rec = await creds.readRecord(RECORD_KEY);
        const key = rec?.payload?.key;
        if (typeof key === 'string' && key.length >= 32) memory = key;
      } catch { /* 读取失败按未授权处理 */ }
      return memory;
    },

    async save(key) {
      memory = key;
      const creds = service();
      if (!creds?.modifyRecord) return;
      try {
        await creds.modifyRecord(RECORD_KEY, async () => ({
          kind: 'grant',
          payload: { key, app: 'DSH Zotero', createdAt: new Date().toISOString() },
        }));
      } catch { /* 凭据服务写入失败不影响本次会话使用 */ }
    },

    async clear() {
      memory = null;
      const creds = service();
      if (!creds?.deleteRecord) return;
      try { await creds.deleteRecord(RECORD_KEY); } catch { /* noop */ }
    },

    /** 给模型/面板看的状态（绝不返回密钥本身）。 */
    async describe() {
      const creds = service();
      if (!creds?.describeRecord) return { configured: Boolean(memory), source: memory ? 'memory' : 'none' };
      try {
        const info = await creds.describeRecord(RECORD_KEY);
        return { ...info, configured: Boolean(info?.configured || memory) };
      } catch { return { configured: Boolean(memory), source: memory ? 'memory' : 'none' }; }
    },
  };
}

/**
 * Zotero 本地写密钥的存取。
 * 优先用 DSH 的凭据服务（ctx.get('credentials') 的记录能力），不可用时退化为进程内内存。
 * 绝不把密钥写进配置文件。
 *
 * ⚠️ 记录键**必须**是 `<scope>/<id>`，且两段各自匹配 `/^[a-z][a-z0-9-]*$/`
 * （DSH `@deepseek-ai/dsh-credentials` 的 `KEY_SEGMENT_PATTERN`）。
 *
 * 为什么这里要写这么多注释——踩过一次真实的整机事故（2026-11-04）：
 * 旧版写的是不带 `/` 的 `'zotero-local-api-key'`。DSH 的**写路径**只校验 payload、
 * 不校验键格式，所以写入时毫无异常；但**读路径** `parseRecords()` 会调用
 * `parseCredentialKey()` 并在**下一次启动**抛
 * `credential key "…" must be "<scope>/<id>"`，导致 credentials 插件激活失败
 * → 依赖它的 12 个插件全部 pending → `dsh: startup failed`，只能 safe mode 进入。
 *
 * 参考 DSH 自己的命名：`client-connection/browser-session`、`deepseek-account-platform/default`。
 * scope 取本包名（`dsh-zotero`），id 取用途（`local-api-key`）。
 *
 * 为什么不用官方 `credentialKey()` 校验：`@deepseek-ai/dsh-credentials` 在插件侧**解析不到**
 * （从包目录与 profile 目录 `import` 均 `ERR_MODULE_NOT_FOUND`），静态 import 会让插件直接
 * 装载失败。所以这里内联同一份 grammar 做等价校验——语义与 `credentialKey(scope, id)` 一致。
 * `plugin-confirm` 自检脚本会对这种写法报一条 WARN（"没有用 credentialKey() 校验键"），
 * 属预期取舍，不是缺陷。
 */

export const RECORD_KEY = 'dsh-zotero/local-api-key';

const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/;

// 早失败：常量写错时在**插件激活**阶段就报错，而不是先写进磁盘、等下次开机才炸。
{
  const segments = RECORD_KEY.split('/');
  if (segments.length !== 2 || !segments.every((s) => KEY_SEGMENT.test(s))) {
    throw new Error(
      `dsh-zotero: 凭据记录键 "${RECORD_KEY}" 不符合 DSH 的 <scope>/<id> 格式（每段须匹配 ${KEY_SEGMENT}）`,
    );
  }
}

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

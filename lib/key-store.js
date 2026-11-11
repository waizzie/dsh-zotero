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
 */

export const RECORD_KEY = 'dsh-zotero/local-api-key';

const KEY_SEGMENT = /^[a-z][a-z0-9-]*$/;

/**
 * 按 DSH 的 grammar 校验凭据记录键：恰好两段 `<scope>/<id>`，每段匹配 `^[a-z][a-z0-9-]*$`。
 * 纯函数，便于单测直接调用。
 * @param {string} key 待校验的键
 * @returns {string} 原样返回
 * @throws {Error} 键不合规
 */
export function assertCredentialKey(key) {
  const segments = String(key).split('/');
  if (segments.length !== 2 || !segments.every((s) => KEY_SEGMENT.test(s))) {
    throw new Error(
      `dsh-zotero: 凭据记录键 "${key}" 不符合 DSH 的 <scope>/<id> 格式（每段须匹配 ${KEY_SEGMENT}）`,
    );
  }
  return key;
}

export function createKeyStore(ctx, log) {
  let memory = null;

  // 校验在激活路径上做，但**不抛错**（DSH 要求 apply 不得同步抛错，否则条目直接 failed）：
  // 常量写错时记为问题、拒绝一切持久化，并在日志里喊出来——坏键绝不能落盘。
  let keyProblem = null;
  try { assertCredentialKey(RECORD_KEY); } catch (err) { keyProblem = err; }

  const service = () => {
    try { return ctx.get?.('credentials') ?? null; } catch { return null; }
  };

  const recordKey = () => {
    if (keyProblem) {
      try { log?.(`凭据记录键不可用，已禁用持久化：${keyProblem.message}`); } catch { /* 日志非必需 */ }
      return null;
    }
    return RECORD_KEY;
  };

  const store = {
    /** 同步读取当前密钥（工具执行路径上用，避免每次 await）。 */
    get() { return memory; },

    /** 从凭据服务恢复密钥（插件激活时调用一次）。
     *
     * 这里**不能再静默吞错**：2026-11-11 的真实故障是重启后 load 没恢复出密钥，
     * 而错误被 catch 掉，表现为状态栏「写授权：未授权」，删除高亮却只报一句
     * 「写授权无效或已过期」，完全看不出是本地没读到 key。所以每条失败分支
     * 都要留一行日志，方便下次直接从 desktop-next.log 定位。
     */
    async load() {
      const creds = service();
      const rk = recordKey();
      if (!creds?.readRecord || !rk) {
        try {
          log?.(
            `未能读取写密钥：${creds ? '凭据服务缺少 readRecord' : 'ctx.get("credentials") 返回空'}`
            + '——本次会话的写操作会在首次请求时向 Zotero 重新申请授权',
          );
        } catch { /* 日志非必需 */ }
        return null;
      }
      try {
        const rec = await creds.readRecord(rk);
        const key = rec?.payload?.key;
        if (typeof key === 'string' && key.length >= 32) {
          memory = key;
        } else {
          try { log?.(`凭据记录 ${rk} 存在但没有可用 key（payload.key 缺失或长度不足）`); } catch { /* noop */ }
        }
      } catch (e) {
        try { log?.(`读取凭据记录 ${rk} 失败：${e?.message ?? e}`); } catch { /* noop */ }
      }
      return memory;
    },

    async save(key) {
      memory = key;
      const creds = service();
      const rk = recordKey();
      if (!creds?.modifyRecord || !rk) return;
      try {
        await creds.modifyRecord(rk, async () => ({
          kind: 'grant',
          payload: { key, app: 'DSH Zotero', createdAt: new Date().toISOString() },
        }));
      } catch { /* 凭据服务写入失败不影响本次会话使用 */ }
    },

    async clear() {
      memory = null;
      const creds = service();
      const rk = recordKey();
      if (!creds?.deleteRecord || !rk) return;
      try { await creds.deleteRecord(rk); } catch { /* noop */ }
    },

    /** 给模型/面板看的状态（绝不返回密钥本身）。 */
    async describe() {
      const creds = service();
      const rk = recordKey();
      if (!creds?.describeRecord || !rk) return { configured: Boolean(memory), source: memory ? 'memory' : 'none' };
      try {
        const info = await creds.describeRecord(rk);
        return { ...info, configured: Boolean(info?.configured || memory) };
      } catch { return { configured: Boolean(memory), source: memory ? 'memory' : 'none' }; }
    },

    /** 写操作前的补救：内存里还没有密钥时，再向凭据服务要一次。
     *
     * 激活时的 load() 可能早于凭据服务就绪（重启后尤其明显），失败一次就再没有
     * 第二次机会。写路径在动手前调一下这里，能把「明明有授权却报未授权」的
     * 情况就地修好，省掉一次 401 + 重新授权的往返。
     */
    async ensureLoaded() {
      if (memory) return memory;
      return await store.load();
    },
  };
  return store;
}

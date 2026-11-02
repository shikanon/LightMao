import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Plug,
  Plus,
  FileCode,
  Globe,
  ShieldCheck,
  RefreshCw,
  Trash2,
  Pencil,
  FolderOpen,
} from 'lucide-react';
import type { McpPlugin, McpFileGrant } from '../../../../packages/shared/types';
import { useWorkspace } from '../context';
import { api as get, api, post, patch } from '../api';
import { hasDesktopActions, selectMcpFile } from '../desktop';
import { Modal, Empty, Spinner, Status } from '../components/UI';

function secretObject(text: string) {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== 'string')
  )
    throw new Error('凭据须为 JSON 对象，所有值均为字符串');
  return value;
}
function McpEditor({
  projectId,
  plugin,
  onClose,
  onSaved,
}: {
  projectId: string;
  plugin?: McpPlugin;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const w = useWorkspace();
  const [transport, setTransport] = useState<'stdio' | 'http'>(plugin?.transport || 'stdio');
  const [grant, setGrant] = useState<McpFileGrant>(),
    [busy, setBusy] = useState(false),
    [choosing, setChoosing] = useState(false);
  async function choose() {
    setChoosing(true);
    try {
      const selected = await w.perform(() => selectMcpFile(projectId));
      if (selected) setGrant(selected);
    } finally {
      setChoosing(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      const result = await w.perform(
        async () => {
          const common = {
            name: String(form.get('name') || '').trim(),
            access: String(form.get('access')),
            domains:
              transport === 'stdio'
                ? String(form.get('domains') || '')
                    .split(/[,，\s]+/)
                    .filter(Boolean)
                : [],
            ...(transport === 'http'
              ? { endpoint: String(form.get('endpoint') || '').trim() }
              : {}),
            ...(String(form.get('credentials') || '').trim()
              ? {
                  [transport === 'stdio' ? 'env' : 'headers']: secretObject(
                    String(form.get('credentials')),
                  ),
                }
              : {}),
          };
          const value = plugin
            ? await patch<McpPlugin>(`/local/mcp-plugins/${plugin.id}`, common)
            : await post<McpPlugin>('/local/mcp-plugins', {
                ...common,
                projectId,
                transport,
                ...(grant ? { grantId: grant.grantId } : {}),
              });
          await onSaved();
          return value;
        },
        plugin ? '连接已保存，请重新探测并授权工具' : '插件已添加，探测工具后可选择授权',
      );
      if (result) onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={plugin ? '编辑 MCP 连接' : '添加 MCP 连接'}
      description="连接仅用于当前项目，默认不启用任何工具。"
      onClose={onClose}
    >
      <form className="form-stack" onSubmit={(event) => void save(event)}>
        <label>
          连接名称
          <input
            name="name"
            defaultValue={plugin?.name}
            maxLength={60}
            required
            placeholder="例如：游戏素材工具"
          />
        </label>
        {!plugin && (
          <label>
            连接方式
            <select
              value={transport}
              onChange={(e) => {
                setTransport(e.target.value as 'stdio' | 'http');
                setGrant(undefined);
              }}
              aria-label="MCP 连接方式"
            >
              <option value="stdio">本地插件文件</option>
              <option value="http">远程 Streamable HTTP</option>
            </select>
          </label>
        )}
        {transport === 'stdio' ? (
          <div className="mcp-file-picker">
            <FileCode size={22} />
            <div>
              <strong>
                {grant?.filename || plugin?.filename || '选择自包含的 JavaScript 文件'}
              </strong>
              <small>
                {grant
                  ? `${(grant.bytes / 1024).toFixed(1)} KB · SHA-256 ${grant.sha256.slice(0, 12)}…`
                  : '支持 .cjs / .mjs，最多 5 MB；依赖须提前打包。'}
              </small>
            </div>
            {!plugin && (
              <button
                type="button"
                className="button secondary small-button"
                disabled={!hasDesktopActions() || choosing || busy}
                onClick={() => void choose()}
              >
                <FolderOpen size={15} />
                {choosing ? '选择中…' : '选择文件'}
              </button>
            )}
            {!hasDesktopActions() && !plugin && (
              <p className="form-hint">本地文件需在桌面端选择。浏览器可添加远程连接。</p>
            )}
          </div>
        ) : (
          <label>
            服务地址
            <input
              name="endpoint"
              defaultValue={plugin?.endpoint}
              type="url"
              required
              placeholder="https://example.com/mcp"
            />
            <small>HTTPS 服务，或本机回环 HTTP；不接受重定向和地址中的凭据。</small>
          </label>
        )}
        <label>
          授权范围
          <select name="access" defaultValue={plugin?.access || 'read'} aria-label="MCP 授权范围">
            <option value="read">只读工具</option>
            <option value="write">允许具有副作用的工具</option>
          </select>
          <small>
            {transport === 'stdio'
              ? '本地插件仅能访问当前项目。写入还需项目本身已授权读写。'
              : '远程工具的只读属性由服务方声明，实际执行行为由服务方负责。'}
          </small>
        </label>
        {transport === 'stdio' && (
          <label>
            允许访问的域名
            <input
              name="domains"
              defaultValue={plugin?.domains.join(', ')}
              placeholder="留空表示不联网；多个域名用逗号分隔"
            />
            <small>域名放行涵盖该域名的端口及路径，请仅添加插件所需的服务。</small>
          </label>
        )}
        <label>
          {transport === 'stdio' ? '插件专用环境变量（JSON，可选）' : '请求头（JSON，可选）'}
          <textarea
            key={transport}
            name="credentials"
            rows={3}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              transport === 'stdio' ? '{"SERVICE_API_KEY":"…"}' : '{"Authorization":"Bearer …"}'
            }
          />
          <small>
            {plugin?.hasCredentials
              ? '已保存凭据，不回显。留空保留，填写 {} 清除。'
              : '仅保存在本机加密配置中；不会自动传入方舟、云盘或登录凭据。'}
          </small>
        </label>
        <footer>
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="button primary"
            disabled={busy || choosing || (!plugin && transport === 'stdio' && !grant)}
          >
            {busy && <Spinner />}
            {plugin ? '保存连接' : '添加连接'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function McpReview({
  plugin,
  onClose,
  onApproved,
}: {
  plugin: McpPlugin;
  onClose: () => void;
  onApproved: () => Promise<void>;
}) {
  const w = useWorkspace(),
    [selected, setSelected] = useState(plugin.approvedTools),
    [busy, setBusy] = useState(false);
  async function approve() {
    setBusy(true);
    try {
      const result = await w.perform(async () => {
        const value = await post<McpPlugin>(`/local/mcp-plugins/${plugin.id}/approve`, {
          catalogHash: plugin.catalogHash,
          tools: selected,
        });
        await onApproved();
        return value;
      }, '已启用所选 MCP 工具');
      if (result) onClose();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`授权工具 · ${plugin.name}`}
      description={`${plugin.tools.length} 个工具 · 仅对当前项目生效`}
      onClose={onClose}
      wide
    >
      <div className="setting-note">
        <ShieldCheck size={17} />
        <p>
          {plugin.transport === 'stdio'
            ? `本地进程${plugin.access === 'read' ? '只读' : '可读写'}当前项目，${plugin.domains.length ? `可联网至：${plugin.domains.join('、')}` : '不联网'}。探测会运行插件；仅勾选需要的工具。`
            : '以下名称、描述和只读属性由远程服务提供。所选工具可能向服务方发送调用参数，请核对服务及用途。'}
        </p>
      </div>
      <div className="mcp-review-toolbar">
        <button
          className="text-button"
          onClick={() => setSelected(plugin.tools.filter((t) => t.readOnly).map((t) => t.name))}
        >
          选择声明为只读的工具
        </button>
        <span>{selected.length} 项已选</span>
      </div>
      <div className="mcp-tool-list">
        {plugin.tools.map((tool) => {
          const blocked = plugin.access === 'read' && !tool.readOnly;
          return (
            <article key={tool.name}>
              <label className="mcp-tool-choice">
                <input
                  type="checkbox"
                  disabled={busy || blocked}
                  checked={selected.includes(tool.name)}
                  onChange={() =>
                    setSelected((values) =>
                      values.includes(tool.name)
                        ? values.filter((n) => n !== tool.name)
                        : [...values, tool.name],
                    )
                  }
                />
                <span>
                  <strong>{tool.name}</strong>
                  <small>
                    {blocked
                      ? '需更改授权范围后重新探测'
                      : tool.readOnly
                        ? '服务声明：只读'
                        : '可能产生副作用'}
                  </small>
                </span>
              </label>
              <p>{tool.description || '未提供描述'}</p>
              <details>
                <summary>参数结构</summary>
                <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
              </details>
            </article>
          );
        })}
      </div>
      {!plugin.tools.length && <p className="form-hint">服务未提供工具，无法启用。</p>}
      <footer>
        <button className="button secondary" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          className="button primary"
          disabled={busy || !selected.length}
          onClick={() => void approve()}
        >
          {busy && <Spinner />}允许并启用所选工具
        </button>
      </footer>
    </Modal>
  );
}
export function McpPlugins() {
  const w = useWorkspace();
  const projects = w.local.projects.filter(
    (p) => p.status !== 'archived' && p.access !== 'revoked',
  );
  const [projectId, setProjectId] = useState(
    () => projects.find((p) => p.id === w.session?.projectId)?.id || projects[0]?.id || '',
  );
  const [items, setItems] = useState<McpPlugin[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [pending, setPending] = useState('');
  const [editor, setEditor] = useState<{ plugin?: McpPlugin }>(),
    [review, setReview] = useState<McpPlugin>(),
    [remove, setRemove] = useState<McpPlugin>();
  const closeEditor = useCallback(() => setEditor(undefined), []),
    closeReview = useCallback(() => setReview(undefined), []),
    closeRemove = useCallback(() => setRemove(undefined), []);
  const load = useCallback(async () => {
    if (!projectId) {
      setItems([]);
      return;
    }
    const values = await get<McpPlugin[]>(
      `/local/mcp-plugins?projectId=${encodeURIComponent(projectId)}`,
    );
    setItems(values);
  }, [projectId]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setItems([]);
    if (!projectId) {
      setLoading(false);
      return;
    }
    void get<McpPlugin[]>(`/local/mcp-plugins?projectId=${encodeURIComponent(projectId)}`)
      .then((values) => {
        if (active) setItems(values);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  async function probe(plugin: McpPlugin) {
    setPending(plugin.id);
    try {
      const value = await w.perform(async () => {
        try {
          return await post<McpPlugin>(`/local/mcp-plugins/${plugin.id}/probe`, {});
        } finally {
          await load();
        }
      });
      if (value) setReview(value);
    } finally {
      setPending('');
    }
  }
  async function disable(plugin: McpPlugin) {
    setPending(plugin.id);
    try {
      await w.perform(async () => {
        await patch(`/local/mcp-plugins/${plugin.id}`, { enabled: false });
        await load();
      }, '插件已停用');
    } finally {
      setPending('');
    }
  }
  async function uninstall() {
    if (!remove) return;
    setPending(remove.id);
    try {
      const ok = await w.perform(async () => {
        await api(`/local/mcp-plugins/${remove.id}`, { method: 'DELETE' });
        await load();
        return true;
      }, 'MCP 插件已卸载');
      if (ok) setRemove(undefined);
    } finally {
      setPending('');
    }
  }
  return (
    <section className="mcp-section">
      <div className="mcp-toolbar">
        <label>
          项目
          <select
            value={projectId}
            disabled={!!pending}
            aria-label="MCP 所属项目"
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button primary"
          disabled={!projectId || !!pending}
          onClick={() => setEditor({})}
        >
          <Plus size={16} />
          添加 MCP 连接
        </button>
      </div>
      <div className="setting-note">
        <ShieldCheck size={17} />
        <p>
          先添加连接并探测，再逐项启用工具。插件调用过程默认折叠，完整结果独立归档，主对话接收有界摘要。
        </p>
      </div>
      {loading ? (
        <div className="mcp-loading">
          <Spinner />
          读取连接…
        </div>
      ) : error ? (
        <Empty
          icon={<Plug size={25} />}
          title="连接列表暂时不可用"
          description={error}
          action={
            <button className="button secondary" onClick={() => void w.perform(load)}>
              重试
            </button>
          }
        />
      ) : !items.length ? (
        <Empty
          icon={<Plug size={28} />}
          title="把开发工具，接入当前项目。"
          description="导入本地 MCP 文件，或连接远程 Streamable HTTP 服务。启用的工具会出现在 Agent 会话中。"
        />
      ) : (
        <div className="mcp-connection-list">
          {items.map((plugin) => (
            <article className="mcp-connection" key={plugin.id}>
              <div className="mcp-connection-heading">
                <div className="plugin-icon lavender">
                  {plugin.transport === 'stdio' ? <FileCode size={23} /> : <Globe size={23} />}
                </div>
                <div>
                  <h2>{plugin.name}</h2>
                  <small>{plugin.transport === 'stdio' ? plugin.filename : plugin.endpoint}</small>
                </div>
                <Status
                  tone={
                    plugin.enabled ? 'green' : plugin.lastProbe?.ok === false ? 'orange' : 'neutral'
                  }
                >
                  {plugin.enabled ? '已启用' : plugin.lastProbe?.ok === false ? '需处理' : '未启用'}
                </Status>
              </div>
              <div className="mcp-permissions">
                <span>{plugin.access === 'read' ? '只读工具' : '允许副作用'}</span>
                <span>
                  {plugin.transport === 'http'
                    ? '远程服务'
                    : plugin.domains.length
                      ? `${plugin.domains.length} 个联网域名`
                      : '不联网'}
                </span>
                <span>
                  {plugin.approvedTools.length}/{plugin.tools.length} 个工具已选
                </span>
                {plugin.hasCredentials && <span>已保存专用凭据</span>}
              </div>
              {plugin.lastProbe?.error && <p className="mcp-error">{plugin.lastProbe.error}</p>}
              <footer>
                <button
                  className="text-button"
                  disabled={!!pending}
                  onClick={() => setEditor({ plugin })}
                >
                  <Pencil size={14} />
                  编辑连接
                </button>
                <button
                  className="text-button mcp-remove"
                  disabled={!!pending}
                  onClick={() => setRemove(plugin)}
                >
                  <Trash2 size={14} />
                  卸载
                </button>
                <div />
                {plugin.enabled && (
                  <button
                    className="button secondary small-button"
                    disabled={!!pending}
                    onClick={() => void disable(plugin)}
                  >
                    停用
                  </button>
                )}
                <button
                  className="button secondary small-button"
                  disabled={!!pending}
                  onClick={() => void probe(plugin)}
                >
                  {pending === plugin.id ? <Spinner /> : <RefreshCw size={14} />}探测并授权
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
      <p className="collection-footnote">
        本地插件须自包含，不运行安装脚本。项目目录或权限变更后需重新授权。每个项目最多启用 24 个 MCP
        工具。
      </p>
      {editor && (
        <McpEditor
          projectId={projectId}
          plugin={editor.plugin}
          onClose={closeEditor}
          onSaved={load}
        />
      )}
      {review && <McpReview plugin={review} onClose={closeReview} onApproved={load} />}
      {remove && (
        <Modal title="卸载 MCP 插件" description={remove.name} onClose={closeRemove}>
          <p>停止当前插件连接并移除配置，已有会话和执行记录保留。</p>
          <footer>
            <button className="button secondary" onClick={closeRemove} disabled={!!pending}>
              取消
            </button>
            <button
              className="button danger-quiet"
              disabled={!!pending}
              onClick={() => void uninstall()}
            >
              确认卸载
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}

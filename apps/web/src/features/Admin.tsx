import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Users,
  Box,
  Activity,
  HardDrive,
  ArrowLeft,
  ShieldCheck,
  RefreshCw,
  Search,
  Copy,
} from 'lucide-react';
import { api, patch, currentAuthUser } from '../api';
import { copyText } from '../clipboard';
import { useWorkspace } from '../context';
import { CapabilityModels } from './CapabilityModels';
import { MAX_CONFIGURED_OUTPUT, modelDefaults } from '../../../../packages/shared/model-budget';
import {
  PageHeading,
  Status,
  Toggle,
  formatSize,
  formatTime,
  Empty,
  Spinner,
  SearchBox,
  Modal,
} from '../components/UI';
import type {
  User,
  AdminOverview,
  AdminPage,
  AdminUsage,
  AdminAudit,
  AdminPlugin,
  ModelConfig,
} from '../../../../packages/shared/types';

const tabs = ['用户管理', '模型配置', '插件目录', '调用记录', '审计日志'] as const;
const statusName = (status: string) =>
  ({
    running: '进行中',
    submitted: '任务已提交',
    unknown: '结果未确认',
    completed: '已完成',
    cancelled: '已取消',
    failed: '失败',
    interrupted: '结果未确认',
  })[status] || (/^upstream_\d+$/.test(status) ? `上游 HTTP ${status.slice(9)}` : status);
const failureName: Record<string, string> = {
  upstream_error: '上游拒绝请求，请核对模型权限、额度与配置。',
  network_error: '请求未完成，请检查后端到方舟的网络。',
  stream_incomplete: '响应流未收到完成标记，结果不能视为完整。',
  client_cancelled: '客户端在完成前断开或取消请求。',
  timeout: '请求超过服务端时限，结果未确认。',
};
type Mutate = (id: string, work: () => Promise<unknown>, message: string) => void;

function useAdminPage<T>(endpoint: string, filters: string, version: number) {
  const owner = currentAuthUser();
  const signature = JSON.stringify([endpoint, filters, version, owner]);
  const [position, setPosition] = useState<{ signature: string; stack: (string | undefined)[] }>({
    signature,
    stack: [undefined],
  });
  const stack = position.signature === signature ? position.stack : [undefined];
  const cursor = stack.at(-1),
    key = JSON.stringify([signature, cursor]);
  const [result, setResult] = useState<{ key: string; data?: AdminPage<T>; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const query = new URLSearchParams(filters);
    query.set('limit', '25');
    if (cursor) query.set('cursor', cursor);
    void api<AdminPage<T>>(`${endpoint}?${query}`, { signal: controller.signal })
      .then((data) => {
        if (active && currentAuthUser() === owner) setResult({ key, data });
      })
      .catch((error) => {
        if (active && currentAuthUser() === owner) setResult({ key, error: error.message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [endpoint, filters, cursor, key, owner]);
  const value = result?.key === key ? result : undefined;
  return {
    data: value?.data,
    error: value?.error,
    loading: !value,
    page: stack.length,
    previous: () => setPosition({ signature, stack: stack.slice(0, -1) }),
    next: () => {
      if (value?.data?.nextCursor)
        setPosition({ signature, stack: [...stack, value.data.nextCursor] });
    },
  };
}
function Pager({ list }: { list: ReturnType<typeof useAdminPage> }) {
  return (
    <div className="admin-pager">
      <span>
        共 {list.data?.total ?? '—'} 条 · 第 {list.page} 页
      </span>
      <div>
        <button
          className="button secondary small-button"
          disabled={list.loading || list.page === 1}
          onClick={list.previous}
        >
          上一页
        </button>
        <button
          className="button secondary small-button"
          disabled={list.loading || !list.data?.nextCursor}
          onClick={list.next}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
function ListState({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error?: string;
  empty: boolean;
}) {
  if (loading)
    return (
      <div className="admin-loading" role="status">
        <Spinner />
        正在读取记录…
      </div>
    );
  if (error)
    return (
      <p className="admin-error" role="alert">
        {error}，请刷新数据重试。
      </p>
    );
  if (empty)
    return (
      <Empty
        icon={<Search size={26} />}
        title="没有匹配记录"
        description="调整搜索或筛选条件后重试。"
      />
    );
  return null;
}
function UserList({
  version,
  mutate,
  pending,
}: {
  version: number;
  mutate: Mutate;
  pending: string;
}) {
  const w = useWorkspace();
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('all'),
    [role, setRole] = useState('all');
  const list = useAdminPage<User>(
    '/api/admin/users',
    new URLSearchParams({ q, status, role }).toString(),
    version,
  );
  return (
    <>
      <div className="admin-filters">
        <SearchBox value={q} onChange={setQ} placeholder="搜索用户名称或邮箱" />
        <label>
          账号状态
          <select aria-label="账号状态" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">停用</option>
          </select>
        </label>
        <label>
          用户角色
          <select aria-label="用户角色" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="all">全部角色</option>
            <option value="admin">管理员</option>
            <option value="member">成员</option>
          </select>
        </label>
      </div>
      <ListState loading={list.loading} error={list.error} empty={!list.data?.items.length} />
      {!!list.data?.items.length && (
        <div className="admin-records">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>访问权限</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((u) => (
                <tr key={u.id}>
                  <td data-label="用户">
                    <div className="user-cell">
                      <span className="avatar">{u.name.slice(0, 1)}</span>
                      <div>
                        <strong>{u.name}</strong>
                        <small>{u.email}</small>
                      </div>
                    </div>
                  </td>
                  <td data-label="角色">{u.role === 'admin' ? '管理员' : '成员'}</td>
                  <td data-label="状态">
                    <Status tone={u.status === 'active' ? 'green' : 'neutral'}>
                      {u.status === 'active' ? '正常' : '停用'}
                    </Status>
                  </td>
                  <td data-label="创建时间">{formatTime(u.createdAt)}</td>
                  <td data-label="访问权限">
                    <Toggle
                      checked={u.status === 'active'}
                      disabled={!!pending || u.id === w.cloud.user.id}
                      label={`启用用户${u.name}`}
                      onChange={() =>
                        mutate(
                          u.id,
                          () =>
                            patch(`/api/admin/users/${u.id}`, {
                              status: u.status === 'active' ? 'disabled' : 'active',
                              revision: u.revision || 0,
                            }),
                          '用户状态已更新',
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager list={list} />
      <p className="form-hint">停用会撤销账号的登录和设备授权；恢复后需要重新登录或授权。</p>
    </>
  );
}
function ModelSettings({
  model,
  configured,
  mutate,
  pending,
  outputSupported = false,
}: {
  model: ModelConfig;
  configured: boolean;
  mutate: Mutate;
  pending: string;
  outputSupported?: boolean;
}) {
  const [label, setLabel] = useState(model.label),
    [modelId, setModelId] = useState(model.modelId),
    [contextWindowTokens, setContextWindowTokens] = useState(model.contextWindowTokens || 64000),
    [maxOutputTokens, setMaxOutputTokens] = useState(model.maxOutputTokens || 8192),
    [enabled, setEnabled] = useState(model.enabled);
  return (
    <div className="model-config">
      <div className="model-config-heading">
        <div className="plugin-icon violet">
          <Box size={26} />
        </div>
        <div>
          <h2>火山方舟</h2>
          <p>OpenAI 兼容接口 · 服务端模型路由</p>
        </div>
        <Status tone={configured ? 'green' : 'neutral'}>
          {configured ? '密钥已配置' : '等待服务端密钥'}
        </Status>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutate(
            'model',
            () =>
              patch('/api/admin/model', {
                label,
                modelId,
                enabled,
                contextWindowTokens,
                ...(outputSupported ? { maxOutputTokens } : {}),
                revision: model.revision || 0,
              }),
            '模型配置已保存',
          );
        }}
      >
        <label>
          显示名称
          <input
            name="label"
            required
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          方舟 Model ID / Endpoint ID
          <input
            name="modelId"
            required
            maxLength={150}
            pattern="(?:[a-zA-Z0-9._]|-)+"
            spellCheck={false}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          />
        </label>
        <div className="model-alias">
          <span>客户端模型别名</span>
          <code>doubao</code>
        </div>
        <label>
          上下文使用预算（tokens）
          <input
            type="number"
            name="contextWindowTokens"
            required
            min={16384}
            max={2000000}
            step={1}
            value={contextWindowTokens}
            onChange={(e) => setContextWindowTokens(Number(e.target.value))}
          />
        </label>
        {outputSupported && (
          <label>
            单次输出上限（tokens）
            <input
              aria-label="单次输出上限"
              type="number"
              required
              min={1024}
              max={modelDefaults(modelId).outputLimit || MAX_CONFIGURED_OUTPUT}
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
            />
          </label>
        )}
        <p className="form-hint">
          按模型实际能力填写。输出须为上下文留下至少8,192 tokens输入空间；DeepSeek V4.1
          Flash的输出上限包含回答和思考。原对话保留，估算不等于上游计费。
        </p>
        <div className="setting-row">
          <div>
            <strong>启用模型路由</strong>
            <p>保存后生效；关闭后拒绝新的模型请求。</p>
          </div>
          <Toggle
            checked={enabled}
            disabled={!!pending}
            label="启用模型路由"
            onChange={() => setEnabled((v) => !v)}
          />
        </div>
        <div className="setting-note">
          <ShieldCheck size={17} />
          <p>API Key 只在服务端配置。此处「已配置」表示已设置密钥，不代表上游连接已通过验证。</p>
        </div>
        <button className="button primary" disabled={!!pending}>
          {pending === 'model' ? '保存中…' : '保存模型配置'}
        </button>
        <p className="form-hint">
          配置版本 {model.revision || 0}。发生冲突时保留当前输入，点击「刷新数据」载入最新配置。
        </p>
      </form>
    </div>
  );
}
function PluginList({
  version,
  mutate,
  pending,
}: {
  version: number;
  mutate: Mutate;
  pending: string;
}) {
  const [plugins, setPlugins] = useState<AdminPlugin[]>(),
    [error, setError] = useState('');
  const owner = currentAuthUser();
  useEffect(() => {
    const c = new AbortController();
    let active = true;
    setPlugins(undefined);
    setError('');
    void api<AdminPlugin[]>('/api/admin/plugins', { signal: c.signal })
      .then((v) => {
        if (active && currentAuthUser() === owner) setPlugins(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      c.abort();
    };
  }, [version, owner]);
  return (
    <>
      <p className="admin-explanation">
        下架后不再授予新的工具调用，保留用户原有安装和启用设置。此开关不代替本机项目授权，不管理本机
        MCP 连接。
      </p>
      <ListState loading={!plugins && !error} error={error} empty={plugins?.length === 0} />
      {plugins && (
        <div className="admin-records">
          <table>
            <thead>
              <tr>
                <th>内置插件</th>
                <th>工具</th>
                <th>用户安装 / 启用设置</th>
                <th>上架</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => (
                <tr key={p.id}>
                  <td data-label="内置插件">
                    <strong>{p.name}</strong>
                    <small>v{p.version}</small>
                  </td>
                  <td data-label="工具">
                    <div className="code-tags">
                      {p.tools.map((t) => (
                        <code key={t}>{t}</code>
                      ))}
                    </div>
                  </td>
                  <td data-label="用户设置">
                    {p.installedUsers} / {p.enabledUsers}
                  </td>
                  <td data-label="上架">
                    <Toggle
                      label={`上架${p.name}`}
                      checked={p.available}
                      disabled={!!pending}
                      onChange={() =>
                        mutate(
                          p.id,
                          () =>
                            patch(`/api/admin/plugins/${p.id}`, {
                              available: !p.available,
                              revision: p.revision,
                            }),
                          '插件目录已更新',
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
function UsageDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const w = useWorkspace(),
    [data, setData] = useState<AdminUsage>(),
    [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    let active = true;
    const owner = currentAuthUser();
    void api<AdminUsage>(`/api/admin/usage/${encodeURIComponent(id)}`, { signal: c.signal })
      .then((v) => {
        if (active && owner === currentAuthUser()) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      c.abort();
    };
  }, [id]);
  return (
    <Modal
      title="模型调用详情"
      onClose={onClose}
      description="仅保留调用元数据与用量，不保存请求或响应正文。"
    >
      <ListState loading={!data && !error} error={error} empty={false} />
      {data && (
        <>
          <dl className="admin-detail">
            {[
              ['请求 ID', data.id],
              ['用户', data.user ? `${data.user.name} · ${data.user.email}` : data.userId],
              ['模型', data.model],
              ['能力类型', data.capability || 'chat'],
              ['Trace ID', data.traceId || '未关联'],
              ['Span ID', data.spanId || '未关联'],
              ['状态', statusName(data.status)],
              ['时间', formatTime(data.at)],
              [
                '耗时',
                ['running', 'submitted'].includes(data.status) ? '进行中' : `${data.durationMs} ms`,
              ],
              ['上游 HTTP', data.upstreamStatus ?? '未记录'],
              ['输入 tokens', data.promptTokens ?? '上游未返回'],
              ['输出 tokens', data.completionTokens ?? '上游未返回'],
              ['总 tokens', data.totalTokens ?? '上游未返回'],
              ['音频 tokens', data.audioTokens ?? '上游未返回'],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {data.failureReason ? (
            <p className="admin-diagnostic">{failureName[data.failureReason]}</p>
          ) : data.status === 'completed' ? (
            <p className="form-hint">已收到模型完成结果；这不代表工具、游戏或最终交付已验收。</p>
          ) : (
            <p className="form-hint">此记录没有额外诊断分类；未知用量未计入 token 合计。</p>
          )}
          <footer>
            <button
              className="button secondary"
              onClick={() => void w.perform(() => copyText(data.id), '请求 ID 已复制')}
            >
              <Copy size={15} />
              复制请求 ID
            </button>
            <button className="button primary" onClick={onClose}>
              关闭
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}
function UsageList({ version }: { version: number }) {
  const [q, setQ] = useState(''),
    [status, setStatus] = useState('all'),
    [from, setFrom] = useState(''),
    [range, setRange] = useState('all'),
    [selected, setSelected] = useState('');
  const params = new URLSearchParams({ q, status });
  if (from) params.set('from', from);
  const list = useAdminPage<AdminUsage>('/api/admin/usage', params.toString(), version);
  const close = useCallback(() => setSelected(''), []);
  return (
    <>
      <div className="admin-filters">
        <SearchBox value={q} onChange={setQ} placeholder="搜索请求 ID、用户或模型" />
        <label>
          调用状态
          <select aria-label="调用状态" value={status} onChange={(e) => setStatus(e.target.value)}>
            {[
              ['all', '全部状态'],
              ['completed', '已完成'],
              ['running', '进行中'],
              ['failed', '失败 / 未确认'],
              ['cancelled', '已取消'],
              ['interrupted', '结果未确认'],
            ].map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          调用时间
          <select
            aria-label="调用时间"
            value={range}
            onChange={(e) => {
              const v = e.target.value;
              setRange(v);
              setFrom(v === 'all' ? '' : new Date(Date.now() - Number(v) * 86400000).toISOString());
            }}
          >
            <option value="all">全部时间</option>
            <option value="1">最近 24 小时</option>
            <option value="7">最近 7 天</option>
          </select>
        </label>
      </div>
      <ListState loading={list.loading} error={list.error} empty={!list.data?.items.length} />
      {!!list.data?.items.length && (
        <div className="admin-records">
          <table>
            <thead>
              <tr>
                <th>用户 / 请求</th>
                <th>模型</th>
                <th>状态</th>
                <th>耗时 / Tokens</th>
                <th>时间</th>
                <th>诊断</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((u) => (
                <tr key={u.id}>
                  <td data-label="用户 / 请求">
                    <strong>{u.user?.name || '未知用户'}</strong>
                    <small>{u.user?.email || u.userId}</small>
                    <code className="admin-request-id">{u.id}</code>
                  </td>
                  <td data-label="模型">
                    <code>{u.model}</code>
                  </td>
                  <td data-label="状态">
                    <Status
                      tone={
                        u.status === 'completed'
                          ? 'green'
                          : ['running', 'submitted'].includes(u.status)
                            ? 'blue'
                            : 'neutral'
                      }
                    >
                      {statusName(u.status)}
                    </Status>
                  </td>
                  <td data-label="耗时 / Tokens">
                    {['running', 'submitted'].includes(u.status)
                      ? '进行中'
                      : `${(u.durationMs / 1000).toFixed(1)}s`}{' '}
                    / {u.totalTokens ?? '未知'}
                  </td>
                  <td data-label="时间">{formatTime(u.at)}</td>
                  <td data-label="诊断">
                    <button
                      className="button secondary small-button"
                      onClick={() => setSelected(u.id)}
                    >
                      查看详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager list={list} />
      <p className="form-hint">
        统计已受理的模型请求；未知用量不按零处理。演示模式与受理前拒绝不计入模型用量。
      </p>
      {selected && <UsageDetails key={selected} id={selected} onClose={close} />}
    </>
  );
}
function AuditList({ version }: { version: number }) {
  const [q, setQ] = useState('');
  const list = useAdminPage<AdminAudit>(
    '/api/admin/audits',
    new URLSearchParams({ q }).toString(),
    version,
  );
  return (
    <>
      <div className="admin-filters">
        <SearchBox value={q} onChange={setQ} placeholder="搜索操作者、事件或详情" />
      </div>
      <ListState loading={list.loading} error={list.error} empty={!list.data?.items.length} />
      {!!list.data?.items.length && (
        <div className="admin-audit-list">
          {list.data.items.map((a) => (
            <article key={a.id}>
              <ShieldCheck size={17} />
              <div>
                <strong>{a.action}</strong>
                <p>{a.detail}</p>
                <small>{a.user ? `${a.user.name} · ${a.user.email}` : a.actor}</small>
              </div>
              <time>{formatTime(a.at)}</time>
            </article>
          ))}
        </div>
      )}
      <Pager list={list} />
    </>
  );
}

export default function Admin() {
  const w = useWorkspace();
  const [data, setData] = useState<AdminOverview>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [tab, setTab] = useState<(typeof tabs)[number]>('用户管理'),
    [version, setVersion] = useState(0),
    [pending, setPending] = useState('');
  const pendingRef = useRef(false),
    allowed = w.cloud.user.role === 'admin',
    owner = w.cloud.user.id;
  useEffect(() => {
    if (!allowed) return;
    const c = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    void api<AdminOverview>('/api/admin/overview?summary=true', { signal: c.signal })
      .then((v) => {
        if (active && owner === currentAuthUser()) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      c.abort();
    };
  }, [version, allowed, owner]);
  const mutate: Mutate = (id, work, message) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(id);
    void w
      .perform(async () => {
        await work();
        if (currentAuthUser() === owner) {
          setVersion((v) => v + 1);
          await w.refresh();
        }
      }, message)
      .finally(() => {
        pendingRef.current = false;
        setPending('');
      });
  };
  if (!allowed)
    return (
      <Empty
        icon={<ShieldCheck size={30} />}
        title="需要管理员权限"
        description="请使用管理员账号访问此页面。"
      />
    );
  return (
    <div className="page-scroll">
      <div className="page-content admin-page">
        {w.local.runtime.online && (
          <button className="back-link" onClick={() => w.setPage('workspace')}>
            <ArrowLeft size={15} />
            返回工作台
          </button>
        )}
        <PageHeading
          title="管理工作空间"
          description="管理账号和工具，核对每一次模型调用。"
          action={
            <button
              className="button secondary"
              disabled={loading || !!pending}
              onClick={() => setVersion((v) => v + 1)}
            >
              <RefreshCw size={15} />
              刷新数据
            </button>
          }
        />
        {error && (
          <p role="alert" className="admin-error">
            {error}
          </p>
        )}
        {!data && loading ? (
          <div className="admin-loading">
            <Spinner />
            正在读取管理数据…
          </div>
        ) : (
          data && (
            <>
              <div className="admin-stats">
                {[
                  {
                    icon: Users,
                    title: '注册用户',
                    value: data.totals.users,
                    detail: `${data.totals.activeUsers} 位正常账号`,
                  },
                  {
                    icon: Activity,
                    title: '模型请求',
                    value: data.totals.modelRequests,
                    detail: `${data.totals.failedRequests} 次失败 / 未确认 · ${data.totals.runningRequests} 次进行中`,
                  },
                  {
                    icon: HardDrive,
                    title: '资料空间',
                    value: formatSize(data.totals.storageBytes),
                    detail: `${data.totals.assets} 个文件（含回收站）`,
                  },
                  {
                    icon: Box,
                    title: '方舟配置',
                    value: data.arkConfigured ? '已配置' : '待配置',
                    detail: data.model.enabled ? '模型路由已启用' : '模型路由已停用',
                  },
                ].map(({ icon: Icon, title, value, detail }) => (
                  <div key={title}>
                    <span>
                      <Icon size={17} />
                      {title}
                    </span>
                    <strong>{value}</strong>
                    <small>{detail}</small>
                  </div>
                ))}
              </div>
              <p className="admin-token-summary">
                已知用量合计 {data.totals.totalTokens.toLocaleString()} tokens ·{' '}
                {data.totals.tokenRequests} / {data.totals.modelRequests}{' '}
                条记录返回总用量。此统计不作为计费账单。
              </p>
              <div className="collection-toolbar">
                <div className="tabs" role="tablist" aria-label="后台管理">
                  {tabs.map((t) => (
                    <button
                      key={t}
                      role="tab"
                      aria-selected={tab === t}
                      className={tab === t ? 'selected' : ''}
                      onClick={() => setTab(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <section aria-label={tab} aria-busy={loading}>
                {tab === '用户管理' && (
                  <UserList version={version} mutate={mutate} pending={pending} />
                )}
                {tab === '模型配置' && (
                  <>
                    <ModelSettings
                      key={data.model.revision || 0}
                      model={data.model}
                      configured={data.arkConfigured}
                      outputSupported={w.cloud.features?.capabilityModels === true}
                      mutate={mutate}
                      pending={pending}
                    />
                    {w.cloud.features?.capabilityModels && <CapabilityModels />}
                  </>
                )}
                {tab === '插件目录' && (
                  <PluginList version={version} mutate={mutate} pending={pending} />
                )}
                {tab === '调用记录' && <UsageList version={version} />}
                {tab === '审计日志' && <AuditList version={version} />}
              </section>
            </>
          )
        )}
      </div>
    </div>
  );
}

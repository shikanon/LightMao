import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Monitor,
  Box,
  Folder,
  ExternalLink,
  Copy,
  LogOut,
  ArrowUpRight,
  Info,
} from 'lucide-react';
import { useWorkspace } from '../context';
import { copyText } from '../clipboard';
import { PageHeading, Status, Toggle } from '../components/UI';
import { AccountSecurity } from './AccountSecurity';
import {
  desktopRuntimeStatus,
  setDesktopBackground,
  hasDesktopBackground,
  type DesktopRuntimeStatus,
  hasBackendSettings,
} from '../desktop';
import { BackendConnection } from './BackendConnection';
import { ApiError, patch } from '../api';

function AgentPermissions() {
  const w = useWorkspace();
  const [busy, setBusy] = useState(false);
  const permissions = w.cloud.permissions;
  const supported = !!w.cloud.features?.permissionDefaults && !!permissions;
  return (
    <section className="settings-section">
      <h2>Agent 权限</h2>
      <div className="setting-row">
        <ShieldCheck size={22} />
        <div>
          <strong>启动时使用的工具权限</strong>
          <p>
            {supported
              ? permissions.mode === 'full'
                ? '全部已注册内置插件默认启用，直接开始开发与测试。'
                : '按插件保存你的选择，重新启动后继续生效。'
              : '当前后端暂不支持统一权限设置。'}
          </p>
        </div>
        <select
          className="input"
          aria-label="Agent 权限模式"
          value={permissions?.mode || 'custom'}
          disabled={!supported || busy}
          onChange={(event) => {
            const mode = event.target.value as 'full' | 'custom';
            if (!permissions || mode === permissions.mode) return;
            setBusy(true);
            void w
              .perform(async () => {
                try {
                  await patch('/api/permissions', { mode, revision: permissions.revision });
                } catch (error) {
                  if (error instanceof ApiError && error.status === 409) await w.refresh();
                  throw error;
                }
                await w.refresh();
              }, 'Agent 权限已保存')
              .finally(() => setBusy(false));
          }}
        >
          <option value="full">全部权限（默认）</option>
          <option value="custom">按插件配置</option>
        </select>
      </div>
      <div className="setting-note">
        <Info size={16} />
        <p>在插件页关闭任一内置插件后，自动切换为按插件配置。组织下架的插件始终停用。</p>
      </div>
      <button className="text-button" onClick={() => w.setPage('plugins')}>
        前往插件管理 <ArrowUpRight size={15} />
      </button>
    </section>
  );
}

function DesktopBackground() {
  const w = useWorkspace();
  const [runtime, setRuntime] = useState<DesktopRuntimeStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () =>
      void desktopRuntimeStatus()
        .then((value) => {
          if (active) {
            setRuntime(value);
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('暂时无法读取桌面状态，请重新打开设置');
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <section className="settings-section">
      <h2>桌面后台运行</h2>
      <div className="setting-row">
        <Monitor size={22} />
        <div>
          <strong>关闭窗口后继续运行</strong>
          <p>
            {error ||
              (runtime
                ? runtime.trayAvailable
                  ? '收起到系统托盘，定时任务继续由本地 Agent 执行。'
                  : '系统托盘不可用，关闭窗口将退出。'
                : '正在读取桌面状态…')}
          </p>
        </div>
        <Toggle
          label="关闭窗口后继续运行"
          checked={!!runtime?.keepRunning}
          disabled={!runtime?.trayAvailable || busy}
          onChange={() => {
            setBusy(true);
            void w
              .perform(
                async () => setRuntime(await setDesktopBackground(!runtime?.keepRunning)),
                '桌面后台设置已保存',
              )
              .finally(() => setBusy(false));
          }}
        />
      </div>
      {runtime && (
        <div className="setting-row">
          <ClockState online={runtime.agentOnline} />
          <div>
            <strong>{runtime.agentOnline ? '本地任务服务在线' : '本地任务服务离线'}</strong>
            <p>
              {runtime.ownsAgent
                ? '随桌面应用启动，明确退出时停止。'
                : '由独立进程运行，退出桌面应用不会停止该进程。'}
            </p>
          </div>
        </div>
      )}
      <div className="setting-note">
        <Info size={16} />
        <p>
          系统休眠时不执行任务，唤醒后合并补跑一次。通过托盘菜单或快捷键明确退出后，需要重新启动应用才能恢复；当前不自动设置开机启动。
        </p>
      </div>
    </section>
  );
}
function ClockState({ online }: { online: boolean }) {
  return <Status tone={online ? 'green' : 'orange'}>{online ? '在线' : '离线'}</Status>;
}
export function Settings() {
  const w = useWorkspace();
  return (
    <div className="page-scroll">
      <div className="page-content settings-page">
        <PageHeading
          title="你的工作台，你的方式。"
          description="查看账号、模型连接与本地运行环境。"
        />
        <section className="settings-section">
          <h2>账号与工作空间</h2>
          <div className="setting-row">
            <div className="avatar large">{w.cloud.user.name.slice(0, 1)}</div>
            <div>
              <strong>{w.cloud.user.name}</strong>
              <p>{w.cloud.user.email}</p>
            </div>
            <span className="mode-label">{w.cloud.user.role === 'admin' ? '管理员' : '成员'}</span>
            <button className="button secondary" onClick={w.logout}>
              <LogOut size={15} />
              退出
            </button>
          </div>
        </section>
        <AccountSecurity />
        <AgentPermissions />
        {hasBackendSettings() && <BackendConnection />}
        {hasDesktopBackground() && <DesktopBackground />}
        <section className="settings-section">
          <h2>模型连接</h2>
          <div className="setting-row">
            <div className="setting-icon">
              <Box size={23} />
            </div>
            <div>
              <strong>{w.cloud.model.label}</strong>
              <p>通过用户鉴权后的后端网关调用方舟</p>
            </div>
            <Status tone={w.cloud.arkConfigured ? 'green' : 'neutral'}>
              {w.cloud.arkConfigured ? '已配置' : '待配置'}
            </Status>
          </div>
          <div className="setting-note">
            <Info size={16} />
            <p>
              真实模型需在后端设置 <code>ARK_API_KEY</code>
              。演示模式可直接体验工具、会话与扩展功能。
            </p>
          </div>
          {w.cloud.user.role === 'admin' && (
            <button className="text-button" onClick={() => w.setPage('admin')}>
              前往管理后台配置模型 <ArrowUpRight size={15} />
            </button>
          )}
        </section>
        <section className="settings-section">
          <h2>本地运行环境</h2>
          <div className="setting-row">
            <Monitor size={22} />
            <div>
              <strong>{w.local.runtime.framework}</strong>
              <p>独立本地服务 · 会话保存在 SQLite</p>
            </div>
            <Status tone="green">在线</Status>
          </div>
          <div className="setting-row">
            <ShieldCheck size={22} />
            <div>
              <strong>{w.local.runtime.sandbox}</strong>
              <p>文件工具使用独立进程。目录授权、网络范围和插件工具分别校验。</p>
            </div>
            <Status tone={w.local.runtime.isolation?.available ? 'green' : 'orange'}>
              {w.local.runtime.isolation?.available ? '隔离自检通过' : '隔离不可用'}
            </Status>
          </div>
          <div className="setting-note">
            <Info size={16} />
            <p>
              {w.local.runtime.isolation?.error ||
                '本地 MCP 在系统隔离进程内运行，默认只读且不联网。远程 MCP 的执行行为由服务方负责。'}
            </p>
          </div>
        </section>
        <section className="settings-section">
          <h2>项目目录</h2>
          {w.local.projects.map((p) => (
            <div className="setting-row project-path" key={p.id}>
              <Folder size={19} />
              <div>
                <strong>{p.name}</strong>
                <code>{p.root}</code>
              </div>
              <button
                className="icon-button"
                aria-label={`复制${p.name}路径`}
                onClick={() => void w.perform(() => copyText(p.root), '项目路径已复制')}
              >
                <Copy size={16} />
              </button>
            </div>
          ))}
        </section>
        <div className="settings-footer">LightMao 0.1.0 · 本地原型</div>
      </div>
    </div>
  );
}

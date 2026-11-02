import { useState, useCallback } from 'react';
import {
  Puzzle,
  FolderCode,
  FilePenLine,
  ScanLine,
  Shapes,
  Search,
  ArrowUpRight,
  Check,
  ShieldCheck,
  Gamepad2,
} from 'lucide-react';
import { useWorkspace } from '../context';
import { patch } from '../api';
import { PageHeading, SearchBox, Toggle, Empty, Modal } from '../components/UI';
import type { Plugin } from '../../../../packages/shared/types';
import { McpPlugins } from './McpPlugins';
const icons: Record<string, typeof Puzzle> = {
  FolderCode,
  FilePenLine,
  ScanLine,
  Shapes,
  Gamepad2,
};
export function Plugins() {
  const w = useWorkspace(),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('全部插件'),
    [detail, setDetail] = useState<Plugin>(),
    [pending, setPending] = useState('');
  const close = useCallback(() => setDetail(undefined), []);
  const update = async (p: Plugin, change: { installed?: boolean; enabled?: boolean }) => {
    setPending(p.id);
    await w.perform(
      async () => {
        await patch(`/api/plugins/${p.id}`, change);
        await w.refresh();
      },
      change.installed === false
        ? '插件已卸载'
        : change.installed
          ? '插件已安装并启用'
          : change.enabled
            ? '插件已启用'
            : '插件已停用',
    );
    setPending('');
  };
  const visible = w.cloud.plugins.filter(
    (p) =>
      (filter !== '已安装' || p.installed) &&
      `${p.name}${p.description}${p.category}`.includes(query),
  );
  return (
    <div className="page-scroll">
      <div className="page-content">
        <PageHeading
          title="让创作，多一种可能。"
          description="为 Agent 连接工具，让它更懂你的开发工作流。"
        />
        <div className="feature-banner">
          <div className="banner-icon">
            <Puzzle size={27} strokeWidth={1.4} />
          </div>
          <div>
            <strong>小工具，也有大作用</strong>
            <p>从读取项目到整理素材，按需扩展你的工作台。</p>
          </div>
          <span className="banner-caption">LIGHTMAO EXTENSIONS</span>
        </div>
        <div className="collection-toolbar">
          <div className="tabs">
            {['全部插件', '已安装', 'MCP 连接'].map((t) => (
              <button
                className={filter === t ? 'selected' : ''}
                key={t}
                onClick={() => setFilter(t)}
              >
                {t}
                {t !== 'MCP 连接' && (
                  <span>
                    {t === '全部插件'
                      ? w.cloud.plugins.length
                      : w.cloud.plugins.filter((p) => p.installed).length}
                  </span>
                )}
              </button>
            ))}
          </div>
          {filter !== 'MCP 连接' && (
            <SearchBox value={query} onChange={setQuery} placeholder="搜索插件…" />
          )}
        </div>
        {filter === 'MCP 连接' ? (
          <McpPlugins />
        ) : (
          <>
            <div className="plugin-grid">
              {visible.map((p) => {
                const Icon = icons[p.icon] || Puzzle;
                return (
                  <article className="plugin-card" key={p.id}>
                    <div className="plugin-card-top">
                      <div className={`plugin-icon ${p.color}`}>
                        <Icon size={27} strokeWidth={1.5} />
                      </div>
                      <span>{p.category}</span>
                      <button
                        className="icon-button"
                        aria-label={`查看${p.name}详情`}
                        onClick={() => setDetail(p)}
                      >
                        <ArrowUpRight size={17} />
                      </button>
                    </div>
                    <h2>{p.name}</h2>
                    <p>{p.description}</p>
                    <div className="plugin-capabilities">
                      {p.capabilities.map((c) => (
                        <span key={c}>{c}</span>
                      ))}
                    </div>
                    <footer>
                      <small>
                        <ShieldCheck size={13} />
                        {p.publisher}
                      </small>
                      {p.installed ? (
                        <div className="plugin-installed">
                          <span>
                            <Check size={13} />
                            已安装
                          </span>
                          <Toggle
                            label={`启用${p.name}`}
                            checked={p.enabled}
                            disabled={pending === p.id || p.available === false}
                            onChange={() => void update(p, { enabled: !p.enabled })}
                          />
                        </div>
                      ) : (
                        <button
                          className="button secondary small-button"
                          disabled={pending === p.id || p.available === false}
                          onClick={() => void update(p, { installed: true, enabled: true })}
                        >
                          {p.available === false
                            ? '管理员已下架'
                            : pending === p.id
                              ? '安装中…'
                              : '安装插件'}
                        </button>
                      )}
                    </footer>
                    {p.installed && p.available === false && (
                      <p className="form-hint">管理员已下架，当前不会授予工具。</p>
                    )}
                  </article>
                );
              })}
            </div>
            {!visible.length && (
              <Empty
                icon={<Search size={27} />}
                title="没有找到匹配的插件"
                description="试试其他名称，或清空搜索。"
              />
            )}
            <div className="collection-footnote">
              <ShieldCheck size={15} />
              内置工具包按项目权限运行。通过「MCP 连接」接入本地或远程开发工具。
            </div>
          </>
        )}
      </div>
      {detail && (
        <Modal
          title={detail.name}
          description={`${detail.publisher} · v${detail.version}`}
          onClose={close}
        >
          <p className="detail-description">{detail.description}</p>
          <h3>插件权限</h3>
          <ul className="permission-list">
            {detail.capabilities.map((p) => (
              <li key={p}>
                <ShieldCheck size={16} />
                {p}
              </li>
            ))}
          </ul>
          <h3>可用工具</h3>
          <div className="code-tags">
            {detail.tools.map((t) => (
              <code key={t}>{t}</code>
            ))}
          </div>
          <p className="form-hint">
            {detail.id === 'godot'
              ? '还需在「引擎验证」中为具体项目授权本机 Godot。执行工程副本中的代码，禁止联网和派生程序。'
              : '内置受限工具，仅在已授权项目目录内工作，不执行外部安装脚本。'}
          </p>
          <footer>
            {detail.installed && (
              <button
                className="button danger-quiet"
                onClick={() => {
                  void update(detail, { installed: false });
                  close();
                }}
              >
                卸载插件
              </button>
            )}
            <button className="button secondary" onClick={close}>
              关闭
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

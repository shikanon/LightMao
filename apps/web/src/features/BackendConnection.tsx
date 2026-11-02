import { useState, useEffect } from 'react';
import { Server, CheckCircle2, RefreshCw } from 'lucide-react';
import { Logo, Spinner } from '../components/UI';
import {
  desktopBackendStatus,
  probeDesktopBackend,
  setDesktopBackend,
  type BackendConnectionStatus,
  type BackendProbe,
} from '../desktop';

export function BackendConnection({
  setup = false,
  onCancel,
}: {
  setup?: boolean;
  onCancel?: () => void;
}) {
  const [config, setConfig] = useState<BackendConnectionStatus>(),
    [url, setUrl] = useState(''),
    [probe, setProbe] = useState<BackendProbe>(),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [restarting, setRestarting] = useState(false);
  useEffect(() => {
    let active = true;
    void desktopBackendStatus()
      .then((value) => {
        if (active) {
          setConfig(value);
          setUrl(value.url);
          setError(value.error || '');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  const form = (
    <section className="backend-connection settings-section">
      {setup && <Logo />}
      <h2>{setup ? '连接你的工作空间' : '后端连接'}</h2>
      <p className="backend-description">
        登录、资料和模型由后端服务提供，本地 Agent 在此设备执行工具。
      </p>
      {!config && !error ? (
        <Spinner />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!config || !probe) return;
            setBusy('save');
            setError('');
            void setDesktopBackend(url, config.revision)
              .then((result) => {
                setRestarting(result.restart);
                if (!result.restart) setBusy('');
              })
              .catch((e) => {
                setError(e.message);
                setBusy('');
              });
          }}
        >
          <label>
            后端服务地址
            <input
              name="backendUrl"
              type="url"
              required
              placeholder="https://agent.example.com"
              value={url}
              disabled={!config || config.readOnly || !!busy}
              onChange={(e) => {
                setUrl(e.target.value);
                setProbe(undefined);
                setError('');
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {config?.readOnly ? (
            <p className="form-hint">
              此连接由启动配置或独立本地服务管理，修改启动配置后重新打开应用。
            </p>
          ) : (
            <p className="form-hint">
              远程服务使用 HTTPS；本机开发可填 HTTP 回环地址。不同后端的账号、项目和会话分开保存。
            </p>
          )}
          <div className="backend-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!url || !!busy || !config}
              onClick={() => {
                setBusy('probe');
                setProbe(undefined);
                setError('');
                void probeDesktopBackend(url)
                  .then((value) => {
                    setProbe(value);
                    setUrl(value.url);
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(''));
              }}
            >
              {busy === 'probe' ? <Spinner /> : <Server size={16} />}检查连接
            </button>
            {!config?.readOnly && (
              <button
                className="button primary"
                disabled={!probe || probe.url !== url || !!busy || !config}
              >
                {busy === 'save' ? <Spinner /> : <RefreshCw size={16} />}保存并重新打开
              </button>
            )}
            {onCancel && (
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                onClick={onCancel}
              >
                返回
              </button>
            )}
          </div>
          {probe && (
            <p className="backend-probe" role="status">
              <CheckCircle2 size={16} />
              连接可用 · {probe.service} · {probe.durationMs} ms
            </p>
          )}
          {restarting && <p role="status">连接已保存，正在重新打开工作台…</p>}
          {!config?.readOnly && (
            <p className="form-hint">
              保存后应用会重新打开。当前后端的数据和任务记录保留；活动任务结束后才能切换。
            </p>
          )}
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
  return setup ? <div className="backend-setup">{form}</div> : form;
}

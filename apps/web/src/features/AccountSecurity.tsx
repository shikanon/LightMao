import { useState, useEffect, useCallback } from 'react';
import { Monitor, ShieldCheck, KeyRound, RefreshCw, LogOut, Laptop } from 'lucide-react';
import { useWorkspace } from '../context';
import { api, post, patch, setToken } from '../api';
import { Modal, Spinner, Status, formatTime } from '../components/UI';
import type {
  DeviceAuthorization,
  LoginSession,
  LocalAuthorization,
  User,
} from '../../../../packages/shared/types';

export function AccountSecurity() {
  const w = useWorkspace();
  const [devices, setDevices] = useState<DeviceAuthorization[]>([]),
    [sessions, setSessions] = useState<LoginSession[]>([]),
    [local, setLocal] = useState<LocalAuthorization>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [modal, setModal] = useState<'authorize' | 'profile' | 'password'>(),
    [revoke, setRevoke] = useState<DeviceAuthorization>();
  const close = useCallback(() => setModal(undefined), []),
    closeRevoke = useCallback(() => setRevoke(undefined), []);
  const load = async () => {
    setError('');
    const [d, s, l] = await Promise.all([
      api<DeviceAuthorization[]>('/api/account/devices'),
      api<LoginSession[]>('/api/account/sessions'),
      w.local.runtime.online
        ? api<LocalAuthorization>('/local/authorization')
        : Promise.resolve(undefined),
    ]);
    setDevices(d);
    setSessions(s);
    setLocal(l);
  };
  useEffect(() => {
    let active = true;
    void load().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, []);
  const perform = async (work: () => Promise<void>, success: string) => {
    setBusy(true);
    await w.perform(work, success);
    setBusy(false);
  };
  return (
    <>
      <section className="settings-section">
        <div className="account-section-heading">
          <h2>账号与安全</h2>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void perform(load, '授权状态已更新')}
          >
            <RefreshCw size={14} />
            刷新状态
          </button>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <div className="setting-row">
          <KeyRound size={21} />
          <div>
            <strong>账号资料与密码</strong>
            <p>修改密码会撤销其他登录和本机任务授权。</p>
          </div>
          <button className="button secondary small-button" onClick={() => setModal('profile')}>
            修改称呼
          </button>
          <button className="button secondary small-button" onClick={() => setModal('password')}>
            修改密码
          </button>
        </div>
        {w.local.runtime.online && (
          <div className="setting-row">
            <Laptop size={22} />
            <div>
              <strong>本机执行授权</strong>
              <p>
                {local?.status === 'ready'
                  ? `已授权 · 有效至 ${formatTime(local.expiresAt!)}`
                  : '授权后可执行 Agent 与定时任务。'}
              </p>
            </div>
            <Status tone={local?.status === 'ready' ? 'green' : 'neutral'}>
              {local?.status === 'ready' ? '已授权' : '待授权'}
            </Status>
            <button
              className="button secondary small-button"
              disabled={busy}
              onClick={() => setModal('authorize')}
            >
              {local?.status === 'ready' ? '更新授权' : '授权本机'}
            </button>
          </div>
        )}
        <p className="account-policy">
          退出网页登录后，已授权本机的任务仍可执行。可在下方撤销设备；该设备需重新登录并授权后才能继续。
        </p>
        <h3 className="account-subheading">已授权设备</h3>
        {devices
          .filter((d) => !d.revokedAt)
          .map((d) => (
            <div className="setting-row" key={d.id}>
              <Monitor size={21} />
              <div>
                <strong>
                  {d.label}
                  {d.deviceId === w.local.runtime.deviceId ? ' · 当前设备' : ''}
                </strong>
                <p>
                  最近使用 {formatTime(d.lastUsedAt)} · 到期 {formatTime(d.expiresAt)}
                </p>
              </div>
              <button
                className="button danger-quiet small-button"
                disabled={busy}
                aria-label={`撤销设备${d.label}`}
                onClick={() => setRevoke(d)}
              >
                撤销授权
              </button>
            </div>
          ))}
        {!devices.some((d) => !d.revokedAt) && <p className="form-hint">还没有已授权设备。</p>}
        <h3 className="account-subheading">网页登录</h3>
        {sessions.map((s) => (
          <div className="setting-row" key={s.id}>
            <ShieldCheck size={20} />
            <div>
              <strong>{s.current ? '当前登录' : friendlyClient(s.label)}</strong>
              <p>
                最近续期 {formatTime(s.lastUsedAt)} · 到期 {formatTime(s.expiresAt)}
              </p>
            </div>
            {s.current ? (
              <Status tone="green">当前</Status>
            ) : (
              <button
                className="button secondary small-button"
                disabled={busy}
                aria-label={`退出登录${s.id}`}
                onClick={() =>
                  void perform(async () => {
                    await api(`/api/account/sessions/${s.id}`, { method: 'DELETE' });
                    await load();
                  }, '已退出该登录')
                }
              >
                <LogOut size={14} />
                退出此登录
              </button>
            )}
          </div>
        ))}
        {!sessions.length && (
          <p className="form-hint">此登录来自旧版，重新登录后可查看续期状态。</p>
        )}
      </section>
      {modal === 'authorize' && (
        <Modal
          title="授权这台电脑执行任务？"
          description="允许本机 Agent 调用模型、读取你选择的资料，并执行已配置的定时任务。设备凭证不能管理账号或后台。"
          onClose={close}
        >
          <p className="form-hint">
            有效期由服务端决定，可随时撤销。退出网页登录后，已启用的任务仍可运行；电脑和本地 Agent
            需保持在线。
          </p>
          <footer>
            <button className="button secondary" onClick={close}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await post('/local/authorization');
                  await load();
                  await w.refresh();
                  close();
                }, '本机已授权')
              }
            >
              {busy ? <Spinner /> : null}授权本机
            </button>
          </footer>
        </Modal>
      )}
      {modal === 'profile' && (
        <Modal title="修改称呼" onClose={close}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get('name');
              void perform(async () => {
                await patch('/api/account/profile', { name });
                await w.refresh();
                close();
              }, '称呼已保存');
            }}
          >
            <label>
              称呼
              <input name="name" defaultValue={w.cloud.user.name} required maxLength={60} />
            </label>
            <footer>
              <button type="button" className="button secondary" onClick={close}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                保存
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal === 'password' && (
        <Modal
          title="修改登录密码"
          description="修改后，其他登录与设备授权均会失效；当前窗口保持登录。"
          onClose={close}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void perform(async () => {
                const r = await post<{ token: string; user: User }>(
                  '/api/account/password',
                  values,
                );
                setToken(r.token, r.user.id);
                await load();
                await w.refresh();
                close();
              }, '密码已修改，请重新授权本机任务');
            }}
          >
            <label>
              当前密码
              <input
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
              />
            </label>
            <label>
              新密码
              <input
                name="password"
                type="password"
                required
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
              />
            </label>
            <footer>
              <button type="button" className="button secondary" onClick={close}>
                取消
              </button>
              <button className="button primary" disabled={busy}>
                保存新密码
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {revoke && (
        <Modal
          title="撤销这台设备的授权？"
          description={`「${revoke.label}」的执行凭证及用于授权的登录会话将失效，定时任务会暂停等待重新授权。`}
          onClose={closeRevoke}
        >
          <footer>
            <button className="button secondary" onClick={closeRevoke}>
              保留授权
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await api(`/api/account/devices/${revoke.id}`, { method: 'DELETE' });
                  closeRevoke();
                  await load();
                  await w.refresh();
                }, '设备授权已撤销')
              }
            >
              撤销授权
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}
function friendlyClient(label: string) {
  return label.includes('Electron')
    ? 'LightMao 桌面端'
    : label.includes('Chrome')
      ? 'Chrome 浏览器'
      : label.includes('Safari')
        ? 'Safari 浏览器'
        : label.slice(0, 60);
}

import { useEffect, useState } from 'react';
import { api, patch } from '../api';
import { Toggle, Spinner } from '../components/UI';
type Route = {
  kind: 'decision' | 'image' | 'video' | 'vision' | 'audio';
  modelId: string;
  enabled: boolean;
  revision: number;
  configured: boolean;
};
const titles = {
  decision: 'System One 决策',
  image: '角色与场景图片',
  video: 'Seedance 2.5 视频',
  vision: '视觉理解与评审',
  audio: '音频理解',
};
function RouteEditor({
  route,
  onSaved,
}: {
  route: Route;
  onSaved: (value: Route, source?: 'reload') => void;
}) {
  const [id, setId] = useState(route.modelId),
    [enabled, setEnabled] = useState(route.enabled),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="capability-model-card"
      aria-label={titles[route.kind] + '配置'}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        void patch<Route>('/api/admin/capability-models/' + route.kind, {
          modelId: id.trim(),
          enabled,
          revision: route.revision,
        })
          .then((value) => {
            onSaved(value);
            setError('');
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <header>
        <h3>{titles[route.kind]}</h3>
        <span>{route.configured ? '服务端密钥已配置' : '等待服务端密钥'}</span>
      </header>
      <label>
        模型或接入点 ID
        <input
          aria-label={titles[route.kind] + '模型 ID'}
          value={id}
          onChange={(e) => setId(e.target.value)}
          required
          maxLength={160}
        />
      </label>
      <Toggle
        label={'启用' + titles[route.kind]}
        checked={enabled}
        onChange={() => setEnabled((v) => !v)}
      />
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button className="button secondary small" type="submit" disabled={busy}>
          {busy ? <Spinner /> : '保存' + titles[route.kind] + '路由'}
        </button>
        <button
          className="text-button"
          type="button"
          disabled={busy}
          onClick={() =>
            void api<Route[]>('/api/admin/capability-models')
              .then((values) => {
                const current = values.find((v) => v.kind === route.kind)!;
                setId(current.modelId);
                setEnabled(current.enabled);
                onSaved(current, 'reload');
                setError('');
              })
              .catch((e) => setError(e.message))
          }
        >
          重载此路由
        </button>
      </footer>
    </form>
  );
}
export function CapabilityModels() {
  const [notice, setNotice] = useState('');
  const [routes, setRoutes] = useState<Route[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void api<Route[]>('/api/admin/capability-models', { signal: controller.signal })
      .then((v) => {
        if (!controller.signal.aborted) setRoutes(v);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <section className="capability-models" aria-label="多模型能力路由">
      <h2>多模型能力</h2>
      <p className="form-hint">
        规划与代码沿用上方对话模型。决策、图片、视频、视觉与音频理解分别路由，密钥始终由服务端管理。账号开通状态以实际调用为准。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {routes.map((route) => (
        <RouteEditor
          key={route.kind + ':' + route.revision}
          route={route}
          onSaved={(value, source) => {
            setRoutes((old) => old.map((v) => (v.kind === value.kind ? value : v)));
            setNotice(
              titles[value.kind] +
                (source === 'reload' ? '已载入最新配置' : '路由已保存') +
                ' · 版本 ' +
                value.revision,
            );
          }}
        />
      ))}
    </section>
  );
}

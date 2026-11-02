import { lazy, Suspense, useEffect, useState, useRef } from 'react';
import { Play, X, Gamepad2 } from 'lucide-react';
import { useWorkspace } from '../context';
import { api, post, patch, authenticatedFetch } from '../api';
import { PageHeading, Spinner } from '../components/UI';
import type { GamePreview, PlaytestJob, SessionView } from '../../../../packages/shared/types';
const Engines = lazy(() => import('./Engines'));
function Screenshot({ id }: { id: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let current = '';
    void authenticatedFetch(`/local/playtests/${id}/screenshot`, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) throw Error('截图暂不可读');
        current = URL.createObjectURL(await r.blob());
        if (abort.signal.aborted) URL.revokeObjectURL(current);
        else setUrl(current);
      })
      .catch(() => {});
    return () => {
      abort.abort();
      if (current) URL.revokeObjectURL(current);
    };
  }, [id]);
  return url ? (
    <img className="playtest-screenshot" src={url} alt="本次自动试玩的实际画面" />
  ) : (
    <p>正在读取截图…</p>
  );
}
export default function GameStudio() {
  const w = useWorkspace();
  const [tab, setTab] = useState<'preview' | 'tests' | 'engine'>('preview'),
    [selected, setSelected] = useState(w.session?.projectId || w.local.projects[0]?.id || ''),
    [entry, setEntry] = useState('index.html'),
    [preview, setPreview] = useState<GamePreview>(),
    [jobs, setJobs] = useState<PlaytestJob[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [shot, setShot] = useState('');
  const supported = w.local.runtime.gamePlaytests === true;
  const previewRef = useRef<GamePreview | undefined>(undefined);
  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);
  useEffect(
    () => () => {
      const live = previewRef.current;
      if (live?.active) void post(`/local/previews/${live.id}/close`).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    setJobs([]);
    setShot('');
    const live = previewRef.current;
    if (live && live.projectId !== selected) {
      setPreview(undefined);
      previewRef.current = undefined;
      if (live.active) void post(`/local/previews/${live.id}/close`).catch(() => {});
    }
  }, [selected]);
  const project = w.local.projects.find((p) => p.id === selected),
    enabled = w.cloud.plugins.some((p) => p.id === 'playtest' && p.installed && p.enabled);
  useEffect(() => {
    if (!supported || !selected || tab !== 'tests') return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const data = await api<PlaytestJob[]>(`/local/projects/${selected}/playtests`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setJobs(data);
        if (data.some((v) => v.status === 'running'))
          timer = setTimeout(() => void refresh(), 1800);
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : '试玩记录暂不可用');
      }
    }
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [selected, tab, supported]);
  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作未完成');
    } finally {
      setBusy(false);
    }
  };
  const startGoal = () =>
    act(async () => {
      if (!supported || !w.local.runtime.workflowModes)
        throw Error('请升级本地 Agent 后使用自动试玩与 Goal。');
      const session = await post<SessionView>('/local/sessions', {
        projectId: selected,
        title: '自动试玩与修复',
      });
      w.openSession(session.id);
      await post(`/local/sessions/${session.id}/runs`, {
        prompt:
          '请检查当前项目，自动试玩核心玩法，验证开局、输入反馈、得分或胜负以及重开；修复发现的问题并实际复验，保存试玩证据。按项目类型选择浏览器或Godot原生链路，缺少能力时在界面请求启用。',
        mode: 'ark',
        workMode: 'goal',
        goalOptions: { maxRounds: 3, evidencePolicy: 'playtest' },
      });
      await w.refresh();
      w.setPage('workspace');
    });
  return (
    <div className="game-studio">
      <PageHeading
        title="运行与验证"
        description="预览可玩作品、查看自动试玩证据，或管理本机引擎。"
      />
      <div className="studio-tabs tabs" role="tablist" aria-label="作品运行方式">
        {(
          [
            ['preview', '作品预览'],
            ['tests', '试玩记录'],
            ['engine', 'Godot 诊断'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'selected' : ''}
            onClick={() => {
              setTab(id);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'engine' ? (
        <Suspense fallback={<Spinner />}>
          <Engines />
        </Suspense>
      ) : !supported ? (
        <p role="status" className="form-hint">
          当前本地 Agent 需升级后才能预览和自动试玩；Godot 诊断仍可使用。
        </p>
      ) : (
        <div className="studio-body">
          <div className="studio-toolbar">
            <label>
              项目
              <select
                aria-label="作品项目"
                disabled={busy}
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setError('');
                  setShot('');
                }}
              >
                {w.local.projects
                  .filter((p) => p.status !== 'archived' && p.access !== 'revoked')
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={busy || !project || !w.cloud.arkConfigured}
              onClick={() => void startGoal()}
            >
              <Gamepad2 size={16} />让 Agent 自动试玩并修复
            </button>
            <span className="form-hint">最多 3 轮 · 使用已配置模型</span>
          </div>
          {error && (
            <p role="alert" className="workflow-error">
              {error}
            </p>
          )}
          {tab === 'preview' ? (
            <>
              <div className="studio-toolbar">
                <label>
                  浏览器入口
                  <input
                    aria-label="浏览器游戏入口"
                    value={entry}
                    onChange={(e) => setEntry(e.target.value)}
                    placeholder="index.html"
                  />
                </label>
                {!enabled ? (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await patch('/api/plugins/playtest', { installed: true, enabled: true });
                        await w.refresh();
                      })
                    }
                  >
                    启用作品预览与自动试玩
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy || !project}
                    onClick={() =>
                      void act(async () => {
                        if (preview?.active) {
                          await post(`/local/previews/${preview.id}/close`);
                          setPreview(undefined);
                          previewRef.current = undefined;
                        }
                        const next = await post<GamePreview>(
                          `/local/projects/${selected}/preview`,
                          { entry },
                        );
                        setPreview(next);
                      })
                    }
                  >
                    <Play size={16} />
                    {busy ? '正在准备…' : '运行浏览器作品'}
                  </button>
                )}
                {preview?.active && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await post(`/local/previews/${preview.id}/close`);
                        setPreview(undefined);
                      })
                    }
                  >
                    <X size={14} />
                    关闭预览
                  </button>
                )}
              </div>
              <p className="form-hint">
                浏览器预览在独立来源运行，不调用模型。Godot
                原生作品使用自动试玩与引擎诊断；自动检查通过不代表玩家体验已验收。
              </p>
              {preview?.active ? (
                <div className="playable-frame">
                  <iframe
                    title="可玩游戏预览"
                    src={preview.url}
                    sandbox="allow-scripts allow-same-origin allow-pointer-lock"
                    referrerPolicy="no-referrer"
                  />
                  <span>{preview.entry} · 预览保留 15 分钟</span>
                </div>
              ) : (
                <div className="studio-empty">
                  <Gamepad2 size={36} />
                  <h2>让作品真正跑起来</h2>
                  <p>在工作台用一句话创建游戏，再在这里运行和查看验证结果。</p>
                </div>
              )}
            </>
          ) : (
            <div className="playtest-results">
              {!jobs.length && (
                <p className="form-hint">此项目尚无自动试玩记录。可让 Agent 实际试玩并保留证据。</p>
              )}
              {jobs.map((job) => (
                <article key={job.id} className="media-job-card">
                  <header>
                    <strong>{job.engineJobId ? 'Godot 原生试玩' : '浏览器试玩'}</strong>
                    <span>
                      {job.status === 'passed'
                        ? '自动检查通过'
                        : job.status === 'running'
                          ? '试玩中'
                          : job.status === 'interrupted'
                            ? '结果未确认'
                            : '未通过'}
                    </span>
                  </header>
                  <p>{job.goal}</p>
                  <p className="form-hint">
                    {job.inputActions} 次实际输入 · {job.steps} 次决策 ·{' '}
                    {job.assertions.filter((a) => a.passed).length}/{job.assertions.length} 条断言
                  </p>
                  {job.error && <p className="workflow-error">{job.error}</p>}
                  {job.screenshotSha256 && (
                    <button
                      className="text-button"
                      onClick={() => setShot(shot === job.id ? '' : job.id)}
                    >
                      {shot === job.id ? '收起截图' : '查看实际截图'}
                    </button>
                  )}
                  {shot === job.id && <Screenshot id={job.id} />}
                  <details>
                    <summary>验收条件与记录</summary>
                    <ul>
                      {job.assertions.map((a, i) => (
                        <li key={i}>
                          {a.passed ? '✓' : '○'} {a.field} {a.op} {String(a.value ?? '')}
                        </li>
                      ))}
                    </ul>
                    <code>{job.id}</code>
                    <p className="form-hint">
                      工程版本：{job.sourceSha256.slice(0, 16)}
                      ；状态数据由游戏报告，实际输入和执行阶段另有记录。
                    </p>
                  </details>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

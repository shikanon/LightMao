import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Gamepad2,
  Play,
  Square,
  Download,
  FileCode2,
  FolderPlus,
  ShieldCheck,
  RefreshCw,
  PlugZap,
  Unplug,
} from 'lucide-react';
import type {
  EngineArtifact,
  EngineConnection,
  EngineGrant,
  EngineJob,
  EngineJobSummary,
  Project,
} from '../../../../packages/shared/types';
import { useWorkspace } from '../context';
import { api, post, patch, engineArtifactBlob, downloadEngineArtifact } from '../api';
import { hasNativeEngineSelection, selectGodot } from '../desktop';
import { Modal, PageHeading, Empty, Spinner, Status, Toggle } from '../components/UI';
import { skillSize } from './SkillResources';

const actions = {
  validate: '导入检查',
  run: '运行主场景',
  script: '运行测试脚本',
  playtest: 'Godot 自动试玩',
};
const statuses = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '结果未确认',
};
const stages = {
  snapshot: '准备工程副本',
  import: '导入资源',
  run: '运行场景',
  script: '运行脚本',
  playtest: '自动试玩',
  finished: '已结束',
};
const verification = {
  not_run: '未验证',
  process_only: '进程执行完成',
  tests_passed: '项目测试报告通过',
  tests_failed: '项目测试报告未通过',
  unreported: '未提供断言报告',
};
type LogPage = { text: string; offset: number; totalChars: number; nextOffset: number | null };

function ArtifactPreview({ jobId, artifact }: { jobId: string; artifact: EngineArtifact }) {
  const [preview, setPreview] = useState(''),
    [image, setImage] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let active = true,
      objectURL = '';
    setPreview('');
    setImage('');
    setError('');
    setLoading(true);
    void (async () => {
      if (artifact.mime.startsWith('image/') && artifact.bytes <= 8 * 1024 * 1024) {
        objectURL = URL.createObjectURL(
          await engineArtifactBlob(jobId, artifact.id, controller.signal),
        );
        if (active) setImage(objectURL);
        else URL.revokeObjectURL(objectURL);
      } else if (
        (artifact.mime.startsWith('text/') || artifact.mime.includes('json')) &&
        artifact.bytes <= 128000
      ) {
        const text = await (await engineArtifactBlob(jobId, artifact.id, controller.signal)).text();
        if (active) setPreview(text);
      } else if (active)
        setPreview('此格式或大小请下载后查看。文本预览上限 128 KB，图片预览上限 8 MB。');
    })()
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [jobId, artifact.id, artifact.bytes, artifact.mime]);
  return (
    <div className="engine-artifact-preview" aria-busy={loading}>
      {loading ? (
        <Spinner />
      ) : error ? (
        <p role="alert">{error}</p>
      ) : image ? (
        <img
          src={image}
          alt={artifact.path}
          onError={() => setError('图片无法解码，可下载后查看')}
        />
      ) : (
        <pre>{preview}</pre>
      )}
    </div>
  );
}

function JobDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const w = useWorkspace();
  const [job, setJob] = useState<EngineJob>(),
    [logs, setLogs] = useState<LogPage>(),
    [error, setError] = useState(''),
    [more, setMore] = useState(false);
  const [artifactId, setArtifactId] = useState(''),
    [inputs, setInputs] = useState<{ path: string; bytes: number; sha256: string }[]>(),
    [inputTotal, setInputTotal] = useState(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    const endpoint = `/local/engine-jobs/${id}`;
    let timer: ReturnType<typeof setInterval> | undefined;
    const log = () =>
      api<LogPage>(endpoint + '/log', { signal: controller.signal }).then((value) => {
        if (active.current) setLogs(value);
      });
    void Promise.all([api<EngineJob>(endpoint, { signal: controller.signal }), log()])
      .then(([value]) => {
        if (!active.current) return;
        setJob(value);
        if (value.status === 'running')
          timer = setInterval(() => {
            void api<EngineJob>(endpoint, { signal: controller.signal })
              .then((next) => {
                if (!active.current) return;
                setJob(next);
                if (next.status !== 'running') {
                  clearInterval(timer);
                  void log().catch((error) => {
                    if (active.current) setError(error.message);
                  });
                }
              })
              .catch((error) => {
                if (active.current && !controller.signal.aborted) setError(error.message);
              });
          }, 1000);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => {
      active.current = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [id]);
  const artifact = job?.artifacts.find((item) => item.id === artifactId);
  return (
    <Modal
      title="引擎运行记录"
      description="日志按阶段保存，原始工程与运行副本分开。进程完成不代表玩法已经验收。"
      onClose={onClose}
      wide
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!job ? (
        <div className="mcp-loading">
          <Spinner />
          正在读取记录…
        </div>
      ) : (
        <>
          <div className="engine-record-summary">
            <div>
              <strong>{actions[job.action]}</strong>
              <p>
                {job.version} · {new Date(job.startedAt).toLocaleString()}
              </p>
            </div>
            <Status
              tone={
                job.status === 'completed' ? 'green' : job.status === 'running' ? 'blue' : 'orange'
              }
            >
              {statuses[job.status]}
            </Status>
          </div>
          <p className="form-hint">
            {job.status === 'running' ? stages[job.stage] : verification[job.verification]}
            {job.script ? ` · ${job.script}` : ''}
          </p>
          {job.error && <p className="form-error">{job.error}</p>}
          {job.snapshot && (
            <div className="engine-input-summary">
              <span>
                输入 {job.snapshot.fileCount} 文件 · {skillSize(job.snapshot.totalBytes)}
              </span>
              <code title={job.snapshot.sha256}>{job.snapshot.sha256.slice(0, 16)}</code>
              <button
                className="text-button"
                onClick={() =>
                  void w.perform(async () => {
                    const result = await api<{ items: NonNullable<typeof inputs>; total: number }>(
                      `/local/engine-jobs/${id}/inputs?limit=100`,
                    );
                    if (active.current) {
                      setInputs(result.items);
                      setInputTotal(result.total);
                    }
                  })
                }
              >
                查看输入清单
              </button>
            </div>
          )}
          {inputs && (
            <div className="engine-input-list">
              {inputs.map((file) => (
                <div key={file.path}>
                  <code>{file.path}</code>
                  <span>{skillSize(file.bytes)}</span>
                  <code>{file.sha256.slice(0, 12)}</code>
                </div>
              ))}
              {inputs.length < inputTotal && (
                <button
                  className="text-button"
                  onClick={() =>
                    void w.perform(async () => {
                      const result = await api<{ items: NonNullable<typeof inputs> }>(
                        `/local/engine-jobs/${id}/inputs?offset=${inputs.length}&limit=100`,
                      );
                      if (active.current) setInputs((prior) => [...(prior || []), ...result.items]);
                    })
                  }
                >
                  加载更多输入
                </button>
              )}
            </div>
          )}
          {job.phases.length > 0 && (
            <div className="table-scroll engine-phase-table">
              <table>
                <thead>
                  <tr>
                    <th>阶段</th>
                    <th>退出码</th>
                    <th>耗时</th>
                    <th>错误 / 告警</th>
                  </tr>
                </thead>
                <tbody>
                  {job.phases.map((phase) => (
                    <tr key={phase.name}>
                      <td>
                        {phase.name === 'import' ? '导入' : phase.name === 'run' ? '场景' : '脚本'}
                      </td>
                      <td>{phase.code ?? phase.signal ?? '未确认'}</td>
                      <td>{(phase.durationMs / 1000).toFixed(2)} 秒</td>
                      <td>
                        {phase.errorCount} / {phase.warningCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {job.diagnostics.length > 0 && (
            <details className="engine-diagnostics">
              <summary>诊断与环境告警 · {job.diagnostics.length}</summary>
              {job.diagnostics.map((text, index) => (
                <p key={index}>{text}</p>
              ))}
            </details>
          )}
          <h3>执行日志</h3>
          <pre className="engine-log">
            {logs?.text || (job.status === 'running' ? '当前阶段尚未结束。' : '没有可用日志。')}
          </pre>
          {logs?.nextOffset !== null && logs?.nextOffset !== undefined && (
            <button
              className="button secondary small-button"
              disabled={more}
              onClick={() => {
                setMore(true);
                void w
                  .perform(async () => {
                    const next = await api<LogPage>(
                      `/local/engine-jobs/${id}/log?offset=${logs.nextOffset}`,
                    );
                    if (active.current)
                      setLogs((previous) => ({
                        ...next,
                        text: (previous?.text || '') + next.text,
                      }));
                  })
                  .finally(() => {
                    if (active.current) setMore(false);
                  });
              }}
            >
              {more ? '读取中…' : '继续读取日志'}
            </button>
          )}
          {job.artifacts.length > 0 && (
            <>
              <h3>运行产物</h3>
              <div className="engine-artifacts">
                {job.artifacts.map((file) => (
                  <div key={file.id}>
                    <FileCode2 size={17} />
                    <div>
                      <strong>{file.path}</strong>
                      <small>
                        {skillSize(file.bytes)} · {file.sha256.slice(0, 12)}
                      </small>
                    </div>
                    <button className="text-button" onClick={() => setArtifactId(file.id)}>
                      预览
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`下载${file.path}`}
                      onClick={() =>
                        void w.perform(
                          () => downloadEngineArtifact(id, file.id, file.path),
                          '已开始下载',
                        )
                      }
                    >
                      <Download size={16} />
                    </button>
                  </div>
                ))}
              </div>
              {artifact && <ArtifactPreview key={artifact.id} jobId={id} artifact={artifact} />}
            </>
          )}
          <footer>
            {job.status === 'running' && (
              <button
                className="button danger-quiet"
                onClick={() =>
                  void w.perform(() => post(`/local/engine-jobs/${id}/stop`), '已请求停止')
                }
              >
                <Square size={14} />
                停止运行
              </button>
            )}
            <button className="button secondary" onClick={onClose}>
              关闭
            </button>
          </footer>
        </>
      )}
    </Modal>
  );
}

export default function Engines() {
  const w = useWorkspace();
  const projects = w.local.projects.filter(
    (project) => project.status !== 'archived' && project.access !== 'revoked',
  );
  const [projectId, setProjectId] = useState(
    () =>
      projects.find((project) => project.id === w.session?.projectId)?.id ||
      projects.find((project) => project.engine === 'Godot')?.id ||
      projects[0]?.id ||
      '',
  );
  const [connection, setConnection] = useState<EngineConnection | null>(null),
    [jobs, setJobs] = useState<EngineJobSummary[]>([]),
    [detected, setDetected] = useState({ configured: false, isolated: false });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [grant, setGrant] = useState<EngineGrant>(),
    [consent, setConsent] = useState(false),
    [jobId, setJobId] = useState(''),
    [action, setAction] = useState<EngineJob['action']>('validate');
  const generation = useRef(0),
    mounted = useRef(true);
  const project = projects.find((project) => project.id === projectId);
  const plugin = w.cloud.plugins.find((plugin) => plugin.id === 'godot');
  const pluginReady = !!plugin?.installed && !!plugin.enabled;
  const pendingJob = jobs.find((job) => job.status === 'running');
  const ready =
    !!connection?.enabled && !connection.needsAuthorization && detected.isolated && pluginReady;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const expected = generation.current;
      const [detected, connection, jobs] = await Promise.all([
        api<{ configured: boolean; isolated: boolean }>('/local/engines/detected', { signal }),
        projectId
          ? api<EngineConnection | null>(`/local/projects/${projectId}/engine`, { signal })
          : null,
        projectId
          ? api<EngineJobSummary[]>(`/local/projects/${projectId}/engine-jobs`, { signal })
          : [],
      ]);
      if (expected === generation.current && mounted.current) {
        setDetected(detected);
        setConnection(connection);
        setJobs(jobs);
        setError('');
        setLoading(false);
      }
    },
    [projectId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setLoading(true);
    setConnection(null);
    setJobs([]);
    setError('');
    const controller = new AbortController();
    const refresh = () =>
      void load(controller.signal).catch((error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
          setLoading(false);
        }
      });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
      generation.current++;
    };
  }, [load]);
  const closeDetails = useCallback(() => setJobId(''), []);
  const closeGrant = () => {
    if (busy || !grant) return;
    const token = grant.grantId;
    setGrant(undefined);
    void w.perform(() =>
      api(`/local/engine-grants/${encodeURIComponent(token)}`, { method: 'DELETE' }),
    );
  };
  async function choose(native: boolean) {
    if (!project) return;
    setBusy(true);
    const expected = generation.current;
    const preview = await w.perform(() =>
      native
        ? selectGodot(project.id)
        : post<EngineGrant>(`/local/projects/${project.id}/engine/prepare`),
    );
    if (preview && expected === generation.current && mounted.current) {
      setGrant(preview);
      setConsent(false);
    }
    if (mounted.current) setBusy(false);
  }
  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !ready) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    await w.perform(async () => {
      const job = await post<EngineJob>(`/local/projects/${project.id}/engine-jobs`, {
        action,
        ...(action === 'script' ? { script: String(form.get('script')) } : {}),
        frames: Number(form.get('frames') || 180),
        timeoutSeconds: Number(form.get('timeout') || 30),
        ...(action === 'run' && form.get('visible') ? { visible: true } : {}),
        requestId: crypto.randomUUID(),
      });
      if (mounted.current) {
        setJobs((previous) => [job, ...previous]);
      }
    }, '引擎任务已开始');
    if (mounted.current) setBusy(false);
  }
  return (
    <div className="page-scroll">
      <div className="page-content engine-page">
        <PageHeading
          title="让代码，在引擎里跑起来。"
          description="从导入检查到场景与测试，保留每次执行的版本、日志和产物。"
          action={
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void w
                  .perform(async () => {
                    const sample = await post<Project>('/local/engines/sample-project');
                    await w.refresh();
                    if (mounted.current) setProjectId(sample.id);
                  }, 'Godot 示例工程已创建')
                  .finally(() => {
                    if (mounted.current) setBusy(false);
                  });
              }}
            >
              <FolderPlus size={17} />
              创建示例工程
            </button>
          }
        />
        <div className="mcp-toolbar">
          <label>
            当前项目
            <select
              aria-label="引擎验证项目"
              value={projectId}
              disabled={busy || !!grant}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.engine}
                </option>
              ))}
            </select>
          </label>
          <span className="form-hint">Godot 4 标准版 · macOS 隔离执行</span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <div className="mcp-loading">
            <Spinner />
            正在读取引擎连接…
          </div>
        ) : !project ? (
          <Empty
            icon={<Gamepad2 size={28} />}
            title="先选择一个游戏工程"
            description="可导入已有 Godot 工程，也可创建带有测试的示例。"
          />
        ) : (
          <>
            <section className="engine-connection">
              <div className="engine-connection-heading">
                <div className="plugin-icon blue">
                  <Gamepad2 size={26} />
                </div>
                <div>
                  <h2>{connection ? `Godot ${connection.version}` : '连接本机 Godot'}</h2>
                  <p>
                    {connection
                      ? `程序摘要 ${connection.sha256.slice(0, 16)}`
                      : '为当前项目单独授权，先预览版本与执行范围。'}
                  </p>
                </div>
                {connection && (
                  <Status
                    tone={
                      connection.needsAuthorization
                        ? 'orange'
                        : connection.enabled
                          ? 'green'
                          : 'neutral'
                    }
                  >
                    {connection.needsAuthorization
                      ? '需要重新授权'
                      : connection.enabled
                        ? '已授权'
                        : '已停用'}
                  </Status>
                )}
              </div>
              <p className="engine-boundary">
                <ShieldCheck size={16} />
                工程副本可以执行代码；原工程不由引擎改写。禁止网络和子进程，支持只读工程验证。
              </p>
              {!detected.isolated && (
                <p className="form-error">当前系统的引擎隔离不可用，无法执行工程代码。</p>
              )}
              {connection?.needsAuthorization && (
                <p className="form-hint">项目设置或目录授权已改变，请重新选择并确认引擎。</p>
              )}
              <div className="engine-connection-actions">
                {hasNativeEngineSelection() && (
                  <button
                    className="button secondary"
                    disabled={busy || !!pendingJob || !detected.isolated}
                    onClick={() => void choose(true)}
                  >
                    <PlugZap size={16} />
                    {connection ? '更换或重新授权' : '选择 Godot 程序'}
                  </button>
                )}
                {detected.configured && (
                  <button
                    className="button secondary"
                    disabled={busy || !!pendingJob || !detected.isolated}
                    onClick={() => void choose(false)}
                  >
                    使用本机预配置
                  </button>
                )}
                {!hasNativeEngineSelection() && !detected.configured && (
                  <p className="form-hint">请在桌面端选择 Godot，或为本地 Agent 配置引擎路径。</p>
                )}
                {connection && (
                  <>
                    <label className="engine-enabled">
                      <span>允许此项目执行</span>
                      <Toggle
                        label="允许此项目执行引擎"
                        checked={connection.enabled}
                        disabled={busy || connection.needsAuthorization}
                        onChange={() => {
                          setBusy(true);
                          void w
                            .perform(
                              async () => {
                                await patch(`/local/projects/${projectId}/engine`, {
                                  enabled: !connection.enabled,
                                  revision: connection.revision,
                                });
                                await load();
                              },
                              connection.enabled ? '引擎已停用，活动任务正在停止' : '引擎已启用',
                            )
                            .finally(() => {
                              if (mounted.current) setBusy(false);
                            });
                        }}
                      />
                    </label>
                    <button
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => {
                        setBusy(true);
                        void w
                          .perform(async () => {
                            await api(`/local/projects/${projectId}/engine`, { method: 'DELETE' });
                            await load();
                          }, '引擎连接已断开，运行历史保留')
                          .finally(() => {
                            if (mounted.current) setBusy(false);
                          });
                      }}
                    >
                      <Unplug size={14} />
                      断开连接
                    </button>
                  </>
                )}
              </div>
            </section>
            {!pluginReady && (
              <div className="engine-plugin-note">
                <div>
                  <strong>
                    {plugin?.available === false
                      ? 'Godot 验证插件已下架'
                      : '开启 Godot 引擎验证插件'}
                  </strong>
                  <p>
                    {plugin?.available === false
                      ? '管理员重新上架后可继续启用，已有运行记录保留。'
                      : '安装工具后，还需保留当前项目的本机执行授权。'}
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy || plugin?.available === false}
                  onClick={() => {
                    setBusy(true);
                    void w
                      .perform(async () => {
                        await patch('/api/plugins/godot', { installed: true, enabled: true });
                        await w.refresh();
                      }, 'Godot 验证插件已启用')
                      .finally(() => {
                        if (mounted.current) setBusy(false);
                      });
                  }}
                >
                  开启验证插件
                </button>
              </div>
            )}
            <form className="engine-run-form" onSubmit={(event) => void run(event)}>
              <h2>验证一次当前工程</h2>
              <div className="engine-run-fields">
                <label>
                  操作
                  <select
                    aria-label="引擎操作"
                    value={action}
                    onChange={(event) => setAction(event.target.value as EngineJob['action'])}
                  >
                    <option value="validate">导入检查</option>
                    <option value="run">运行主场景</option>
                    <option value="script">运行测试脚本</option>
                  </select>
                </label>
                {action === 'script' && (
                  <label className="engine-script-input">
                    项目内脚本
                    <input
                      aria-label="测试脚本路径"
                      name="script"
                      defaultValue="tests/smoke.gd"
                      maxLength={400}
                      required
                    />
                  </label>
                )}
                {action === 'run' && w.local.runtime.gamePlaytests && (
                  <label>
                    <input type="checkbox" name="visible" />
                    显示原生窗口供实际操作（静音，最多帧数 ÷ 60 为预览秒数）
                  </label>
                )}
                <label>
                  最多帧数
                  <input
                    aria-label="引擎最多帧数"
                    type="number"
                    name="frames"
                    min={1}
                    max={3600}
                    defaultValue={180}
                    required
                  />
                </label>
                <label>
                  最长秒数
                  <input
                    aria-label="引擎最长秒数"
                    type="number"
                    name="timeout"
                    min={1}
                    max={120}
                    defaultValue={30}
                    required
                  />
                </label>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!ready || busy || !!pendingJob}
                >
                  {busy ? <Spinner /> : <Play size={15} />}
                  {pendingJob ? stages[pendingJob.stage] : '开始验证'}
                </button>
              </div>
              <p className="form-hint">
                时限包含工程准备。进程执行完成与项目测试报告分别显示；测试脚本可输出
                lightmao_artifacts/test-results.json。
              </p>
            </form>
            <div className="engine-history-heading">
              <h2>运行历史</h2>
              <button
                className="icon-button"
                aria-label="刷新引擎历史"
                onClick={() => void w.perform(() => load())}
              >
                <RefreshCw size={16} />
              </button>
            </div>
            {!jobs.length ? (
              <Empty
                icon={<Play size={24} />}
                title="还没有引擎运行记录"
                description="连接引擎后，开始一次导入、场景或脚本验证。"
              />
            ) : (
              <div className="engine-job-list">
                {jobs.map((job) => (
                  <article key={job.id}>
                    <div className="engine-job-icon">
                      <Gamepad2 size={19} />
                    </div>
                    <div>
                      <strong>{actions[job.action]}</strong>
                      <p>
                        {new Date(job.startedAt).toLocaleString()} ·{' '}
                        {job.status === 'running'
                          ? stages[job.stage]
                          : verification[job.verification]}
                      </p>
                      {job.snapshot && (
                        <small>
                          {job.snapshot.fileCount} 文件 · 输入 {job.snapshot.sha256.slice(0, 12)}
                        </small>
                      )}
                      {job.error && <p className="engine-job-error">{job.error}</p>}
                    </div>
                    <Status
                      tone={
                        job.status === 'completed'
                          ? 'green'
                          : job.status === 'running'
                            ? 'blue'
                            : 'orange'
                      }
                    >
                      {statuses[job.status]}
                    </Status>
                    <div className="engine-job-actions">
                      {job.status === 'running' && (
                        <button
                          className="button secondary small-button"
                          onClick={() =>
                            void w.perform(
                              () => post(`/local/engine-jobs/${job.id}/stop`),
                              '已请求停止',
                            )
                          }
                        >
                          <Square size={13} />
                          停止
                        </button>
                      )}
                      <button
                        className="button secondary small-button"
                        onClick={() => setJobId(job.id)}
                      >
                        查看记录
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        {grant && (
          <Modal
            title="确认项目引擎授权"
            description={
              projects.find((project) => project.id === grant.projectId)?.name || '当前项目'
            }
            onClose={closeGrant}
          >
            <div className="engine-grant">
              <Gamepad2 size={30} />
              <h3>Godot {grant.version}</h3>
              <code>{grant.sha256}</code>
              <p>{grant.scope}</p>
              <p className="form-hint">
                授权仅用于当前项目和此程序版本；技能文本、云端插件安装均不能替代此授权。
              </p>
            </div>
            <label className="engine-consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              允许此项目在隔离副本中执行代码
            </label>
            <footer>
              <button className="button secondary" disabled={busy} onClick={closeGrant}>
                取消
              </button>
              <button
                className="button primary"
                disabled={!consent || busy}
                onClick={() => {
                  setBusy(true);
                  void w
                    .perform(async () => {
                      await post(`/local/projects/${grant.projectId}/engine`, {
                        grantId: grant.grantId,
                      });
                      if (mounted.current) setGrant(undefined);
                      await load();
                    }, '项目引擎已授权')
                    .finally(() => {
                      if (mounted.current) setBusy(false);
                    });
                }}
              >
                {busy ? <Spinner /> : <ShieldCheck size={16} />}确认授权
              </button>
            </footer>
          </Modal>
        )}
        {jobId && <JobDetails key={jobId} id={jobId} onClose={closeDetails} />}
      </div>
    </div>
  );
}

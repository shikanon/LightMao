import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { api, authenticatedFetch, post } from '../api';
import type { ProjectArtifact } from '../../../../packages/shared/artifacts';
import type { GamePreview } from '../../../../packages/shared/types';
import type { ArtifactViewState } from './workspace-tabs';
type PreviewStateProps = {
  active?: boolean;
  viewState?: ArtifactViewState;
  onViewStateChange?: (view: ArtifactViewState) => void;
};
const ModelViewer = lazy(() => import('./ModelViewer'));
export function useMediaUrl(path: string) {
  const [state, setState] = useState({ url: '', error: '' });
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setState({ url: '', error: '' });
    if (path)
      void authenticatedFetch(path, { signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || '媒体读取失败');
          return r.blob();
        })
        .then((blob) => {
          if (!controller.signal.aborted) {
            objectUrl = URL.createObjectURL(blob);
            setState({ url: objectUrl, error: '' });
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setState({ url: '', error: e.message });
        });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  return state;
}
export function ImageCanvas({
  url,
  name,
  viewState,
  onViewStateChange,
}: { url: string; name: string } & PreviewStateProps) {
  const [zoom, setZoom] = useState(viewState?.image?.zoom || 1),
    [position, setPosition] = useState({
      x: viewState?.image?.x || 0,
      y: viewState?.image?.y || 0,
    }),
    [size, setSize] = useState('');
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | undefined>(undefined);
  return (
    <div className="image-workspace">
      <div className="media-toolbar">
        <span>{size}</span>
        <label>
          缩放{' '}
          <input
            aria-label="图片缩放"
            type="range"
            min="0.25"
            max="4"
            step="0.05"
            value={zoom}
            onChange={(e) => {
              const value = Number(e.target.value);
              setZoom(value);
              onViewStateChange?.({ image: { zoom: value, ...position } });
            }}
          />
        </label>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => {
            setZoom(1);
            setPosition({ x: 0, y: 0 });
            onViewStateChange?.({ image: { zoom: 1, x: 0, y: 0 } });
          }}
        >
          适应画布
        </button>
      </div>
      <div
        className="image-canvas"
        aria-label="图片画布"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: position.x, oy: position.y };
        }}
        onPointerMove={(e) => {
          if (drag.current)
            setPosition({
              x: drag.current.ox + e.clientX - drag.current.x,
              y: drag.current.oy + e.clientY - drag.current.y,
            });
        }}
        onPointerUp={() => {
          drag.current = undefined;
          onViewStateChange?.({ image: { zoom, ...position } });
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          onViewStateChange?.({ image: { zoom, ...position } });
        }}
      >
        <img
          draggable={false}
          alt={name}
          src={url}
          onLoad={(e) =>
            setSize(e.currentTarget.naturalWidth + ' × ' + e.currentTarget.naturalHeight)
          }
          style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }}
        />
      </div>
    </div>
  );
}
export function MediaPlayer({
  url,
  kind,
  name,
  active = true,
  viewState,
  onViewStateChange,
}: {
  url: string;
  kind: 'video' | 'audio';
  name: string;
} & PreviewStateProps) {
  const [error, setError] = useState('');
  const media = useRef<HTMLMediaElement | null>(null),
    restored = useRef(false),
    savedAt = useRef(0);
  const savePosition = () => {
    if (restored.current && media.current) {
      savedAt.current = Date.now();
      onViewStateChange?.({ mediaTime: media.current.currentTime });
    }
  };
  const checkpointPosition = () => {
    if (Date.now() - savedAt.current > 10000) savePosition();
  };
  const restorePosition = () => {
    const element = media.current;
    if (element && viewState?.mediaTime)
      element.currentTime = Math.min(
        viewState.mediaTime,
        Number.isFinite(element.duration)
          ? Math.max(0, element.duration - 0.05)
          : viewState.mediaTime,
      );
    restored.current = true;
  };
  useEffect(() => {
    if (!active) media.current?.pause();
  }, [active]);
  useEffect(() => () => media.current?.pause(), []);
  return (
    <div className="media-player">
      {kind === 'video' ? (
        <video
          ref={(element) => {
            media.current = element;
          }}
          aria-label={name}
          src={url}
          controls
          preload="metadata"
          playsInline
          onLoadedMetadata={restorePosition}
          onTimeUpdate={checkpointPosition}
          onSeeked={savePosition}
          onPause={savePosition}
          onError={() => setError('此视频编码无法播放，请导出 H.264 / AAC MP4 后重试。')}
        />
      ) : (
        <audio
          ref={(element) => {
            media.current = element;
          }}
          aria-label={name}
          src={url}
          controls
          preload="metadata"
          onLoadedMetadata={restorePosition}
          onTimeUpdate={checkpointPosition}
          onSeeked={savePosition}
          onPause={savePosition}
          onError={() => setError('音频解码未完成，请检查文件格式。')}
        />
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function FileBody({
  item,
  active = true,
  viewState,
  onViewStateChange,
}: { item: ProjectArtifact } & PreviewStateProps) {
  const { url, error } = useMediaUrl(`/local/artifacts/${item.id}/content`),
    [text, setText] = useState('');
  useEffect(() => {
    const c = new AbortController();
    if (url && item.kind === 'text')
      void fetch(url, { signal: c.signal })
        .then((r) => r.text())
        .then(setText)
        .catch(() => {});
    return () => c.abort();
  }, [url, item.kind]);
  if (error)
    return (
      <p role="alert" className="inline-error">
        {error}
      </p>
    );
  if (!url) return <p className="form-hint">正在读取预览快照…</p>;
  if (item.kind === 'video' || item.kind === 'audio')
    return (
      <MediaPlayer
        url={url}
        kind={item.kind}
        name={item.name}
        active={active}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
      />
    );
  if (item.kind === 'image')
    return (
      <ImageCanvas
        url={url}
        name={item.name}
        viewState={viewState}
        onViewStateChange={onViewStateChange}
      />
    );
  if (item.kind === 'model')
    return (
      <Suspense fallback={<p>正在加载3D查看器…</p>}>
        <ModelViewer url={url} name={item.name} active={active} />
      </Suspense>
    );
  return /\.(md|markdown)$/i.test(item.name) ? (
    <div className="preview-document">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  ) : (
    <pre className="project-code-preview">
      <code>{text || '文件内容为空'}</code>
    </pre>
  );
}
function WebPreview({ projectId, path }: { projectId: string; path: string }) {
  const [state, setState] = useState<{ preview?: GamePreview; error?: string }>({});
  useEffect(() => {
    let disposed = false,
      created: GamePreview | undefined;
    void post<GamePreview>(`/local/projects/${projectId}/preview`, { entry: path })
      .then((p) => {
        created = p;
        if (disposed) void post(`/local/previews/${p.id}/close`).catch(() => {});
        else setState({ preview: p });
      })
      .catch((e) => {
        if (!disposed) setState({ error: e.message });
      });
    return () => {
      disposed = true;
      if (created) void post(`/local/previews/${created.id}/close`).catch(() => {});
    };
  }, [projectId, path]);
  if (state.error)
    return (
      <p role="alert" className="inline-error">
        {state.error}
      </p>
    );
  if (!state.preview) return <p>正在准备隔离网页…</p>;
  return (
    <div className="web-workspace">
      <iframe
        title={path}
        src={state.preview.url}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}
export function ArtifactViewer({
  projectId,
  path,
  active = true,
  viewState,
  onViewStateChange,
}: { projectId: string; path: string } & PreviewStateProps) {
  const [state, setState] = useState<{ item?: ProjectArtifact; error?: string }>({});
  const html = /\.html$/i.test(path);
  useEffect(() => {
    let disposed = false;
    setState({});
    if (!html)
      void post<ProjectArtifact>(`/local/projects/${projectId}/artifacts`, { path })
        .then((item) => {
          if (!disposed) setState({ item });
        })
        .catch((e) => {
          if (!disposed) setState({ error: e.message });
        });
    return () => {
      disposed = true;
    };
  }, [projectId, path, html]);
  if (html) return <WebPreview key={projectId + path} projectId={projectId} path={path} />;
  if (state.error)
    return (
      <p className="inline-error" role="alert">
        {state.error}
      </p>
    );
  return state.item ? (
    <FileBody
      key={state.item.id}
      item={state.item}
      active={active}
      viewState={viewState}
      onViewStateChange={onViewStateChange}
    />
  ) : (
    <p className="form-hint">正在创建文件预览快照…</p>
  );
}

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
export function assertEmbeddedModel(bytes: ArrayBuffer, name: string) {
  let json: unknown;
  if (/\.gltf$/i.test(name)) json = JSON.parse(new TextDecoder().decode(bytes));
  else if (/\.glb$/i.test(name)) {
    const d = new DataView(bytes);
    if (
      d.byteLength < 20 ||
      d.getUint32(0, true) !== 0x46546c67 ||
      d.getUint32(4, true) !== 2 ||
      d.getUint32(8, true) !== d.byteLength
    )
      throw Error('GLB头或版本无效');
    const n = d.getUint32(12, true);
    if (d.getUint32(16, true) !== 0x4e4f534a || n > d.byteLength - 20)
      throw Error('GLB JSON段无效');
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, n)).trim());
  }
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object')
      for (const [key, value] of Object.entries(v)) {
        if (key === 'uri' && typeof value === 'string' && !value.startsWith('data:'))
          throw Error('仅预览自包含模型；请将外部贴图和缓冲区嵌入 GLB。');
        visit(value);
      }
  };
  if (json) visit(json);
}
export default function ModelViewer({
  url,
  name,
  active = true,
}: {
  url: string;
  name: string;
  active?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    reset = useRef<() => void>(() => {}),
    [error, setError] = useState(''),
    [info, setInfo] = useState(''),
    [playing, setPlaying] = useState(true),
    play = useRef(true),
    visible = useRef(active),
    wake = useRef<() => void>(() => {});
  useEffect(() => {
    play.current = playing;
  }, [playing]);
  useEffect(() => {
    visible.current = active;
    if (active) wake.current();
  }, [active]);
  useEffect(() => {
    const element = host.current!;
    let disposed = false,
      renderer: THREE.WebGLRenderer | undefined,
      observer: ResizeObserver | undefined,
      controls: OrbitControls | undefined,
      frame = 0,
      object: THREE.Object3D | undefined,
      mixer: THREE.AnimationMixer | undefined,
      timer: THREE.Timer | undefined;
    const controller = new AbortController(),
      scene = new THREE.Scene();
    setError('');
    setInfo('正在读取模型…');
    void (async () => {
      const bytes = await (await fetch(url, { signal: controller.signal })).arrayBuffer();
      assertEmbeddedModel(bytes, name);
      if (disposed) return;
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((uri) => {
        if (!/^(data:|blob:)/.test(uri)) throw Error('模型外部资源未授权');
        return uri;
      });
      let animations: THREE.AnimationClip[] = [];
      if (/\.obj$/i.test(name))
        object = new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
      else {
        const gltf = await new GLTFLoader(manager).parseAsync(
          /\.gltf$/i.test(name) ? new TextDecoder().decode(bytes) : bytes,
          '',
        );
        object = gltf.scene;
        animations = gltf.animations;
      }
      if (disposed) {
        object.traverse((n) => {
          if (n instanceof THREE.Mesh) n.geometry.dispose();
        });
        return;
      }
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setClearColor(0xeceff1, 1);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      element.appendChild(renderer.domElement);
      renderer.domElement.setAttribute('aria-label', '可旋转缩放的3D模型');
      const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x4e626f, 2.8));
      const light = new THREE.DirectionalLight(0xffffff, 3.5);
      light.position.set(3, 6, 4);
      scene.add(light);
      scene.add(object);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      const bounds = new THREE.Box3().setFromObject(object),
        center = bounds.getCenter(new THREE.Vector3()),
        size = bounds.getSize(new THREE.Vector3()),
        radius = Math.max(0.1, size.length() / 2);
      reset.current = () => {
        camera.position
          .copy(center)
          .add(new THREE.Vector3(radius * 0.9, radius * 0.65, radius * 2.6));
        camera.near = radius / 100;
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        controls!.target.copy(center);
        controls!.update();
      };
      reset.current();
      if (animations.length) {
        mixer = new THREE.AnimationMixer(object);
        for (const clip of animations) mixer.clipAction(clip).play();
      }
      let meshes = 0;
      object.traverse((n) => {
        if (n instanceof THREE.Mesh) meshes++;
      });
      setInfo(`${meshes} 个网格 · ${animations.length} 段动画`);
      observer = new ResizeObserver(() => {
        const w = element.clientWidth,
          h = element.clientHeight;
        renderer!.setSize(w, h);
        camera.aspect = w / Math.max(1, h);
        camera.updateProjectionMatrix();
      });
      observer.observe(element);
      timer = new THREE.Timer();
      timer.connect(document);
      const loop = () => {
        frame = 0;
        if (disposed || !visible.current) return;
        timer!.update();
        const dt = Math.min(0.05, timer!.getDelta());
        if (play.current) mixer?.update(dt);
        controls!.update();
        renderer!.render(scene, camera);
        frame = requestAnimationFrame(loop);
      };
      wake.current = () => {
        if (!frame && !disposed && visible.current) {
          timer!.reset();
          loop();
        }
      };
      wake.current();
    })().catch((e) => {
      if (!disposed) setError(e.message);
    });
    return () => {
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frame);
      wake.current = () => {};
      observer?.disconnect();
      controls?.dispose();
      mixer?.stopAllAction();
      timer?.dispose();
      object?.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
            for (const value of Object.values(material))
              if (value instanceof THREE.Texture) value.dispose();
            material.dispose();
          }
        }
      });
      renderer?.dispose();
      renderer?.domElement.remove();
    };
  }, [url, name]);
  return (
    <div className="model-workspace">
      <div className="media-toolbar">
        <span>{info}</span>
        <button onClick={() => reset.current()}>适应模型</button>
        <button onClick={() => setPlaying((v) => !v)}>{playing ? '暂停动画' : '播放动画'}</button>
      </div>
      <div ref={host} className="model-canvas" />
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <p className="form-hint">拖动旋转 · 滚轮缩放 · 自包含GLB / GLTF / OBJ</p>
    </div>
  );
}

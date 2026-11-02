import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dir = resolve(process.argv[2] || '');
const input = JSON.parse(await readFile(join(dir, 'receipt.json'), 'utf8'));
const root = input.root,
  qaDir = join(dir, 'preview-qa');
await mkdir(qaDir, { recursive: true });
const receipt = {
  at: new Date().toISOString(),
  browserProvider: 'isolated Playwright; no Browser plugin available',
  sourceReceipt: join(dir, 'receipt.json'),
  checks: [],
  visualAccepted: false,
  characterRootVerified: false,
};
const routes = new Map();
for (const [name, out] of Object.entries(input.outputs)) {
  const manifest = JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8'));
  for (const file of ['preview.html', ...manifest.frames.map((f) => f.file)])
    routes.set('/' + name + '/' + file, join(root, name, file));
}
const server = createServer(async (req, res) => {
  const path = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    'content-type',
    extname(path) === '.html' ? 'text/html; charset=utf-8' : 'image/png',
  );
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'",
  );
  res.end(await readFile(path));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
try {
  for (const name of Object.keys(input.outputs)) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 940 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/' + name + '/preview.html');
    await page.waitForFunction(
      () => typeof images !== 'undefined' && images.every((i) => i.complete && i.naturalWidth > 0),
    );
    await page.locator('#play').click();
    await page.locator('#frame').selectOption('0');
    for (const bg of ['checker', 'black', 'white', 'game']) {
      await page.locator('#bg').selectOption(bg);
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(qaDir, name + '-' + bg + '.png') });
    }
    assert.equal(errors.length, 0, errors.join(';'));
    assert.equal(await page.locator('canvas').getAttribute('width'), '960');
    receipt.checks.push({
      name,
      backgrounds: ['checker', 'black', 'white', 'game'],
      scriptErrors: errors,
      previewPassed: true,
      technicalPassed: input.outputs[name].technicalPassed,
    });
    await page.close();
  }
  const check = join(qaDir, 'godot');
  await mkdir(check, { recursive: true });
  const names = [
    'walk-alpha-assets',
    Object.keys(input.outputs).find((n) => n.startsWith('ultimate-assets-chroma')) ||
      'ultimate-assets',
  ];
  for (const name of names) {
    await mkdir(join(check, name), { recursive: true });
    const m = JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8'));
    for (const file of ['manifest.json', 'godot-import.gd', ...m.frames.map((f) => f.file)])
      await cp(join(root, name, file), join(check, name, file));
  }
  await writeFile(
    join(check, 'project.godot'),
    'config_version=5\n[application]\nconfig/name="LightMao generated asset import QA"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(check, 'check.gd'),
    `extends SceneTree\nfunc _initialize() -> void:\n\tvar world := Node2D.new()\n\troot.add_child(world)\n\tfor folder: String in ${JSON.stringify(names)}:\n\t\tvar loader = load("res://"+folder+"/godot-import.gd").new()\n\t\tvar sprite := AnimatedSprite2D.new()\n\t\tworld.add_child(sprite)\n\t\tworld.add_child(loader)\n\t\tloader.load_animation(sprite,"res://"+folder+"/manifest.json")\n\t\tif sprite.sprite_frames.get_frame_count("default") < 2:\n\t\t\tquit(2)\n\t\t\treturn\n\t\tprint("ASSET_IMPORT_OK "+folder+" frames="+str(sprite.sprite_frames.get_frame_count("default"))+" offset="+str(sprite.offset))\n\tquit(0)\n`,
  );
  const godot = resolve(
    process.env.LIGHTMAO_GODOT_PATH || '.lightmao/tools/godot/4.7.2/Godot.app/Contents/MacOS/Godot',
  );
  async function run(args) {
    const p = spawn(godot, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout.on('data', (c) => (text += c));
    p.stderr.on('data', (c) => (text += c));
    const timer = setTimeout(() => p.kill('SIGTERM'), 30000);
    const code = await new Promise((r, reject) => {
      p.on('error', reject);
      p.on('close', r);
    });
    clearTimeout(timer);
    return { code, text };
  }
  const imported = await run(['--headless', '--path', check, '--editor', '--quit']);
  await writeFile(join(qaDir, 'godot-import.log'), imported.text);
  assert.equal(imported.code, 0, imported.text.slice(-1200));
  const playback = await run(['--headless', '--path', check, '--script', 'check.gd']);
  await writeFile(join(qaDir, 'godot-playback.log'), playback.text);
  assert.equal(playback.code, 0, playback.text.slice(-1800));
  assert.equal((playback.text.match(/ASSET_IMPORT_OK/g) || []).length, 2, playback.text);
  receipt.godot = {
    passed: true,
    verified: 'real PNG texture import, helper compilation, SpriteFrames frame count and offset',
    visualGameplayAcceptance: false,
  };
  receipt.passed = true;
} catch (e) {
  receipt.error = e.message;
  receipt.passed = false;
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await writeFile(join(qaDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      path: join(qaDir, 'receipt.json'),
      passed: receipt.passed,
      checks: receipt.checks.length,
      error: receipt.error,
      godot: receipt.godot,
    }),
  );
}

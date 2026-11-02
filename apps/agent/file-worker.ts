import {
  listFiles,
  readProjectFile,
  writeProjectFile,
  importProjectAsset,
  editProjectFile,
  projectFileDigest,
} from './sandbox.ts';
import { snapshotSkillDirectory } from './skill-snapshot.ts';
import { snapshotEngineProject } from './engine-snapshot.ts';
import { createHash } from 'node:crypto';
import { applyFileChanges, type FileChange } from './shared-file-changes.ts';
import { snapshotMediaFile } from './media-file-snapshot.ts';
import { commitGameAssetBundle, type AssetBundleFile } from './game-asset-bundle.ts';

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  try {
    const { root, operation, args } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      root: string;
      operation: string;
      args: {
        path?: string;
        content?: string;
        base64?: string;
        sha256?: string;
        mime?: string;
        offset?: number;
        limit?: number;
        line?: number;
        oldText?: string;
        newText?: string;
        expectedSha256?: string;
        changes?: FileChange[];
        outputDir?: string;
        files?: AssetBundleFile[];
      };
    };
    let value: unknown;
    if (operation === 'commit_game_asset_bundle')
      value = await commitGameAssetBundle(root, args.outputDir!, args.files!);
    else if (operation === 'snapshot_media_file') value = await snapshotMediaFile(root, args.path!);
    else if (operation === 'apply_changes') value = await applyFileChanges(root, args.changes!);
    else if (operation === 'snapshot_skill') value = await snapshotSkillDirectory(root);
    else if (operation === 'snapshot_project') value = await snapshotEngineProject(root);
    else if (operation === 'fingerprint_project')
      value = await snapshotEngineProject(root, false, false);
    else if (operation === 'snapshot_web') value = await snapshotEngineProject(root, false);
    else if (operation === 'list_files') value = await listFiles(root, args.path || '.');
    else if (operation === 'read_file') value = await readProjectFile(root, args.path!);
    else if (operation === 'hash_file') value = await projectFileDigest(root, args.path!);
    else if (operation === 'read_file_page') {
      const text = await readProjectFile(root, args.path!);
      if (
        args.line !== undefined &&
        (!Number.isInteger(args.line) || args.line < 1 || args.offset !== undefined)
      )
        throw Error('行号无效或与偏移同时提供');
      const lineOffset =
        args.line === undefined
          ? 0
          : text
              .split('\n')
              .slice(0, args.line - 1)
              .reduce((n, line) => n + line.length + 1, 0);
      const offset = args.offset ?? lineOffset,
        limit = args.limit ?? 2400;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > text.length ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 4000
      )
        throw Error('文件分页范围无效');
      const end = Math.min(text.length, offset + limit);
      value = {
        path: args.path,
        offset,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        sha256: createHash('sha256').update(text).digest('hex'),
        text: text.slice(offset, end),
      };
    } else if (operation === 'write_file')
      value = await writeProjectFile(root, args.path!, args.content!);
    else if (operation === 'edit_file')
      value = await editProjectFile(
        root,
        args.path!,
        args.oldText!,
        args.newText!,
        args.expectedSha256,
      );
    else if (operation === 'import_asset')
      value = await importProjectAsset(
        root,
        args as { path: string; base64: string; sha256: string; mime: string },
      );
    else if (operation === 'inspect_project') {
      const files = await listFiles(root);
      const names = files.map((f) => f.name);
      value = {
        engine: names.includes('project.godot')
          ? 'Godot'
          : names.includes('Assets') && names.includes('ProjectSettings')
            ? 'Unity'
            : names.some((n) => n.endsWith('.uproject'))
              ? 'Unreal'
              : names.includes('index.html')
                ? 'Web'
                : '未识别',
        files,
        verification: '静态目录检查，未执行引擎',
      };
    } else if (operation === 'asset_inventory') {
      const files = await listFiles(root);
      value = {
        files: files.some((f) => f.name === 'assets' && f.type === 'directory')
          ? await listFiles(root, 'assets')
          : [],
        summary: '仅列举文件名，不推断授权状态',
      };
    } else throw new Error('未知文件工具');
    process.stdout.write(JSON.stringify({ ok: true, value }));
  } catch (error) {
    const e = error as Error & { code?: string; statusCode?: number };
    process.stdout.write(
      JSON.stringify({ ok: false, error: e.message, code: e.code, statusCode: e.statusCode }),
    );
  }
}
void main();
